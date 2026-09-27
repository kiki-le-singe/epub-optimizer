import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Native Node TypeScript requires the source extension.
import * as releaseHelpers from "./release-helpers.ts";
const { assertDigest, assertVersion, parseRemoteTag, stableVersionAtLeast, validateRecord } =
  releaseHelpers;
import type { ImageRecord } from "./release-helpers.js";

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{ id: number; name: string }>;
  html_url: string;
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`
    );
  return result.stdout.trim();
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required.");
const image = `ghcr.io/${repo.toLowerCase()}`;
const command = process.argv[2];

function api<T>(method: string, endpoint: string, body?: unknown): T {
  return JSON.parse(
    run(
      "gh",
      [
        "api",
        "--method",
        method,
        `repos/${repo}/${endpoint}`,
        ...(body === undefined ? [] : ["--input", "-"]),
      ],
      body === undefined ? undefined : JSON.stringify(body)
    )
  ) as T;
}

function releases(): Release[] {
  return (
    JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`])
    ) as Release[][]
  ).flat();
}

function remoteTag(tag: string): string | undefined {
  const result = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8", timeout: 30_000 }
  );
  return parseRemoteTag(result.status, result.stdout);
}

function recordFor(release: Release): ImageRecord | undefined {
  const asset = release.assets.find((item) => item.name === "release-image.json");
  if (!asset) return undefined;
  return JSON.parse(
    run("gh", [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${repo}/releases/assets/${asset.id}`,
    ])
  ) as ImageRecord;
}

function output(name: string, value: string | boolean): void {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function summary(message: string): void {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

function imageManifest(reference: string): {
  digest: string;
  manifests: Array<{ digest: string }>;
} {
  return JSON.parse(
    run("docker", ["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"])
  );
}

function verifyImage(record: ImageRecord): void {
  const manifest = imageManifest(`${record.image}@${record.digest}`);
  if (manifest.digest !== record.digest) throw new Error("Registry digest mismatch.");
  const children = manifest.manifests.map((item) => item.digest).sort();
  // imagetools flattens per-architecture indexes (including attestations).
  const expected = Object.values(record.platforms)
    .flatMap((digest) =>
      imageManifest(`${record.image}@${digest}`).manifests.map((item) => item.digest)
    )
    .sort();
  if (JSON.stringify(children) !== JSON.stringify(expected))
    throw new Error("Release index differs from the tested images.");
}

function promote(reference: string, record: ImageRecord): void {
  run("docker", [
    "buildx",
    "imagetools",
    "create",
    "--tag",
    reference,
    `${record.image}@${record.digest}`,
  ]);
  if (imageManifest(reference).digest !== record.digest)
    throw new Error("Promoted image digest mismatch.");
}

function syncDevelop(sha: string): void {
  run("git", ["fetch", "origin", "main", "develop"]);
  const develop = run("git", ["rev-parse", "origin/develop"]);
  const main = run("git", ["rev-parse", "origin/main"]);
  if (spawnSync("git", ["merge-base", "--is-ancestor", sha, main]).status !== 0)
    throw new Error("Release is not an ancestor of main.");
  if (spawnSync("git", ["merge-base", "--is-ancestor", main, develop]).status === 0) {
    run("gh", ["workflow", "run", "ci.yml", "--ref", "develop", "--repo", repo!]);
    summary("develop already contains main; CI explicitly dispatched.");
    return;
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", develop, main]).status === 0) {
    const push = spawnSync("git", ["push", "origin", `${main}:refs/heads/develop`], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (push.status === 0) {
      // Pushes made with GITHUB_TOKEN do not trigger CI automatically.
      run("gh", ["workflow", "run", "ci.yml", "--ref", "develop", "--repo", repo!]);
      summary("develop fast-forwarded to main; CI explicitly dispatched.");
      return;
    }
    console.warn("Fast-forward push rejected; falling back to a synchronization PR.");
  }
  const prs = api<Array<{ html_url: string; number: number }>>(
    "GET",
    `pulls?state=open&base=develop&head=${repo!.split("/")[0]}:main`
  );
  const existing = prs[0];
  const pr =
    existing ??
    api<{ html_url: string; number: number }>("POST", "pulls", {
      title: "Sync main into develop after release",
      head: "main",
      base: "develop",
      body: "Bring the released version and release history back into develop. Resolve any merge conflicts before merging. CI must pass.",
    });
  summary(`Synchronization PR: ${pr.html_url}`);
  // A bot-created PR does not trigger pull_request workflows with GITHUB_TOKEN.
  run("gh", [
    "workflow",
    "run",
    "ci.yml",
    "--ref",
    "main",
    "--repo",
    repo!,
    "-f",
    `pull-request=${pr.number}`,
  ]);
}

async function main(): Promise<void> {
  if (command === "finalize") {
    const tag = process.env.RELEASE_TAG ?? "";
    const version = tag.replace(/^v/, "");
    assertVersion(version);
    if (tag !== `v${version}`) throw new Error("Expected a v-prefixed release tag.");
    const release = releases().find((item) => item.tag_name === tag);
    if (!release || release.draft)
      throw new Error("Publish the GitHub release before promoting Docker tags.");
    assertVersion(version, release.prerelease);
    const sha = remoteTag(tag);
    if (!sha) throw new Error("Release tag is missing.");
    const record = recordFor(release);
    if (!record)
      throw new Error("Missing tested image record; legacy releases cannot use this finalizer.");
    validateRecord(record, version, sha, image);
    verifyImage(record);
    promote(`${image}:${version}`, record);
    const newerStable = releases().some(
      (item) =>
        !item.draft &&
        !item.prerelease &&
        /^v\d+\.\d+\.\d+$/.test(item.tag_name) &&
        !stableVersionAtLeast(version.split("-")[0]!, item.tag_name.slice(1))
    );
    if (!release.prerelease && !newerStable) promote(`${image}:latest`, record);
    else summary("latest left unchanged (prerelease or a newer stable release exists).");
    summary(`Published ${image}:${version} at ${record.digest}.`);
    syncDevelop(sha);
    return;
  }

  if (process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Release preparation must run from main.");
  const version = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string })
    .version;
  const prerelease = process.env.PRERELEASE === "true";
  assertVersion(version, prerelease);
  const sha = run("git", ["rev-parse", "HEAD"]);
  const tag = `v${version}`;
  const tagSha = remoteTag(tag);
  if (tagSha && tagSha !== sha)
    throw new Error("Existing release tag points to a different commit.");
  let release = releases().find((item) => item.tag_name === tag);
  if (release && release.prerelease !== prerelease)
    throw new Error("Existing release prerelease status differs.");
  const existingRecord = release && recordFor(release);
  if (existingRecord) {
    validateRecord(existingRecord, version, sha, image);
    if (!tagSha)
      throw new Error("The recorded release tag is missing; restore it before retrying.");
  }
  if (release && !release.draft && !existingRecord)
    throw new Error("Version already published without an image record. Choose a new version.");
  if (command === "plan") {
    output("build", !existingRecord);
    output("version", version);
    if (release) summary(`Existing release: ${release.html_url}; notes will be preserved.`);
    return;
  }
  if (command !== "draft") throw new Error(`Unknown release command: ${command}`);
  if (existingRecord) {
    verifyImage(existingRecord);
    summary(`Reusing tested images and preserving notes: ${release!.html_url}`);
    return;
  }
  const platforms: Record<string, string> = {};
  for (const arch of ["amd64", "arm64"]) {
    const item = JSON.parse(fs.readFileSync(`digests/${arch}.json`, "utf8")) as {
      sha: string;
      arch: string;
      digest: string;
    };
    if (item.sha !== sha || item.arch !== arch)
      throw new Error("Tested image does not match this commit/platform.");
    assertDigest(item.digest);
    platforms[arch] = item.digest;
  }
  const candidate = `${image}:candidate-${sha}-${process.env.GITHUB_RUN_ID}-index`;
  run("docker", [
    "buildx",
    "imagetools",
    "create",
    "--tag",
    candidate,
    ...Object.values(platforms).map((digest) => `${image}@${digest}`),
  ]);
  const record: ImageRecord = {
    schema: 1,
    version,
    sha,
    image,
    digest: imageManifest(candidate).digest,
    platforms,
  };
  validateRecord(record, version, sha, image);
  verifyImage(record);
  if (!tagSha) {
    run("git", ["config", "user.name", "github-actions[bot]"]);
    run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
    run("git", ["push", "origin", tag]);
  }
  if (!release) {
    const notesFile = `release-notes/${tag}.md`;
    const notes = fs.existsSync(notesFile)
      ? fs.readFileSync(notesFile, "utf8")
      : api<{ body: string }>("POST", "releases/generate-notes", {
          tag_name: tag,
          target_commitish: sha,
        }).body;
    release = api<Release>("POST", "releases", {
      tag_name: tag,
      target_commitish: sha,
      name: `${version} (${new Date().toISOString().slice(0, 10)})`,
      body: notes,
      draft: true,
      prerelease,
    });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-release-"));
  try {
    const filename = path.join(dir, "release-image.json");
    fs.writeFileSync(filename, JSON.stringify(record, null, 2));
    run("gh", ["release", "upload", tag, filename, "--repo", repo!]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  summary(
    `Draft ready: ${release.html_url}. Publish it to promote the tested Docker images. latest is unchanged.`
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

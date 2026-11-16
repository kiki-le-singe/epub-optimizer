import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { dockerHubPlan } from "./dockerhub-plan.ts";
import type { ImageRecord } from "./release-helpers.js";

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
function raw(reference: string): string {
  return run("skopeo", ["inspect", "--raw", `docker://${reference}`]);
}
function digest(manifest: string): string {
  return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
}
function latest(): string {
  return run("gh", [
    "release",
    "view",
    "--repo",
    repo,
    "--json",
    "tagName",
    "--jq",
    ".tagName",
  ]).trim();
}
const repo = "kiki-le-singe/epub-optimizer";
if (
  process.env.GITHUB_REPOSITORY !== repo ||
  run("git", ["rev-parse", "HEAD"]).trim() !== run("git", ["rev-parse", "origin/main"]).trim()
)
  throw new Error("Run trusted Docker Hub automation from epub-optimizer main.");
const tag = process.env.RELEASE_TAG ?? "";
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected a stable release tag.");
const sha = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]).trim();
run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
const release = JSON.parse(
  run("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName,isDraft,isPrerelease"])
) as { tagName: string; isDraft: boolean; isPrerelease: boolean };
const asset = JSON.parse(run("gh", ["api", `repos/${repo}/releases/tags/${tag}`])) as {
  assets: Array<{ id: number; name: string }>;
};
const id = asset.assets.find((entry) => entry.name === "release-image.json")?.id;
if (!id) throw new Error("Published release has no tested image record.");
const record = JSON.parse(
  run("gh", [
    "api",
    "-H",
    "Accept: application/octet-stream",
    `repos/${repo}/releases/assets/${id}`,
  ])
) as ImageRecord;
const plan = dockerHubPlan(tag, sha, latest(), release, record, process.env.DOCKERHUB_IMAGE ?? "");
const source = raw(plan.source);
if (digest(source) !== plan.digest) throw new Error("Source index digest mismatch.");
const index = JSON.parse(source) as { manifests: Array<{ digest: string }> };
const expected = Object.values(record.platforms).flatMap((platform) => {
  const manifest = raw(`${record.image}@${platform}`);
  if (digest(manifest) !== platform) throw new Error("Tested platform digest mismatch.");
  return (JSON.parse(manifest) as { manifests: Array<{ digest: string }> }).manifests.map(
    (entry) => entry.digest
  );
});
if (
  JSON.stringify(index.manifests.map((entry) => entry.digest).sort()) !==
  JSON.stringify(expected.sort())
)
  throw new Error("Source index does not contain exactly the tested images and attestations.");
// A stable version may be retried, but must never be replaced with different bytes.
const destination = `docker.io/${plan.target}:${plan.version}`;
const existing = spawnSync("skopeo", ["inspect", "--raw", `docker://${destination}`], {
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (existing.status === 0) {
  if (digest(existing.stdout) !== plan.digest)
    throw new Error("Existing Docker Hub version differs; refusing overwrite.");
} else if (!/manifest unknown|name unknown/i.test(existing.stderr) || existing.error) {
  throw new Error(
    `Cannot verify existing Docker Hub version: ${existing.error?.message ?? existing.stderr}`
  );
}
for (const reference of [destination, `docker.io/${plan.target}:latest`]) {
  if (latest() !== tag || digest(raw(`${record.image}:latest`)) !== plan.digest)
    throw new Error(
      "Latest release changed or GHCR promotion is incomplete; retry after finalization."
    );
  run("skopeo", [
    "copy",
    "--all",
    "--preserve-digests",
    `docker://${plan.source}`,
    `docker://${reference}`,
  ]);
  if (digest(raw(reference)) !== plan.digest)
    throw new Error("Docker Hub digest verification failed.");
  console.log(`Verified ${reference} at ${plan.digest}`);
}
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Mirrored ${tag} to https://hub.docker.com/r/${plan.target} at ${plan.digest}, without rebuilding.\n`
  );

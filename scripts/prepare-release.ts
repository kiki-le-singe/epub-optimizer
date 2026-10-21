import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prepare a release PR, wait for its CI, then merge it through GitHub rules.
// The Release workflow then reads the version from package.json (no input).
//
//   pnpm release:prepare 3.4.0            # do it
//   pnpm release:prepare 3.4.0 --dry-run  # show the plan only

// @ts-expect-error Native Node TypeScript requires the source extension.
import { assertVersion, compareVersions, parseRemoteTag } from "./release-helpers.ts";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { api, mergeCheckedPullRequest, prepareBranch, repository, run } from "./release-pr.ts";

interface Options {
  version: string;
  dryRun: boolean;
}

function readOptions(argv: string[]): Options {
  let version: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--") {
      continue;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (version === undefined) {
      version = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!version) {
    throw new Error("Usage: prepare-release <version> [--dry-run]");
  }
  assertVersion(version);
  return { version, dryRun };
}

function git(args: string[]): string {
  return run("git", args);
}

function remoteTagExists(repoRoot: string, tag: string): boolean {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "ls-remote",
      "--exit-code",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  return parseRemoteTag(result.status, result.stdout) !== undefined;
}

/** Replaces the top-level "version" field in a package.json string. */
export function bumpVersionInPackageJson(raw: string, version: string): string {
  const bumped = raw.replace(/(\n {2}"version": ")[^"]+(")/, `$1${version}$2`);
  if (bumped === raw) {
    throw new Error("Could not find the top-level version field in package.json.");
  }
  return bumped;
}

async function main(): Promise<void> {
  const { version, dryRun } = readOptions(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tag = `v${version}`;
  const repo = repository(repoRoot);

  console.log(`Preparing release ${tag}${dryRun ? " (dry run)" : ""}...`);

  git(["-C", repoRoot, "fetch", "origin"]);

  if (remoteTagExists(repoRoot, tag)) {
    throw new Error(`Tag ${tag} already exists on origin — choose a new version.`);
  }

  const mainSha = git(["-C", repoRoot, "rev-parse", "origin/main"]);
  const developSha = git(["-C", repoRoot, "rev-parse", "origin/develop"]);
  console.log(`origin/main = ${mainSha.slice(0, 9)} | origin/develop = ${developSha.slice(0, 9)}`);
  if (process.env.EXPECTED_DEVELOP_SHA && developSha !== process.env.EXPECTED_DEVELOP_SHA) {
    throw new Error("develop changed after CI verification; retry preparation.");
  }
  const mainVersion = (
    JSON.parse(git(["-C", repoRoot, "show", "origin/main:package.json"])) as {
      version: string;
    }
  ).version;
  if (mainVersion === version) {
    if (
      spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", developSha, mainSha])
        .status !== 0
    ) {
      throw new Error(
        "main already has this version but develop has new changes. Choose a new version."
      );
    }
    console.log(
      `main is already prepared at ${version}; the Release workflow can be dispatched again.`
    );
    writeSource(mainSha);
    return;
  }
  if (compareVersions(version, mainVersion) <= 0)
    throw new Error(`Version must be newer than ${mainVersion}.`);

  const branch = `codex/release-${version}`;
  if (dryRun) {
    console.log(`Would merge the checked develop commit into ${branch}, bump to ${version},`);
    console.log("open a PR to main, wait for Required CI, then merge through GitHub rules.");
    return;
  }
  const ci = api<{ workflow_runs: Array<{ conclusion: string | null }> }>(
    repo,
    "GET",
    `actions/workflows/ci.yml/runs?branch=develop&head_sha=${developSha}&per_page=1`
  ).workflow_runs[0];
  if (ci?.conclusion !== "success")
    throw new Error("develop must have successful CI before preparation.");
  const headSha = prepareBranch({
    cwd: repoRoot,
    branch,
    base: mainSha,
    source: developSha,
    message: `Merge develop for ${version} release prep`,
    update: (worktree: string) => {
      const pkgPath = path.join(worktree, "package.json");
      const raw = fs.readFileSync(pkgPath, "utf8");
      if ((JSON.parse(raw) as { version: string }).version !== version) {
        fs.writeFileSync(pkgPath, bumpVersionInPackageJson(raw, version));
        run("git", ["commit", "-am", `Bump version to ${version}`], worktree);
      }
    },
  });
  const mergedSha = await mergeCheckedPullRequest({
    repo,
    branch,
    base: "main",
    headSha,
    baseSha: mainSha,
    title: `Prepare release ${tag}`,
    body: `Merge develop at ${developSha} and bump package.json to ${version}. Required CI must pass before merging. Publishing remains a separate action.`,
    beforeMerge: () => {
      const current = api<{ commit: { sha: string } }>(repo, "GET", "branches/develop");
      if (current.commit.sha !== developSha)
        throw new Error("develop changed during CI; retry preparation.");
    },
  });
  writeSource(mergedSha);
  console.log(
    `main is ready at ${version}. Dispatch Release from main with expected-sha=${mergedSha}.`
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function writeSource(sha: string): void {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
}

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

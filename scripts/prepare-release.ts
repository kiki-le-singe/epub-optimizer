import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One-command release prep: merge develop -> main, bump package.json, push main.
// The Release workflow then reads the version from package.json (no input).
//
//   pnpm release:prepare 3.4.0            # do it
//   pnpm release:prepare 3.4.0 --dry-run  # show the plan only

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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
  if (!SEMVER.test(version)) {
    throw new Error(`Version must be a semver like 3.4.0 (got: ${version}).`);
  }
  return { version, dryRun };
}

function git(args: string[], opts: { capture?: boolean } = {}): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = opts.capture ? `: ${(result.stderr ?? "").trim()}` : "";
    throw new Error(`git ${args.join(" ")} failed${detail}`);
  }
  return opts.capture ? (result.stdout ?? "").trim() : "";
}

function remoteTagExists(repoRoot: string, tag: string): boolean {
  return (
    spawnSync(
      "git",
      ["-C", repoRoot, "ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
      { stdio: "ignore" }
    ).status === 0
  );
}

/** Replaces the top-level "version" field in a package.json string. */
export function bumpVersionInPackageJson(raw: string, version: string): string {
  const bumped = raw.replace(/(\n {2}"version": ")[^"]+(")/, `$1${version}$2`);
  if (bumped === raw) {
    throw new Error("Could not find the top-level version field in package.json.");
  }
  return bumped;
}

function main(): void {
  const { version, dryRun } = readOptions(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tag = `v${version}`;

  console.log(`Preparing release ${tag}${dryRun ? " (dry run)" : ""}...`);

  git(["-C", repoRoot, "fetch", "origin"], { capture: true });

  if (remoteTagExists(repoRoot, tag)) {
    throw new Error(`Tag ${tag} already exists on origin — choose a new version.`);
  }

  const mainSha = git(["-C", repoRoot, "rev-parse", "origin/main"], { capture: true });
  const developSha = git(["-C", repoRoot, "rev-parse", "origin/develop"], { capture: true });
  console.log(`origin/main = ${mainSha.slice(0, 9)} | origin/develop = ${developSha.slice(0, 9)}`);

  if (dryRun) {
    console.log("\n[dry run] Would:");
    console.log(
      `  1. merge origin/develop into main ("Merge develop for ${version} release prep")`
    );
    console.log(`  2. set package.json version to ${version} ("Bump version to ${version}")`);
    console.log("  3. push origin main");
    console.log(
      `\nThen dispatch the Release workflow — no version input; it reads ${version} from package.json.`
    );
    return;
  }

  // Throwaway worktree detached on origin/main, so this works regardless of
  // which branch the primary worktree currently has checked out.
  const worktree = path.join(os.tmpdir(), `eo-release-${process.pid}`);
  git(["-C", repoRoot, "worktree", "prune"], { capture: true });
  git(["-C", repoRoot, "worktree", "add", "--detach", worktree, "origin/main"]);

  try {
    git([
      "-C",
      worktree,
      "merge",
      "--no-ff",
      "origin/develop",
      "-m",
      `Merge develop for ${version} release prep`,
    ]);

    const pkgPath = path.join(worktree, "package.json");
    fs.writeFileSync(pkgPath, bumpVersionInPackageJson(fs.readFileSync(pkgPath, "utf8"), version));

    git(["-C", worktree, "commit", "-am", `Bump version to ${version}`]);
    git(["-C", worktree, "push", "origin", "HEAD:main"]);

    console.log(`\n✅ main is ready at ${version}.`);
    console.log(
      "Next: dispatch the Release workflow (Actions → Release → Run workflow → prerelease: false)."
    );
    console.log(`It reads ${version} from package.json and creates a draft release to polish.`);
  } finally {
    spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktree], {
      stdio: "ignore",
    });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Options {
  version?: string;
  tag?: string;
  requireRef?: string;
  assertTagAbsent: boolean;
  assertRemoteTagAbsent: boolean;
}

function readOptions(argv: string[]): Options {
  const options: Options = {
    assertTagAbsent: false,
    assertRemoteTagAbsent: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    }

    switch (arg) {
      case "--version":
        if (!next) throw new Error("--version requires a value.");
        options.version = next;
        index++;
        break;
      case "--tag":
        if (!next) throw new Error("--tag requires a value.");
        options.tag = next;
        index++;
        break;
      case "--require-ref":
        if (!next) throw new Error("--require-ref requires a value.");
        options.requireRef = next;
        index++;
        break;
      case "--assert-tag-absent":
        options.assertTagAbsent = true;
        break;
      case "--assert-remote-tag-absent":
        options.assertRemoteTagAbsent = true;
        break;
      default:
        throw new Error(`Unknown release validation option: ${arg}`);
    }
  }

  return options;
}

function runGit(args: string[]): number {
  return spawnSync("git", args, { stdio: "ignore" }).status ?? 1;
}

function assertTagAbsent(tag: string): void {
  if (runGit(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]) === 0) {
    throw new Error(`Release tag already exists locally: ${tag}`);
  }
}

function assertRemoteTagAbsent(tag: string): void {
  if (runGit(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]) === 0) {
    throw new Error(`Release tag already exists on origin: ${tag}`);
  }
}

function main(): void {
  const options = readOptions(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  const packageVersion = packageJson.version;

  if (!packageVersion) {
    throw new Error("package.json does not contain a version.");
  }

  const tagVersion = options.tag?.startsWith("v") ? options.tag.slice(1) : options.tag;
  const version = options.version ?? tagVersion;

  if (!version) {
    throw new Error("Provide --version or --tag.");
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Release version must be a semver version without build metadata: ${version}`);
  }

  if (version !== packageVersion) {
    throw new Error(
      `Release version ${version} does not match package.json version ${packageVersion}.`
    );
  }

  const expectedTag = `v${version}`;
  if (options.tag && options.tag !== expectedTag) {
    throw new Error(`Release tag ${options.tag} does not match package.json tag ${expectedTag}.`);
  }

  if (options.requireRef && process.env.GITHUB_REF !== options.requireRef) {
    throw new Error(
      `Release workflow must run from ${options.requireRef}; current ref is ${process.env.GITHUB_REF ?? "(unset)"}.`
    );
  }

  if (options.assertTagAbsent) {
    assertTagAbsent(expectedTag);
  }
  if (options.assertRemoteTagAbsent) {
    assertRemoteTagAbsent(expectedTag);
  }

  console.log(`Release validation passed for ${expectedTag}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

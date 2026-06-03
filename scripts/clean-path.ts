import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target.trim() === "") {
    throw new Error("Usage: clean-path <path>");
  }

  const cwd = path.resolve(process.cwd());
  const resolvedTarget = path.resolve(cwd, target);
  const rootDir = path.parse(resolvedTarget).root;
  const homeDir = path.resolve(os.homedir());
  const allowedParents = [
    cwd,
    path.resolve(os.tmpdir()),
    path.resolve("/tmp"),
    path.resolve("/private/tmp"),
  ];

  if (resolvedTarget === rootDir) {
    throw new Error(`Refusing to remove filesystem root: ${resolvedTarget}`);
  }
  if (resolvedTarget === cwd) {
    throw new Error(`Refusing to remove current working directory: ${resolvedTarget}`);
  }
  if (homeDir !== rootDir && resolvedTarget === homeDir) {
    throw new Error(`Refusing to remove home directory: ${resolvedTarget}`);
  }
  if (!allowedParents.some((parent) => isSameOrInside(resolvedTarget, parent))) {
    throw new Error(`Refusing to remove path outside project or temp directory: ${resolvedTarget}`);
  }

  if (!(await fs.pathExists(resolvedTarget))) {
    console.log(`Nothing to clean: ${resolvedTarget}`);
    return;
  }

  await fs.remove(resolvedTarget);
  console.log(`Removed: ${resolvedTarget}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

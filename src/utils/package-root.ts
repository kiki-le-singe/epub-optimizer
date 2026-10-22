import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Find the owning package from either a source or compiled module. */
export function findPackageRoot(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("package.json not found");
    dir = parent;
  }
}

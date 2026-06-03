import fs from "fs-extra";
import path from "node:path";

async function collectFiles(
  dir: string,
  shouldInclude: (filePath: string) => boolean
): Promise<string[]> {
  if (!(await fs.pathExists(dir))) {
    return [];
  }

  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await collectFiles(fullPath, shouldInclude)));
      } else if (shouldInclude(fullPath)) {
        out.push(fullPath);
      }
    })
  );

  return out;
}

function hasExtension(filePath: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(path.extname(filePath).toLowerCase());
}

export { collectFiles, hasExtension };

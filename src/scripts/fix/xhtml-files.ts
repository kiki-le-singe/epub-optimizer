import fs from "fs-extra";
import path from "node:path";
import { collectManifestResources, getContentPath } from "../../utils/epub-utils.js";
import { collectFiles, hasExtension } from "../../utils/files.js";
import { isSameOrInside } from "../../utils/path-safety.js";

const XHTML_EXTENSIONS = new Set([".xhtml"]);

/** Discover repairable XHTML without following symbolic links. */
export async function collectRepairFiles(extractedDir: string): Promise<string[]> {
  if (!(await fs.pathExists(extractedDir))) {
    throw new Error(`Directory ${extractedDir} does not exist.`);
  }
  const root = path.resolve(extractedDir);
  const contentDir = await getContentPath(root);
  if (!(await fs.pathExists(contentDir))) {
    throw new Error(`Content directory ${contentDir} does not exist.`);
  }

  const manifestFiles = new Set(
    await collectManifestResources(root, {
      mediaTypes: new Set(["application/xhtml+xml"]),
      extensions: XHTML_EXTENSIONS,
    })
  );
  // Keep the legacy extension-based discovery, including undeclared files,
  // while finding nested chapters and manifest resources outside the OPF folder.
  // Walking from the archive root never descends into a symlinked directory.
  const candidates = await collectFiles(
    root,
    (file) =>
      manifestFiles.has(file) ||
      (isSameOrInside(file, contentDir) && hasExtension(file, XHTML_EXTENSIONS))
  );
  const files: string[] = [];
  for (const file of candidates) {
    // collectFiles can also return symlinks and special files; repair only
    // regular files reached through the archive's real directory entries.
    if ((await fs.lstat(file)).isFile()) files.push(file);
  }
  return files.sort();
}

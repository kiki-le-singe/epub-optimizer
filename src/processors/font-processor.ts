import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reportInfo, reportWarning } from "../utils/diagnostics.js";
import { collectManifestResources } from "../utils/epub-utils.js";
import { collectFontCharacters } from "./font-characters.js";
import { runFontWorker } from "./font-runner.js";
import { MAX_FONT_BYTES } from "./font-limits.js";

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const FONT_MEDIA_TYPES = new Set([
  "application/vnd.ms-opentype",
  "application/font-sfnt",
  "application/font-woff",
  "application/x-font-ttf",
  "application/x-font-opentype",
  "application/x-font-otf",
  "application/x-font-woff",
  "font/ttf",
  "font/otf",
  "font/sfnt",
  "font/woff",
  "font/woff2",
]);

class FontCandidateCleanupError extends Error {}

async function removeOwnedCandidate(
  candidate: string,
  owned?: { dev: number; ino: number }
): Promise<void> {
  try {
    if (!owned) throw new Error("Candidate ownership unavailable");
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino)
      throw new Error("Candidate ownership changed");
    await fs.unlink(candidate);
  } catch (error) {
    // An unremoved candidate must never leak into the packaged EPUB, even in non-strict mode.
    throw new FontCandidateCleanupError("Cannot safely clean up font candidate", { cause: error });
  }
}

/** Opt-in only. Any uncertainty preserves the original font rather than guessing its glyphs. */
export async function subsetFonts(
  epubDir: string,
  options: { enabled?: boolean } = {}
): Promise<void> {
  if (!options.enabled) {
    reportInfo("Font subsetting disabled; pass --fonts to enable it.");
    return;
  }
  try {
    // Standalone callers receive the same conservative protection as the main pipeline.
    try {
      await fs.lstat(path.join(epubDir, "META-INF", "encryption.xml"));
      reportInfo("Keeping fonts unchanged: encryption metadata is present.");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const files = await collectManifestResources(epubDir, {
      extensions: FONT_EXTENSIONS,
      mediaTypes: FONT_MEDIA_TYPES,
    });
    if (files.length > 16) throw new Error("Font count exceeds the 16-font budget");
    if (!files.length) {
      reportInfo("No embedded fonts to subset.");
      return;
    }
    const characters = await collectFontCharacters(epubDir);
    for (const file of files) {
      let candidate: string | undefined;
      let created = false;
      let owned: { dev: number; ino: number } | undefined;
      try {
        const originalStat = await fs.lstat(file);
        if (!originalStat.isFile() || originalStat.nlink !== 1) throw new Error("Unsafe font file");
        if (!originalStat.size || originalStat.size > MAX_FONT_BYTES) {
          reportInfo(`Keeping font ${path.basename(file)}: empty or exceeds 8 MiB.`);
          continue;
        }
        const original = await fs.readFile(file);
        const result = await runFontWorker(original, characters);
        if (!result.data || result.data.length >= original.length) {
          reportInfo(`Keeping font ${path.basename(file)}: ${result.reason ?? "no size benefit"}.`);
          continue;
        }
        candidate = path.join(path.dirname(file), `.font-${randomUUID()}.tmp`);
        const handle = await fs.open(candidate, "wx", 0o600);
        created = true;
        try {
          const stat = await handle.stat();
          owned = { dev: stat.dev, ino: stat.ino };
          await handle.writeFile(result.data);
        } finally {
          await handle.close();
        }
        const current = await fs.lstat(file);
        if (
          !current.isFile() ||
          current.dev !== originalStat.dev ||
          current.ino !== originalStat.ino ||
          !(await fs.readFile(file)).equals(original)
        )
          throw new Error("Font changed during subsetting");
        await fs.rename(candidate, file);
        candidate = undefined;
        reportInfo(
          `Subset font ${path.basename(file)}: ${original.length} → ${result.data.length} bytes.`
        );
      } catch (error) {
        reportWarning(
          `Keeping font ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        if (candidate && created) await removeOwnedCandidate(candidate, owned);
      }
    }
  } catch (error) {
    if (error instanceof FontCandidateCleanupError) throw error;
    reportWarning(
      `Font subsetting skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

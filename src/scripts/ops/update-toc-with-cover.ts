import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getCoverLabel } from "../../utils/i18n.js";
import { getContentPath, getTOCFiles } from "../../utils/epub-utils.js";
import { getLang, getTempDir, isEntryPoint, type RunOpts } from "../utils.js";
import { normalizeNCXNavigation } from "./ncx.js";
import {
  createOwnerRelativeHref,
  DEFAULT_AUTHOR_WORKFLOW_CONFIG,
  referenceTargetsFile,
  resolveAuthorWorkflowHref,
  type AuthorWorkflowConfig,
} from "../../utils/author-workflow-config.js";

/**
 * Updates EPUB3 navigation file to include cover link
 * @param navFilePath Path to the EPUB3 navigation file
 * @param coverLabel Localized cover label
 */
async function updateEPUB3Navigation(
  epubDir: string,
  navFilePath: string,
  coverFile: string,
  coverLabel: string,
  authorConfig: AuthorWorkflowConfig
): Promise<void> {
  try {
    console.log(`Adding cover to EPUB3 navigation file: ${navFilePath}`);

    const content = await fs.readFile(navFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Check if cover is already in the TOC
    const coverLink = $("a[href]").filter((_, element) =>
      referenceTargetsFile(epubDir, navFilePath, $(element).attr("href"), coverFile)
    );

    if (coverLink.length === 0) {
      // Try different TOC selectors in order of preference
      const tocSelectors = [
        'nav[epub\\:type="toc"] > ol',
        'nav[*|type="toc"] > ol',
        'nav[role="doc-toc"] > ol',
        "nav > ol",
        "ol",
      ];

      let olElement = $();
      for (const selector of tocSelectors) {
        olElement = $(selector).first();
        if (olElement.length) break;
      }

      if (olElement.length) {
        // Create new list item with cover link
        const coverItem = $(`<li class="${authorConfig.coverNavClass}"></li>`);
        const anchorElement = $(
          `<a href="${createOwnerRelativeHref(navFilePath, coverFile)}" class="${authorConfig.coverNavClass}">${coverLabel}</a>`
        );
        coverItem.append(anchorElement);

        // Add it as the first item
        olElement.prepend(coverItem);

        // Save the updated TOC
        await fs.writeFile(navFilePath, $.xml());
        console.log("Successfully added cover to EPUB3 navigation file");
      } else {
        console.log("Warning: Could not find TOC list in EPUB3 navigation file");
      }
    } else {
      console.log("Cover is already in EPUB3 navigation file");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to update EPUB3 navigation file: ${errorMessage}`);
  }
}

/**
 * Updates EPUB2 NCX file to include cover navigation point
 * @param ncxFilePath Path to the EPUB2 NCX file
 * @param coverLabel Localized cover label
 */
async function updateEPUB2NCX(
  epubDir: string,
  ncxFilePath: string,
  coverFile: string,
  coverLabel: string,
  authorConfig: AuthorWorkflowConfig
): Promise<void> {
  try {
    console.log(`Adding cover to EPUB2 NCX file: ${ncxFilePath}`);

    const content = await fs.readFile(ncxFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Check if cover is already in the NCX navMap
    const coverNavPoint = $("navPoint")
      .filter((_, element) =>
        referenceTargetsFile(
          epubDir,
          ncxFilePath,
          $(element).find("> content").attr("src"),
          coverFile
        )
      )
      .first();

    if (coverNavPoint.length === 0) {
      const navMap = $("navMap");

      if (navMap.length) {
        // Create a new navPoint for the cover
        const coverNavPoint = $(`
          <navPoint id="navpoint-${authorConfig.coverSpineId}" playOrder="1">
            <navLabel>
              <text>${coverLabel}</text>
            </navLabel>
            <content src="${createOwnerRelativeHref(ncxFilePath, coverFile)}"/>
          </navPoint>
        `);

        // Add it as the first navPoint
        navMap.prepend(coverNavPoint);

        normalizeNCXNavigation($);

        // Save the updated NCX
        await fs.writeFile(ncxFilePath, $.xml());
        console.log("Successfully added cover to EPUB2 NCX file");
      } else {
        console.log("Warning: Could not find navMap in EPUB2 NCX file");
      }
    } else {
      console.log("Cover is already in EPUB2 NCX file");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to update EPUB2 NCX file: ${errorMessage}`);
  }
}

export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();
  const coverLabel = getCoverLabel(opts.lang ?? getLang());
  const authorConfig = opts.authorConfig ?? DEFAULT_AUTHOR_WORKFLOW_CONFIG;

  console.log("Discovering TOC files from OPF manifest...");

  const tocFiles = await getTOCFiles(extractedDir);
  const contentDir = await getContentPath(extractedDir);
  const coverFile = resolveAuthorWorkflowHref(
    contentDir,
    authorConfig.coverHref,
    "author cover href"
  );

  if (!tocFiles.epub3Nav && !tocFiles.epub2Ncx) {
    console.log("No TOC files found in OPF manifest. Skipping TOC updates.");
    return;
  }

  if (tocFiles.epub3Nav) {
    await updateEPUB3Navigation(
      extractedDir,
      tocFiles.epub3Nav,
      coverFile,
      coverLabel,
      authorConfig
    );
  } else {
    console.log("No EPUB3 navigation file found");
  }

  if (tocFiles.epub2Ncx) {
    await updateEPUB2NCX(extractedDir, tocFiles.epub2Ncx, coverFile, coverLabel, authorConfig);
  } else {
    console.log("No EPUB2 NCX file found");
  }

  console.log("TOC updates completed successfully");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

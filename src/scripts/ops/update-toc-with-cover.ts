import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getCoverLabel } from "../../utils/i18n.js";
import { getTOCFiles } from "../../utils/epub-utils.js";
import { getTempDir } from "../utils.js";

/**
 * Updates EPUB3 navigation file to include cover link
 * @param navFilePath Path to the EPUB3 navigation file
 * @param coverLabel Localized cover label
 */
async function updateEPUB3Navigation(navFilePath: string, coverLabel: string): Promise<void> {
  try {
    console.log(`Adding cover to EPUB3 navigation file: ${navFilePath}`);

    const content = await fs.readFile(navFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Check if cover is already in the TOC
    const coverLink = $('a[href="cover.xhtml"]');

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
        const coverItem = $('<li class="s3"></li>');
        const anchorElement = $(`<a href="cover.xhtml" class="s3">${coverLabel}</a>`);
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
async function updateEPUB2NCX(ncxFilePath: string, coverLabel: string): Promise<void> {
  try {
    console.log(`Adding cover to EPUB2 NCX file: ${ncxFilePath}`);

    const content = await fs.readFile(ncxFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Check if cover is already in the NCX navMap
    const coverNavPoint = $(`navPoint navLabel text:contains("${coverLabel}")`).parent().parent();

    if (coverNavPoint.length === 0) {
      const navMap = $("navMap");

      if (navMap.length) {
        // Create a new navPoint for the cover
        const coverNavPoint = $(`
          <navPoint id="navpoint-cover" playOrder="1">
            <navLabel>
              <text>${coverLabel}</text>
            </navLabel>
            <content src="cover.xhtml"/>
          </navPoint>
        `);

        // Add it as the first navPoint
        navMap.prepend(coverNavPoint);

        // Update the playOrder of all subsequent navPoints
        $("navPoint").each((i, el) => {
          const navPoint = $(el);
          if (navPoint.attr("id") !== "navpoint-cover") {
            const currentOrder = parseInt(navPoint.attr("playOrder") || "1");
            navPoint.attr("playOrder", (currentOrder + 1).toString());
          }
        });

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

/**
 * Main function to update TOC files with cover link
 */
async function updateTOCWithCover(): Promise<void> {
  try {
    const extractedDir = getTempDir();
    const coverLabel = getCoverLabel();

    console.log("Discovering TOC files from OPF manifest...");

    // Dynamically discover TOC files from OPF manifest
    const tocFiles = await getTOCFiles(extractedDir);

    if (!tocFiles.epub3Nav && !tocFiles.epub2Ncx) {
      console.log("No TOC files found in OPF manifest. Skipping TOC updates.");
      return;
    }

    // Update EPUB3 navigation file if it exists
    if (tocFiles.epub3Nav) {
      await updateEPUB3Navigation(tocFiles.epub3Nav, coverLabel);
    } else {
      console.log("No EPUB3 navigation file found");
    }

    // Update EPUB2 NCX file if it exists
    if (tocFiles.epub2Ncx) {
      await updateEPUB2NCX(tocFiles.epub2Ncx, coverLabel);
    } else {
      console.log("No EPUB2 NCX file found");
    }

    console.log("TOC updates completed successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error updating TOC files: ${errorMessage}`);
    process.exit(1);
  }
}

// Run the main function
updateTOCWithCover();

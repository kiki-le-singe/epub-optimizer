import fs from "fs-extra";
import * as cheerio from "cheerio";
import path from "node:path";
import { getTOCFiles, getContentPath } from "../../utils/epub-utils.js";
import { getTempDir, isEntryPoint, type RunOpts } from "../utils.js";

/**
 * Interface for a chapter section
 */
interface Section {
  href: string;
  text: string;
}

/**
 * Interface for a chapter with its sections
 */
interface Chapter {
  href: string;
  text: string;
  sections: Section[];
}

/**
 * Extracts chapter structure with subsections from the manual Sommaire page
 * @param sommaireFilePath Path to the manual sommaire file (chapter-2.xhtml)
 * @returns Array of chapters with their subsections
 */
async function extractChapterStructure(sommaireFilePath: string): Promise<Chapter[]> {
  try {
    console.log(`Reading manual sommaire from: ${sommaireFilePath}`);

    const content = await fs.readFile(sommaireFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    const chapters: Chapter[] = [];
    let currentChapter: Chapter | null = null;

    // Parse all paragraphs in the sommaire
    $("p").each((_, elem) => {
      const $p = $(elem);
      const classes = $p.attr("class") || "";
      const $link = $p.find("a");

      if ($link.length === 0) return;

      const href = $link.attr("href") || "";
      const text = $link.text().trim();

      // p6 = main entry, p7 = subsection (indented), p8 = another level
      if (classes.includes("p6") || classes.includes("p8")) {
        // Save previous chapter if it exists
        if (currentChapter) {
          chapters.push(currentChapter);
        }

        // Start a new chapter
        currentChapter = {
          href,
          text,
          sections: [],
        };
      } else if (classes.includes("p7") && currentChapter) {
        // Add subsection to current chapter
        currentChapter.sections.push({ href, text });
      }
    });

    // Don't forget to add the last chapter
    if (currentChapter) {
      chapters.push(currentChapter);
    }

    console.log(`Found ${chapters.length} chapters with subsections`);

    // Log chapters with sections for debugging
    const chaptersWithSections = chapters.filter((ch) => ch.sections.length > 0);
    console.log(
      `Chapters with subsections: ${chaptersWithSections.map((ch) => `${ch.text} (${ch.sections.length} sections)`).join(", ")}`
    );

    return chapters;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to extract chapter structure: ${errorMessage}`);
    return [];
  }
}

/**
 * Finds a chapter's href without fragment
 * @param href Full href with possible fragment
 * @returns Base href without fragment
 */
function getBaseHref(href: string): string {
  return href.split("#")[0];
}

/**
 * Updates EPUB3 navigation file to include chapter subsections
 * @param navFilePath Path to the EPUB3 navigation file
 * @param chapters Array of chapters with subsections
 */
async function updateEPUB3NavigationWithSections(
  navFilePath: string,
  chapters: Chapter[]
): Promise<void> {
  try {
    console.log(`Adding chapter subsections to EPUB3 navigation file: ${navFilePath}`);

    const content = await fs.readFile(navFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Process each chapter that has subsections
    for (const chapter of chapters) {
      if (chapter.sections.length === 0) continue;

      const baseHref = getBaseHref(chapter.href);

      // Find the existing list item for this chapter
      // Try to match by href first, then by text content
      let $chapterLi = $(`a[href="${baseHref}"]`).parent("li");

      if ($chapterLi.length === 0) {
        // Try to match by text if href match failed
        $chapterLi = $(`li a:contains("${chapter.text.split(" - ")[0]}")`).parent("li");
      }

      if ($chapterLi.length > 0) {
        // Check if subsections already exist
        const existingOl = $chapterLi.find("> ol");

        if (existingOl.length === 0) {
          // Create a new nested <ol> for subsections
          const $nestedOl = $("<ol></ol>");

          for (const section of chapter.sections) {
            const $sectionLi = $('<li class="s4"></li>');
            const $sectionLink = $(`<a href="${section.href}" class="s4">${section.text}</a>`);
            $sectionLi.append($sectionLink);
            $nestedOl.append($sectionLi);
          }

          $chapterLi.append($nestedOl);
          console.log(`Added ${chapter.sections.length} subsections to: ${chapter.text}`);
        } else {
          console.log(`Subsections already exist for: ${chapter.text}`);
        }
      } else {
        console.log(`Warning: Could not find chapter in TOC: ${chapter.text}`);
      }
    }

    // Save the updated TOC
    await fs.writeFile(navFilePath, $.xml());
    console.log("Successfully updated EPUB3 navigation file with chapter subsections");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to update EPUB3 navigation file: ${errorMessage}`);
  }
}

/**
 * Updates EPUB2 NCX file to include chapter subsections
 * @param ncxFilePath Path to the EPUB2 NCX file
 * @param chapters Array of chapters with subsections
 */
async function updateEPUB2NCXWithSections(ncxFilePath: string, chapters: Chapter[]): Promise<void> {
  try {
    console.log(`Adding chapter subsections to EPUB2 NCX file: ${ncxFilePath}`);

    const content = await fs.readFile(ncxFilePath, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    let globalPlayOrder = 1;

    // First, find the highest playOrder to know where to start
    $("navPoint").each((_, el) => {
      const playOrder = parseInt($(el).attr("playOrder") || "1");
      if (playOrder > globalPlayOrder) {
        globalPlayOrder = playOrder;
      }
    });

    // Process each chapter that has subsections
    for (const chapter of chapters) {
      if (chapter.sections.length === 0) continue;

      const baseHref = getBaseHref(chapter.href);

      // Find the navPoint for this chapter
      let $chapterNavPoint = $(`navPoint content[src="${baseHref}"]`).parent();

      if ($chapterNavPoint.length === 0) {
        // Try to match by chapter title in text
        const chapterTitle = chapter.text.split(" - ")[0].trim();
        const matchedText = $(`navPoint navLabel text:contains("${chapterTitle}")`);
        $chapterNavPoint = matchedText.parent().parent();
      }

      if ($chapterNavPoint.length > 0) {
        // Check if subsections already exist
        const existingSubNavPoints = $chapterNavPoint.find("> navPoint");

        if (existingSubNavPoints.length === 0) {
          // Add subsections as nested navPoints
          for (let i = 0; i < chapter.sections.length; i++) {
            const section = chapter.sections[i];
            globalPlayOrder++;

            const navPointId = `${$chapterNavPoint.attr("id")}-section-${i + 1}`;
            const sectionNavPoint = $(`
              <navPoint id="${navPointId}" playOrder="${globalPlayOrder}">
                <navLabel>
                  <text>${section.text}</text>
                </navLabel>
                <content src="${section.href}"/>
              </navPoint>
            `);

            $chapterNavPoint.append(sectionNavPoint);
          }

          console.log(`Added ${chapter.sections.length} subsections to NCX: ${chapter.text}`);
        } else {
          console.log(`Subsections already exist in NCX for: ${chapter.text}`);
        }
      } else {
        console.log(`Warning: Could not find chapter in NCX: ${chapter.text}`);
      }
    }

    // Save the updated NCX
    await fs.writeFile(ncxFilePath, $.xml());
    console.log("Successfully updated EPUB2 NCX file with chapter subsections");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to update EPUB2 NCX file: ${errorMessage}`);
  }
}

/**
 * Main function to add chapter sections to TOC files
 */
export async function run(opts: RunOpts = {}): Promise<void> {
  const extractedDir = opts.tempDir ?? getTempDir();

  console.log("Discovering TOC files and content directory...");

  const contentPath = await getContentPath(extractedDir);
  const tocFiles = await getTOCFiles(extractedDir);

  if (!tocFiles.epub3Nav && !tocFiles.epub2Ncx) {
    console.log("No TOC files found. Skipping chapter section updates.");
    return;
  }

  const sommaireFilePath = path.join(contentPath, "chapter-2.xhtml");

  if (!(await fs.pathExists(sommaireFilePath))) {
    console.log(`Manual sommaire file not found at: ${sommaireFilePath}`);
    console.log("Skipping chapter section updates.");
    return;
  }

  const chapters = await extractChapterStructure(sommaireFilePath);
  if (chapters.length === 0) {
    console.log("No chapters found in manual sommaire. Skipping updates.");
    return;
  }

  const chaptersWithSections = chapters.filter((ch) => ch.sections.length > 0);
  if (chaptersWithSections.length === 0) {
    console.log("No chapters with subsections found. Skipping updates.");
    return;
  }

  if (tocFiles.epub3Nav) {
    await updateEPUB3NavigationWithSections(tocFiles.epub3Nav, chaptersWithSections);
  } else {
    console.log("No EPUB3 navigation file found");
  }

  if (tocFiles.epub2Ncx) {
    await updateEPUB2NCXWithSections(tocFiles.epub2Ncx, chaptersWithSections);
  } else {
    console.log("No EPUB2 NCX file found");
  }

  console.log("Chapter section updates completed successfully");
}

if (isEntryPoint(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import fs from "fs-extra";
import * as cheerio from "cheerio";
import { getOPFPath } from "../../utils/epub-utils.js";
import { getTempDir } from "../utils.js";

async function addCoverImageProperty() {
  try {
    // Define paths clearly
    const extractedDir = getTempDir();

    // Get the OPF file path from container.xml
    const opfFile = await getOPFPath(extractedDir);

    console.log(`Adding properties="cover-image" to cover-image item in: ${opfFile}`);

    // Read and parse OPF file
    const content = fs.readFileSync(opfFile, "utf8");
    const $ = cheerio.load(content, { xmlMode: true });

    // Find and update cover image item
    const coverImageItem = $('item[id="cover-image"]');

    if (coverImageItem.length) {
      coverImageItem.attr("properties", "cover-image");
      fs.writeFileSync(opfFile, $.xml());
      console.log('Added properties="cover-image" to cover image');
    } else {
      console.log("Warning: Could not find cover-image item in OPF");
    }
  } catch (error: unknown) {
    // Properly handle unknown error type
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error processing OPF file: ${errorMessage}`);
    process.exit(1);
  }
}

// Run the function
addCoverImageProperty();

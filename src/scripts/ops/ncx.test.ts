import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { normalizeNCXNavigation } from "./ncx.js";

describe("normalizeNCXNavigation", () => {
  it("renumbers nested navigation points in document order and updates depth", () => {
    const $ = cheerio.load(
      `<?xml version="1.0"?>
      <ncx>
        <head><meta name="dtb:depth" content="1"/></head>
        <navMap>
          <navPoint playOrder="1">
            <navPoint playOrder="4"/>
            <navPoint playOrder="5"/>
          </navPoint>
          <navPoint playOrder="2"/>
          <navPoint playOrder="3"/>
        </navMap>
      </ncx>`,
      { xmlMode: true }
    );

    normalizeNCXNavigation($);

    expect(
      $("navMap navPoint")
        .map((_, element) => $(element).attr("playOrder"))
        .get()
    ).toEqual(["1", "2", "3", "4", "5"]);
    expect($('meta[name="dtb:depth"]').attr("content")).toBe("2");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { assertNoInternalDtdSubsets } from "./xml-dtd.js";

describe("internal DTD preflight", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-dtd-test-"));
  });
  afterEach(async () => {
    await fs.remove(root);
  });
  const declaration = '<!DOCTYPE html [<!ENTITY copy "Éditions Exemple">]>';
  async function check(content: string | Buffer, name = "Text/chapter.content") {
    await fs.outputFile(path.join(root, name), content);
    return assertNoInternalDtdSubsets(root);
  }

  it.each([
    declaration + "<html><body>&copy;</body></html>",
    '<?xml version="1.0"?>\n' + declaration + "<html/>",
    "\ufeff<!-- editor --><?producer data?>\n" + declaration + "<html/>",
    '<!DOCTYPE html [<!ENTITY % setup "anything">%setup;]><html/>',
    '<!DOCTYPE html [<!ENTITY outside SYSTEM "file:///not-read">]><html/>',
    "<!DOCTYPE html []><html/>",
    "<!DOCTYPE html [<!-- no entities, still unsupported -->]><html/>",
    '<!DOCTYPE html [<!ATTLIST p title CDATA "default">]><html/>',
  ])("refuses an internal subset before interpreting it: %s", async (content) => {
    await expect(check(content)).rejects.toThrow(/Internal DTD.*Text\/chapter.content/);
    expect(await fs.readFile(path.join(root, "Text/chapter.content"), "utf8")).toBe(content);
  });

  it.each([
    "<!DOCTYPE html><html/>",
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>',
    '<!DOCTYPE html SYSTEM "example[brackets].dtd"><html/>',
    '<?producer value="<!DOCTYPE html ["?><html/>',
    '<!-- <!DOCTYPE html [<!ENTITY copy "test">]> --><html/>',
    '<html title="&lt;!DOCTYPE html ["><script><![CDATA[const s = "<!DOCTYPE html [";]]></script><style>/* <!DOCTYPE html [ */</style></html>',
    "/* stylesheet containing <!DOCTYPE html [ */",
    "",
    "<",
  ])("accepts ordinary doctypes and inert lookalikes: %s", async (content) => {
    await expect(check(content)).resolves.toBeUndefined();
  });

  it.each([
    "book.opf",
    "META-INF/container.xml",
    "Images/art.svg",
    "Text/ch.XHTML",
    "unknown.data",
  ])("checks regular resources regardless of their path: %s", async (name) => {
    await expect(check(declaration + "<html/>", name)).rejects.toThrow("Internal DTD");
  });

  it.each(["utf8", "utf16le", "utf16be"])(
    "detects the prolog in %s documents",
    async (encoding) => {
      let bytes = Buffer.from(
        '\ufeff<?xml version="1.0"?>' + declaration + "<html/>",
        encoding === "utf8" ? "utf8" : "utf16le"
      );
      if (encoding === "utf16be") bytes = bytes.swap16();
      await expect(check(bytes)).rejects.toThrow("Internal DTD");
    }
  );

  it.each([1, 4, 8, 9])(
    "recognizes a doctype split %s bytes before a stream boundary",
    async (split) => {
      await expect(check(" ".repeat(16 * 1024 - split) + declaration + "<html/>")).rejects.toThrow(
        "Internal DTD"
      );
    }
  );

  it("skips long prolog comments and quoted identifiers across chunk boundaries", async () => {
    const comments = "<!--" + " ".repeat(64 * 1024) + "<!DOCTYPE html [ -->";
    await expect(check(comments + declaration + "<html/>")).rejects.toThrow("Internal DTD");
    await fs.remove(path.join(root, "Text/chapter.content"));
    const ordinary = '<!DOCTYPE html SYSTEM "' + "a".repeat(32 * 1024) + '[quoted].dtd"><html/>';
    await expect(check(ordinary)).resolves.toBeUndefined();
  });

  it("does not follow symlinks or treat binary content as an XML prolog", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "epub-dtd-outside-"));
    try {
      await fs.outputFile(path.join(outside, "chapter.xhtml"), declaration + "<html/>");
      await fs.symlink(path.join(outside, "chapter.xhtml"), path.join(root, "linked.xhtml"));
      await fs.symlink(outside, path.join(root, "linked-directory"), "dir");
      await fs.writeFile(
        path.join(root, "picture.png"),
        Buffer.from("\x89PNG\r\n<!DOCTYPE html [")
      );
      await expect(assertNoInternalDtdSubsets(root)).resolves.toBeUndefined();
    } finally {
      await fs.remove(outside);
    }
  });
});

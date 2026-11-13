import fs from "fs-extra";
import path from "node:path";

/** Original generated fonts only; no user EPUB or system font is used in CI. */
export async function createFontFixture(root: string): Promise<void> {
  await fs.outputFile(path.join(root, "mimetype"), "application/epub+zip");
  await fs.outputFile(
    path.join(root, "META-INF/container.xml"),
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  );
  await fs.outputFile(
    path.join(root, "OPS/book.opf"),
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:123e4567-e89b-12d3-a456-426614174000</dc:identifier><dc:title>Generated font fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="chapter" href="nested/ch.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="font" href="Fonts/fixture.ttf" media-type="font/ttf"/><item id="css" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>'
  );
  await fs.outputFile(
    path.join(root, "OPS/nested/ch.xhtml"),
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title><link rel="stylesheet" type="text/css" href="../style.css"/></head><body><h1>Chapter</h1><p>AV office fi ffi é ά سلام क्ष 中文</p></body></html>'
  );
  await fs.outputFile(
    path.join(root, "OPS/nav.xhtml"),
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="nested/ch.xhtml">Chapter</a></li></ol></nav></body></html>'
  );
  await fs.outputFile(
    path.join(root, "OPS/style.css"),
    '@font-face{font-family:fixture;src:url("Fonts/fixture.ttf")}body{font-family:fixture}'
  );
  await fs.ensureDir(path.join(root, "OPS/Fonts"));
  await fs.copyFile(
    new URL("./fixtures/fonts/fixture.ttf", import.meta.url),
    path.join(root, "OPS/Fonts/fixture.ttf")
  );
}

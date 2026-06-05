import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { detectEpubFeatures } from "./epub-features.js";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function opf(metadataExtra = "", spineExtra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test</dc:title>
    ${metadataExtra}
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"${spineExtra}/>
  </spine>
</package>`;
}

const createdDirs: string[] = [];

async function makeEpub(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-features-"));
  createdDirs.push(root);
  const all = { "META-INF/container.xml": CONTAINER, "OEBPS/content.opf": opf(), ...files };
  for (const [rel, content] of Object.entries(all)) {
    const full = path.join(root, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("detectEpubFeatures — encryption", () => {
  it("reports none when there is no encryption.xml", async () => {
    const dir = await makeEpub({});
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("none");
    expect(features.encryptedHrefs).toEqual([]);
  });

  it("classifies IDPF font obfuscation as obfuscation (with namespace prefixes)", async () => {
    const encryption = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData>
      <enc:CipherReference URI="OEBPS/fonts/font.otf"/>
    </enc:CipherData>
  </enc:EncryptedData>
</encryption>`;
    const dir = await makeEpub({ "META-INF/encryption.xml": encryption });
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("obfuscation");
    expect(features.encryptedHrefs).toContain("OEBPS/fonts/font.otf");
  });

  it("treats font-only encryption as obfuscation even with an unknown algorithm", async () => {
    const encryption = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://example.com/proprietary-font-scheme"/>
    <enc:CipherData>
      <enc:CipherReference URI="OEBPS/fonts/Embedded.ttf"/>
    </enc:CipherData>
  </enc:EncryptedData>
</encryption>`;
    const dir = await makeEpub({ "META-INF/encryption.xml": encryption });
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("obfuscation");
  });

  it("classifies real content encryption as drm", async () => {
    const encryption = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
    <CipherData><CipherReference URI="OEBPS/c1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>`;
    const dir = await makeEpub({ "META-INF/encryption.xml": encryption });
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("drm");
  });

  it("treats an encryption.xml with no recognizable algorithm as drm (conservative)", async () => {
    const encryption = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></encryption>`;
    const dir = await makeEpub({ "META-INF/encryption.xml": encryption });
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("drm");
  });

  it("flags mixed obfuscation + real encryption as drm", async () => {
    const encryption = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
            xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/font.otf"/></enc:CipherData>
  </enc:EncryptedData>
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`;
    const dir = await makeEpub({ "META-INF/encryption.xml": encryption });
    const features = await detectEpubFeatures(dir);
    expect(features.encryptionKind).toBe("drm");
  });
});

describe("detectEpubFeatures — fixed layout", () => {
  it("is false for a reflowable package", async () => {
    const dir = await makeEpub({});
    const features = await detectEpubFeatures(dir);
    expect(features.fixedLayout).toBe(false);
  });

  it("detects a global pre-paginated rendition", async () => {
    const dir = await makeEpub({
      "OEBPS/content.opf": opf(`<meta property="rendition:layout">pre-paginated</meta>`),
    });
    const features = await detectEpubFeatures(dir);
    expect(features.fixedLayout).toBe(true);
  });

  it("detects a per-spine pre-paginated override", async () => {
    const dir = await makeEpub({
      "OEBPS/content.opf": opf("", ` properties="rendition:layout-pre-paginated"`),
    });
    const features = await detectEpubFeatures(dir);
    expect(features.fixedLayout).toBe(true);
  });
});

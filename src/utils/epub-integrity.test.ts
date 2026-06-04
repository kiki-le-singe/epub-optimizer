import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  assertEpubContentIntegrity,
  collectEpubContentMetrics,
  compareEpubContentMetrics,
} from "./epub-integrity.js";

const tempDirs: string[] = [];

async function createFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-integrity-"));
  tempDirs.push(root);
  await fs.ensureDir(path.join(root, "META-INF"));
  await fs.ensureDir(path.join(root, "OPS", "images"));
  await fs.writeFile(
    path.join(root, "META-INF", "container.xml"),
    `<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "content.opf"),
    `<package><manifest>
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
      <item id="image" href="images/photo.jpg" media-type="image/jpeg"/>
    </manifest><spine><itemref idref="chapter"/></spine></package>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "nav.xhtml"),
    `<html><body><nav><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>`
  );
  await fs.writeFile(
    path.join(root, "OPS", "chapter.xhtml"),
    `<html><body><img src="images/photo.jpg"/></body></html>`
  );
  await fs.writeFile(path.join(root, "OPS", "images", "photo.jpg"), "image");
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe("EPUB content integrity", () => {
  it("collects package, navigation, and reference metrics", async () => {
    const root = await createFixture();
    const metrics = await collectEpubContentMetrics(root);

    expect(metrics).toMatchObject({
      manifestItems: 3,
      spineItems: 1,
      contentDocuments: 2,
      images: 1,
      navigationEntries: 1,
      missingReferences: 0,
    });
    expect(metrics.internalReferences).toBeGreaterThanOrEqual(5);
  });

  it("rejects newly missing resources and decreased content counts", async () => {
    const root = await createFixture();
    const before = await collectEpubContentMetrics(root);
    await fs.remove(path.join(root, "OPS", "images", "photo.jpg"));
    const opfPath = path.join(root, "OPS", "content.opf");
    await fs.writeFile(
      opfPath,
      (await fs.readFile(opfPath, "utf8")).replace(
        '<item id="image" href="images/photo.jpg" media-type="image/jpeg"/>',
        ""
      )
    );
    const after = await collectEpubContentMetrics(root);
    const comparison = compareEpubContentMetrics(before, after);

    expect(comparison.valid).toBe(false);
    expect(comparison.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("manifestItems decreased"),
        expect.stringContaining("images decreased"),
        expect.stringContaining("New missing internal reference"),
      ])
    );
    expect(() => assertEpubContentIntegrity(comparison)).toThrow(
      "Content integrity validation failed"
    );
  });

  it("does not fail for broken references that already existed in the input", async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, "OPS", "chapter.xhtml"),
      `<html><body><img src="images/missing.jpg"/></body></html>`
    );
    const before = await collectEpubContentMetrics(root);
    const after = await collectEpubContentMetrics(root);

    expect(compareEpubContentMetrics(before, after)).toMatchObject({
      valid: true,
      newMissingReferences: [],
    });
  });

  it("understands XML-encoded quotes around inline CSS URLs", async () => {
    const root = await createFixture();
    await fs.writeFile(
      path.join(root, "OPS", "chapter.xhtml"),
      `<html><body><div style="background:url(&apos;images/photo.jpg#hero&apos;)"/></body></html>`
    );

    await expect(collectEpubContentMetrics(root)).resolves.toMatchObject({
      missingReferences: 0,
    });
  });
});

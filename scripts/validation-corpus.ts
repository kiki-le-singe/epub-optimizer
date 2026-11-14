import fs from "fs-extra";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import unzipper from "unzipper";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { createFontFixture } from "./font-fixtures.ts";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { createEpub } from "./e2e-epubcheck.ts";

/** Generated fixtures only. Structural checks are not visual rendering certification. */
export async function runValidationCorpus(
  runDir: string,
  cli: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const root = path.join(runDir, "corpus");
  const fixed = path.join(root, "fixed-source");
  await createFontFixture(fixed);
  const opf = path.join(fixed, "OPS/book.opf"),
    chapter = path.join(fixed, "OPS/nested/ch.xhtml");
  await fs.writeFile(
    opf,
    (await fs.readFile(opf, "utf8"))
      .replace("</metadata>", '<meta property="rendition:layout">pre-paginated</meta></metadata>')
      .replace(
        "</manifest>",
        '<item id="page" href="images/page.png" media-type="image/png"/></manifest>'
      )
  );
  await fs.writeFile(
    chapter,
    (await fs.readFile(chapter, "utf8"))
      .replace("</head>", '<meta name="viewport" content="width=2200,height=1100"/></head>')
      .replace(
        "</body>",
        '<img src="../images/page.png" alt="Generated page illustration"/></body>'
      )
  );
  await fs.ensureDir(path.join(fixed, "OPS/images"));
  const pixels = await sharp({
    create: { width: 2200, height: 1100, channels: 3, background: "#689ac4" },
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(fixed, "OPS/images/page.png"), pixels);
  const fixedInput = path.join(root, "fixed.epub");
  await createEpub(fixedInput, fixed);
  const dtd = path.join(root, "dtd-source");
  await fs.copy(fixed, dtd);
  const dtdChapter = path.join(dtd, "OPS/nested/ch.xhtml");
  await fs.writeFile(
    dtdChapter,
    (await fs.readFile(dtdChapter, "utf8"))
      .replace("?>", '?><!DOCTYPE html [<!ENTITY phrase "Preserve this text">]>')
      .replace("<h1>", "<h1>&phrase; ")
  );
  const dtdInput = path.join(root, "internal-dtd.epub");
  await createEpub(dtdInput, dtd);
  const cases = [
    { name: "fixed-balanced", input: fixedInput, flags: ["--preset", "balanced"], success: true },
    {
      name: "fixed-lossless",
      input: fixedInput,
      flags: ["--preset", "lossless", "--strict"],
      success: true,
    },
    {
      name: "fixed-strict-warning",
      input: fixedInput,
      flags: ["--preset", "balanced", "--strict"],
      success: false,
    },
    {
      name: "internal-dtd-refusal",
      input: dtdInput,
      flags: ["--preset", "lossless"],
      success: false,
    },
  ];
  const summary = [];
  for (const item of cases) {
    const output = path.join(root, item.name + ".epub"),
      reportPath = path.join(root, item.name + ".json");
    const originalInput = await fs.readFile(item.input);
    if (!item.success) await fs.writeFile(output, "previous validated output placeholder");
    const result = spawnSync(
      process.execPath,
      [cli, "-i", item.input, "-o", output, "--clean", "--report-json", reportPath, ...item.flags],
      { env, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 }
    );
    if (result.error || (item.success ? result.status !== 0 : result.status !== 1))
      throw new Error(
        `Corpus ${item.name}: unexpected exit ${result.status}\n${result.stderr}\n${result.stdout}`
      );
    const report = await fs.readJson(reportPath);
    if (report.success !== item.success)
      throw new Error(`Corpus ${item.name}: incorrect report result`);
    if (!(await fs.readFile(item.input)).equals(originalInput))
      throw new Error(`Corpus ${item.name}: source changed`);
    if (item.success) {
      if (
        !report.content?.integrity?.valid ||
        report.validation?.exitCode !== 0 ||
        report.validation?.totals?.errors !== 0 ||
        report.validation?.totals?.warnings !== 0
      )
        throw new Error(`Corpus ${item.name}: validation or integrity failed`);
      const archive = await unzipper.Open.file(output);
      const image = archive.files.find((f) => /^OPS\/images\/page\.(png|jpg)$/.test(f.path));
      if (!image) throw new Error("Fixed-layout image disappeared");
      const bytes = await image.buffer(),
        metadata = await sharp(bytes).metadata();
      if (metadata.width !== 2200 || metadata.height !== 1100)
        throw new Error("Fixed-layout image was resized");
      if (item.name === "fixed-lossless" && !bytes.equals(pixels))
        throw new Error("Lossless image bytes changed");
      const font = archive.files.find((f) => f.path === "OPS/Fonts/fixture.ttf");
      if (
        !font ||
        !(await font.buffer()).equals(await fs.readFile(path.join(fixed, "OPS/Fonts/fixture.ttf")))
      )
        throw new Error("Default font bytes changed");
    } else {
      if ((await fs.readFile(output, "utf8")) !== "previous validated output placeholder")
        throw new Error(`Corpus ${item.name}: replaced existing output`);
      const reason =
        item.name === "internal-dtd-refusal" ? /DTD|internal subset/i : /warning|fixed.layout/i;
      if (!reason.test(String(report.error)))
        throw new Error(`Corpus ${item.name}: wrong rejection reason`);
    }
    summary.push({
      name: item.name,
      expectedSuccess: item.success,
      exitCode: result.status,
      validation: report.validation,
      integrity: report.content?.integrity?.valid,
      originalPreserved: true,
      sizes: report.sizes,
    });
  }
  await fs.writeJson(
    path.join(root, "corpus-summary.json"),
    {
      scope: "Generated fixtures; visual reading-system validation remains manual",
      cases: summary,
    },
    { spaces: 2 }
  );
  console.log(
    "Validation corpus passed: fixed-layout geometry, lossless bytes, font defaults, strict warning and DTD refusals preserve existing output."
  );
}

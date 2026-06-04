import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import unzipper from "unzipper";
import yazl from "yazl";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pipelinePath = path.join(repoRoot, "dist", "src", "pipeline.js");
const epubcheckPath = path.join(repoRoot, "epubcheck", "epubcheck.jar");

async function createOpaquePng(): Promise<Buffer> {
  const width = 1024;
  const height = 1024;
  const pixels = Buffer.alloc(width * height * 3);

  for (let i = 0; i < pixels.length; i += 3) {
    const n = i / 3;
    const x = n % width;
    const y = Math.floor(n / width);
    pixels[i] = (x * 17 + y * 3) % 256;
    pixels[i + 1] = (x * 5 + y * 19) % 256;
    pixels[i + 2] = (x * 11 + y * 7) % 256;
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

async function createFixtureEpubStructure(root: string): Promise<void> {
  const oebps = path.join(root, "OEBPS");
  await fs.ensureDir(path.join(root, "META-INF"));
  await fs.ensureDir(path.join(oebps, "chapters"));
  await fs.ensureDir(path.join(oebps, "images"));
  await fs.ensureDir(path.join(oebps, "styles"));

  await fs.writeFile(path.join(root, "mimetype"), "application/epub+zip");
  await fs.writeFile(
    path.join(root, "META-INF", "container.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
  );

  await fs.writeFile(
    path.join(oebps, "content.opf"),
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:123e4567-e89b-12d3-a456-426614174000</dc:identifier>
    <dc:title>EPUB Optimizer E2E Fixture</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-06-03T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-1" href="chapters/chapter-1.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
    <item id="styles" href="styles/book.css" media-type="text/css"/>
    <item id="photo" href="images/photo.png" media-type="image/png" properties="cover-image"/>
    <item id="diagram" href="images/diagram.svg" media-type="image/svg+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="chapter-1"/>
  </spine>
</package>
`
  );

  await fs.writeFile(
    path.join(oebps, "nav.xhtml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
        <li><a href="cover.xhtml">Cover</a></li>
        <li><a href="chapters/chapter-1.xhtml">Chapter 1</a></li>
      </ol>
    </nav>
  </body>
</html>
`
  );

  await fs.writeFile(
    path.join(oebps, "cover.xhtml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Cover</title></head>
  <body>
    <figure><img src="images/photo.png" alt="Cover image"/></figure>
  </body>
</html>
`
  );

  await fs.writeFile(
    path.join(oebps, "chapters", "chapter-1.xhtml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Chapter 1</title>
    <link rel="stylesheet" type="text/css" href="../styles/book.css"/>
  </head>
  <body>
    <section epub:type="chapter">
      <h1>Chapter 1</h1>
      <p class="hero">Nested XHTML image references should migrate safely.</p>
      <script>console.log("generic scripted content is preserved");</script>
      <img src="../images/photo.png" srcset="../images/photo.png 1x, ../images/photo.png 2x" alt="Nested photo"/>
      <div style="background-image: url('../images/photo.png#inline')">Inline style reference</div>
      <img src="../images/diagram.svg" alt="SVG wrapper"/>
    </section>
  </body>
</html>
`
  );

  await fs.writeFile(
    path.join(oebps, "styles", "book.css"),
    `.hero {
  background-image: url("../images/photo.png#hero");
}
.poster {
  background-image: image-set("../images/photo.png" 1x, url("../images/photo.png") 2x);
}
`
  );

  await fs.writeFile(
    path.join(oebps, "images", "diagram.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="300" viewBox="0 0 400 300">
  <image href="photo.png" xlink:href="photo.png" width="400" height="300"/>
</svg>
`
  );

  await fs.writeFile(path.join(oebps, "images", "photo.png"), await createOpaquePng());
}

async function addDirectoryRecursive(
  zipFile: yazl.ZipFile,
  sourceDir: string,
  zipPath = ""
): Promise<void> {
  const entries = await fs.readdir(sourceDir);

  for (const entry of entries) {
    if (entry === "mimetype") continue;

    const fullPath = path.join(sourceDir, entry);
    const entryZipPath = zipPath ? `${zipPath}/${entry}` : entry;
    const stats = await fs.stat(fullPath);

    if (stats.isDirectory()) {
      await addDirectoryRecursive(zipFile, fullPath, entryZipPath);
    } else {
      zipFile.addFile(fullPath, entryZipPath, {
        compress: true,
        compressionLevel: 9,
      });
    }
  }
}

async function createEpub(outputPath: string, sourceDir: string): Promise<void> {
  const zipFile = new yazl.ZipFile();
  zipFile.addFile(path.join(sourceDir, "mimetype"), "mimetype", {
    compress: false,
    forceZip64Format: false,
  });
  await addDirectoryRecursive(zipFile, sourceDir);

  await new Promise<void>((resolve, reject) => {
    zipFile.outputStream
      .pipe(fs.createWriteStream(outputPath))
      .on("close", resolve)
      .on("error", reject);
    zipFile.end();
  });
}

async function extractEpub(epubPath: string, outputDir: string): Promise<void> {
  await fs.ensureDir(outputDir);
  await createReadStream(epubPath)
    .pipe(unzipper.Extract({ path: outputDir }))
    .promise();
}

function withJavaFallback(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const homebrewJavaBin = "/opt/homebrew/opt/openjdk/bin";
  if (fs.existsSync(path.join(homebrewJavaBin, "java"))) {
    return {
      ...env,
      PATH: `${homebrewJavaBin}${path.delimiter}${env.PATH ?? ""}`,
    };
  }
  return env;
}

function assertPrerequisites(env: NodeJS.ProcessEnv): void {
  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`Compiled pipeline not found at ${pipelinePath}. Run pnpm build first.`);
  }

  if (!fs.existsSync(epubcheckPath)) {
    throw new Error(
      `EPUBCheck not found at ${epubcheckPath}. Install it locally or use the Docker workflow.`
    );
  }

  const javaCheck = spawnSync("java", ["-version"], { env, stdio: "ignore" });
  if (javaCheck.status !== 0) {
    throw new Error("Java runtime not found. Install Java or add it to PATH before running E2E.");
  }
}

async function assertOptimizedOutput(outputEpub: string, tempDir: string): Promise<void> {
  const inspectedDir = path.join(tempDir, "inspect");
  await extractEpub(outputEpub, inspectedDir);

  const contentDir = path.join(inspectedDir, "OEBPS");
  const photoPng = path.join(contentDir, "images", "photo.png");
  const photoJpg = path.join(contentDir, "images", "photo.jpg");

  if (await fs.pathExists(photoPng)) {
    throw new Error("Expected original photo.png to be removed after safe conversion.");
  }
  if (!(await fs.pathExists(photoJpg))) {
    throw new Error("Expected converted photo.jpg to exist in optimized EPUB.");
  }

  const filesToInspect = [
    path.join(contentDir, "content.opf"),
    path.join(contentDir, "cover.xhtml"),
    path.join(contentDir, "chapters", "chapter-1.xhtml"),
    path.join(contentDir, "styles", "book.css"),
    path.join(contentDir, "images", "diagram.svg"),
  ];

  for (const filePath of filesToInspect) {
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("photo.png")) {
      throw new Error(`Expected all photo.png references to be rewritten in ${filePath}.`);
    }
  }

  const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
  if (!opf.includes('href="images/photo.jpg"') || !opf.includes('media-type="image/jpeg"')) {
    throw new Error("Expected OPF manifest to point to image/jpeg photo.jpg.");
  }

  const chapter = await fs.readFile(path.join(contentDir, "chapters", "chapter-1.xhtml"), "utf8");
  if (!chapter.includes("<script")) {
    throw new Error("Expected generic optimization to preserve valid scripted EPUB content.");
  }
}

async function assertLosslessOutput(outputEpub: string, tempDir: string): Promise<void> {
  const inspectedDir = path.join(tempDir, "inspect-lossless");
  await extractEpub(outputEpub, inspectedDir);

  const contentDir = path.join(inspectedDir, "OEBPS");
  if (!(await fs.pathExists(path.join(contentDir, "images", "photo.png")))) {
    throw new Error("Expected lossless preset to preserve photo.png.");
  }
  if (await fs.pathExists(path.join(contentDir, "images", "photo.jpg"))) {
    throw new Error("Expected lossless preset not to create photo.jpg.");
  }

  const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
  if (!opf.includes('href="images/photo.png"') || !opf.includes('media-type="image/png"')) {
    throw new Error("Expected lossless preset to preserve the PNG manifest entry.");
  }
}

async function assertAuthorOutput(outputEpub: string, tempDir: string): Promise<void> {
  const inspectedDir = path.join(tempDir, "inspect-author");
  await extractEpub(outputEpub, inspectedDir);

  const contentDir = path.join(inspectedDir, "OEBPS");
  const chapter = await fs.readFile(path.join(contentDir, "chapters", "chapter-1.xhtml"), "utf8");
  if (!chapter.includes('loading="lazy"')) {
    throw new Error("Expected author preset to enable lazy loading.");
  }

  const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
  if (!opf.includes('idref="cover" linear="yes"')) {
    throw new Error("Expected author preset to apply the cover structure update.");
  }
}

interface E2ERunResult {
  outputEpub: string;
  report: {
    preset?: string;
    strict?: boolean;
    success?: boolean;
    steps?: Array<{ name?: string; status?: string }>;
  };
}

async function runPipelineCase(
  runDir: string,
  inputEpub: string,
  name: string,
  extraArgs: string[] = []
): Promise<E2ERunResult> {
  const outputEpub = path.join(runDir, `${name}.epub`);
  const extractDir = path.join(runDir, `extract-${name}`);
  const reportPath = path.join(runDir, `report-${name}.json`);
  const result = spawnSync(
    process.execPath,
    [
      pipelinePath,
      "-i",
      inputEpub,
      "-o",
      outputEpub,
      "--temp",
      extractDir,
      "--report-json",
      reportPath,
      "--clean",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      env: withJavaFallback(process.env),
      stdio: "inherit",
    }
  );

  if (result.status !== 0) {
    throw new Error(`${name} pipeline E2E failed with exit ${result.status ?? "unknown"}.`);
  }
  if (!(await fs.pathExists(outputEpub))) {
    throw new Error(`Expected ${name} optimized EPUB output to exist.`);
  }
  if (await fs.pathExists(extractDir)) {
    throw new Error(`Expected ${name} --clean to remove the extraction temp directory.`);
  }

  const report = (await fs.readJson(reportPath)) as E2ERunResult["report"];
  if (report.success !== true) {
    throw new Error(`Expected ${name} JSON pipeline report to record a successful run.`);
  }

  return { outputEpub, report };
}

async function main(): Promise<void> {
  const env = withJavaFallback(process.env);
  assertPrerequisites(env);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-optimizer-e2e-"));
  const fixtureDir = path.join(runDir, "fixture");
  const inputEpub = path.join(runDir, "input.epub");

  try {
    await createFixtureEpubStructure(fixtureDir);
    await createEpub(inputEpub, fixtureDir);

    const balanced = await runPipelineCase(runDir, inputEpub, "balanced");
    if (balanced.report.preset !== "balanced") {
      throw new Error("Expected default E2E report to use the balanced preset.");
    }
    await assertOptimizedOutput(balanced.outputEpub, runDir);

    const lossless = await runPipelineCase(runDir, inputEpub, "lossless", ["--preset", "lossless"]);
    if (lossless.report.preset !== "lossless") {
      throw new Error("Expected lossless E2E report to record the lossless preset.");
    }
    await assertLosslessOutput(lossless.outputEpub, runDir);

    const author = await runPipelineCase(runDir, inputEpub, "author", [
      "--preset",
      "author",
      "--strict",
    ]);
    if (author.report.preset !== "author" || author.report.strict !== true) {
      throw new Error("Expected author E2E report to record author preset and strict mode.");
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      const step = author.report.steps?.find(({ name }) => name === stepName);
      if (step?.status !== "success") {
        throw new Error(`Expected ${stepName} to succeed in author E2E run.`);
      }
    }
    await assertAuthorOutput(author.outputEpub, runDir);

    console.log("E2E EPUBCheck fixtures passed for balanced, lossless, and author presets.");
  } finally {
    await fs.remove(runDir);
  }
}

function isEntryPoint(metaUrl: string): boolean {
  return process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === metaUrl : false;
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export { assertOptimizedOutput, createEpub, createFixtureEpubStructure };

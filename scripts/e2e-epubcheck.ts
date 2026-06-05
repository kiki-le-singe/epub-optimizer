import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import unzipper from "unzipper";
import yazl from "yazl";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const pipelinePath = path.join(repoRoot, "dist", "src", "pipeline.js");
const epubcheckPath = path.resolve(
  repoRoot,
  process.env.EPUBCHECK_PATH ?? path.join("epubcheck", "epubcheck.jar")
);

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

async function createAuthorFixtureEpubStructure(root: string): Promise<void> {
  await createFixtureEpubStructure(root);
  const oebps = path.join(root, "OEBPS");

  await fs.writeFile(
    path.join(oebps, "content.opf"),
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:123e4567-e89b-12d3-a456-426614174001</dc:identifier>
    <dc:title>EPUB Optimizer Author Fixture</dc:title>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-06-04T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="summary" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-1" href="chapters/chapter-1.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
    <item id="styles" href="styles/book.css" media-type="text/css"/>
    <item id="photo" href="images/photo.png" media-type="image/png" properties="cover-image"/>
    <item id="diagram" href="images/diagram.svg" media-type="image/svg+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover" linear="no"/>
    <itemref idref="summary"/>
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
  <body><nav epub:type="toc"><ol>
    <li><a href="chapter-2.xhtml">Contents</a></li>
    <li><a href="chapters/chapter-1.xhtml">Chapter 1</a></li>
  </ol></nav></body>
</html>
`
  );

  await fs.writeFile(
    path.join(oebps, "chapter-2.xhtml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Contents</title></head>
  <body>
    <p class="p6"><a href="chapter-2.xhtml">Contents</a></p>
    <p class="p6"><a href="chapters/chapter-1.xhtml">Chapter 1</a></p>
    <p class="p7"><a href="chapters/chapter-1.xhtml#section-one">Section One</a></p>
    <p class="p7"><a href="chapters/chapter-1.xhtml#section-two">Section Two</a></p>
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
      <section id="section-one"><h2>Section One</h2><img src="../images/photo.png" alt="Photo"/></section>
      <section id="section-two"><h2>Section Two</h2><img src="../images/diagram.svg" alt="Diagram"/></section>
      <script>console.log("author fixture");</script>
    </section>
  </body>
</html>
`
  );

  await fs.writeFile(
    path.join(oebps, "toc.ncx"),
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:123e4567-e89b-12d3-a456-426614174001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>EPUB Optimizer Author Fixture</text></docTitle>
  <navMap>
    <navPoint id="summary" playOrder="1"><navLabel><text>Contents</text></navLabel><content src="chapter-2.xhtml"/></navPoint>
    <navPoint id="chapter-1" playOrder="2"><navLabel><text>Chapter 1</text></navLabel><content src="chapters/chapter-1.xhtml"/></navPoint>
  </navMap>
</ncx>
`
  );
}

async function createConfiguredAuthorFixtureEpubStructure(root: string): Promise<void> {
  await createAuthorFixtureEpubStructure(root);
  const oebps = path.join(root, "OEBPS");
  const summaryPath = path.join(oebps, "chapter-2.xhtml");
  const configuredSummaryPath = path.join(oebps, "contents.xhtml");

  await fs.move(summaryPath, configuredSummaryPath);
  await fs.writeFile(
    configuredSummaryPath,
    (await fs.readFile(configuredSummaryPath, "utf8"))
      .replaceAll("chapter-2.xhtml", "contents.xhtml")
      .replaceAll('class="p6"', 'class="chapter-link"')
      .replaceAll('class="p7"', 'class="section-link"')
  );

  for (const fileName of ["content.opf", "nav.xhtml", "toc.ncx"]) {
    const filePath = path.join(oebps, fileName);
    let content = (await fs.readFile(filePath, "utf8")).replaceAll(
      "chapter-2.xhtml",
      "contents.xhtml"
    );
    if (fileName === "content.opf") {
      content = content
        .replace('id="cover" href="cover.xhtml"', 'id="front-cover" href="cover.xhtml"')
        .replace('idref="cover"', 'idref="front-cover"');
    }
    await fs.writeFile(filePath, content);
  }
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
  await fs.remove(outputDir);
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

  const summary = await fs.readFile(path.join(contentDir, "chapter-2.xhtml"), "utf8");
  if (summary.includes('href="chapter-2.xhtml"') || !summary.includes('href="cover.xhtml"')) {
    throw new Error("Expected author preset to replace the summary self-link with a cover link.");
  }

  const nav = await fs.readFile(path.join(contentDir, "nav.xhtml"), "utf8");
  if (
    !nav.includes('href="cover.xhtml"') ||
    !nav.includes('href="chapters/chapter-1.xhtml#section-one"')
  ) {
    throw new Error("Expected author preset to add cover and subsection EPUB3 navigation entries.");
  }

  const ncx = await fs.readFile(path.join(contentDir, "toc.ncx"), "utf8");
  const $ncx = cheerio.load(ncx, { xmlMode: true });
  const playOrders = $ncx("navMap navPoint")
    .map((_, element) => $ncx(element).attr("playOrder"))
    .get();
  if (playOrders.join(",") !== playOrders.map((_, index) => String(index + 1)).join(",")) {
    throw new Error("Expected author preset to keep NCX playOrder sequential.");
  }
  if ($ncx('meta[name="dtb:depth"]').attr("content") !== "2") {
    throw new Error("Expected author preset to update NCX navigation depth.");
  }
  if (
    $ncx('content[src="cover.xhtml"]').length !== 1 ||
    $ncx('content[src="chapters/chapter-1.xhtml#section-one"]').length !== 1
  ) {
    throw new Error("Expected author preset to add cover and subsection NCX entries.");
  }
}

async function assertSizeRegression(
  inputEpub: string,
  outputEpub: string,
  maxOutputRatio: number
): Promise<void> {
  const [inputStats, outputStats] = await Promise.all([fs.stat(inputEpub), fs.stat(outputEpub)]);
  const ratio = outputStats.size / inputStats.size;
  if (ratio > maxOutputRatio) {
    throw new Error(
      `Output size regression: ${(ratio * 100).toFixed(1)}% of input exceeds ${(maxOutputRatio * 100).toFixed(1)}% limit.`
    );
  }
}

async function assertConfiguredAuthorOutput(outputEpub: string, tempDir: string): Promise<void> {
  const inspectedDir = path.join(tempDir, "inspect-configured-author");
  await extractEpub(outputEpub, inspectedDir);
  const contentDir = path.join(inspectedDir, "OEBPS");

  const opf = await fs.readFile(path.join(contentDir, "content.opf"), "utf8");
  if (!opf.includes('idref="front-cover" linear="yes"')) {
    throw new Error("Expected configured author cover spine id to become linear.");
  }

  const summary = await fs.readFile(path.join(contentDir, "contents.xhtml"), "utf8");
  if (summary.includes('href="contents.xhtml"') || !summary.includes('href="cover.xhtml"')) {
    throw new Error("Expected configured author summary mapping to be applied.");
  }

  const nav = await fs.readFile(path.join(contentDir, "nav.xhtml"), "utf8");
  if (!nav.includes('class="toc-cover"') || !nav.includes('class="toc-section"')) {
    throw new Error("Expected configured author navigation classes to be applied.");
  }
}

interface E2ERunResult {
  outputEpub: string;
  report: {
    preset?: string;
    strict?: boolean;
    success?: boolean;
    steps?: Array<{ name?: string; status?: string }>;
    content?: {
      before?: { images?: number; contentDocuments?: number };
      after?: { images?: number; contentDocuments?: number };
      integrity?: { valid?: boolean; issues?: string[] };
    };
  };
}

type PnpmWorkflowScript =
  | "optimize"
  | "optimize:author"
  | "optimize:clean"
  | "optimize:lossless"
  | "optimize:repair";

function runPnpmScript(script: PnpmWorkflowScript, args: string[], env: NodeJS.ProcessEnv) {
  const pnpmExecPath = process.env.npm_execpath;
  const command = pnpmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";
  const commandArgs = pnpmExecPath ? [pnpmExecPath, script, ...args] : [script, ...args];

  return spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

function assertStepStatus(
  report: E2ERunResult["report"],
  stepName: string,
  expectedStatus: "success" | "skipped"
): void {
  const step = report.steps?.find(({ name }) => name === stepName);
  if (step?.status !== expectedStatus) {
    throw new Error(
      `Expected ${stepName} to be ${expectedStatus}, received ${step?.status ?? "missing"}.`
    );
  }
}

async function runPnpmWorkflowCase(
  runDir: string,
  inputEpub: string,
  name: string,
  script: PnpmWorkflowScript,
  expectClean: boolean,
  extraArgs: string[] = []
): Promise<E2ERunResult> {
  const outputEpub = path.join(runDir, `${name}.epub`);
  const extractDir = path.join(runDir, `extract-${name}`);
  const reportPath = path.join(runDir, `report-${name}.json`);
  const result = runPnpmScript(
    script,
    [
      "-i",
      inputEpub,
      "-o",
      outputEpub,
      "--temp",
      extractDir,
      "--report-json",
      reportPath,
      ...extraArgs,
    ],
    withJavaFallback(process.env)
  );

  if (result.status !== 0) {
    throw new Error(`pnpm ${script} E2E failed with exit ${result.status ?? "unknown"}.`);
  }
  if (!(await fs.pathExists(outputEpub))) {
    throw new Error(`Expected pnpm ${script} optimized EPUB output to exist.`);
  }
  const tempExists = await fs.pathExists(extractDir);
  if (expectClean && tempExists) {
    throw new Error(`Expected pnpm ${script} to remove the extraction temp directory.`);
  }
  if (!expectClean && !tempExists) {
    throw new Error(`Expected pnpm ${script} to keep the extraction temp directory.`);
  }

  const report = (await fs.readJson(reportPath)) as E2ERunResult["report"];
  if (report.success !== true) {
    throw new Error(`Expected pnpm ${script} JSON pipeline report to record a successful run.`);
  }
  if (report.content?.integrity?.valid !== true) {
    throw new Error(`Expected pnpm ${script} JSON report to record valid content integrity.`);
  }

  return { outputEpub, report };
}

async function main(): Promise<void> {
  const env = withJavaFallback(process.env);
  assertPrerequisites(env);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "epub-optimizer-e2e-"));
  const fixtureDir = path.join(runDir, "fixture");
  const inputEpub = path.join(runDir, "input.epub");
  const authorFixtureDir = path.join(runDir, "author-fixture");
  const authorInputEpub = path.join(runDir, "author-input.epub");
  const configuredAuthorFixtureDir = path.join(runDir, "configured-author-fixture");
  const configuredAuthorInputEpub = path.join(runDir, "configured-author-input.epub");
  const authorConfigPath = path.join(runDir, "author-workflow.json");

  try {
    await createFixtureEpubStructure(fixtureDir);
    await createEpub(inputEpub, fixtureDir);
    await createAuthorFixtureEpubStructure(authorFixtureDir);
    await createEpub(authorInputEpub, authorFixtureDir);
    await createConfiguredAuthorFixtureEpubStructure(configuredAuthorFixtureDir);
    await createEpub(configuredAuthorInputEpub, configuredAuthorFixtureDir);
    await fs.writeJson(authorConfigPath, {
      summaryHref: "contents.xhtml",
      coverSpineId: "front-cover",
      chapterClasses: ["chapter-link"],
      sectionClasses: ["section-link"],
      summaryEntryClass: "chapter-link",
      coverNavClass: "toc-cover",
      sectionNavClass: "toc-section",
    });

    const balanced = await runPnpmWorkflowCase(runDir, inputEpub, "balanced", "optimize", false);
    if (balanced.report.preset !== "balanced") {
      throw new Error("Expected default E2E report to use the balanced preset.");
    }
    assertStepStatus(balanced.report, "Repair XHTML", "skipped");
    assertStepStatus(balanced.report, "Author workflow", "skipped");
    await assertOptimizedOutput(balanced.outputEpub, runDir);

    const clean = await runPnpmWorkflowCase(runDir, inputEpub, "clean", "optimize:clean", true);
    assertStepStatus(clean.report, "Cleanup", "success");
    await assertOptimizedOutput(clean.outputEpub, runDir);

    const lossless = await runPnpmWorkflowCase(
      runDir,
      inputEpub,
      "lossless",
      "optimize:lossless",
      true,
      ["--clean"]
    );
    if (lossless.report.preset !== "lossless") {
      throw new Error("Expected lossless E2E report to record the lossless preset.");
    }
    await assertLosslessOutput(lossless.outputEpub, runDir);

    const repair = await runPnpmWorkflowCase(runDir, inputEpub, "repair", "optimize:repair", true, [
      "--clean",
    ]);
    assertStepStatus(repair.report, "Repair XHTML", "success");
    assertStepStatus(repair.report, "Author workflow", "skipped");
    await assertOptimizedOutput(repair.outputEpub, runDir);

    const author = await runPnpmWorkflowCase(
      runDir,
      authorInputEpub,
      "author",
      "optimize:author",
      true,
      ["--strict", "--lang", "en", "--clean"]
    );
    if (author.report.preset !== "author" || author.report.strict !== true) {
      throw new Error("Expected author E2E report to record author preset and strict mode.");
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      assertStepStatus(author.report, stepName, "success");
    }
    await assertAuthorOutput(author.outputEpub, runDir);
    await assertSizeRegression(authorInputEpub, author.outputEpub, 0.75);

    const configuredAuthor = await runPnpmWorkflowCase(
      runDir,
      configuredAuthorInputEpub,
      "configured-author",
      "optimize:author",
      true,
      ["--strict", "--lang", "en", "--author-config", authorConfigPath, "--clean"]
    );
    if (configuredAuthor.report.preset !== "author" || configuredAuthor.report.strict !== true) {
      throw new Error(
        "Expected configured author E2E report to record author preset and strict mode."
      );
    }
    for (const stepName of ["Repair XHTML", "Author workflow"]) {
      assertStepStatus(configuredAuthor.report, stepName, "success");
    }
    await assertConfiguredAuthorOutput(configuredAuthor.outputEpub, runDir);

    console.log(
      "Public pnpm workflows passed E2E validation: optimize, clean, lossless, repair, author, and configured author."
    );
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

export {
  assertAuthorOutput,
  assertConfiguredAuthorOutput,
  assertLosslessOutput,
  assertOptimizedOutput,
  assertSizeRegression,
  createAuthorFixtureEpubStructure,
  createConfiguredAuthorFixtureEpubStructure,
  createEpub,
  createFixtureEpubStructure,
};

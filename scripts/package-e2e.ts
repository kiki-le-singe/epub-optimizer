import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import unzipper from "unzipper";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8")) as {
  name: string;
  version: string;
  packageManager: string;
  main: string;
  types: string;
  bin: Record<string, string>;
};

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status ?? result.error?.message}):\n${result.stdout}\n${result.stderr}`
    );
  return result.stdout;
}

function pnpm(args: string[], cwd: string): string {
  // The caller is pnpm test:package, so reuse the pinned executable from its environment.
  assert.ok(process.env.npm_execpath, "Run this check through pnpm test:package.");
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

function options(input: string, output: string, temp: string, reportJson: string) {
  return {
    input,
    output,
    temp,
    reportJson,
    clean: true,
    strict: true,
    profile: false,
    preset: "lossless",
    lossless: true,
    fonts: true,
    repair: false,
    jpgQuality: 70,
    "jpg-quality": 70,
    pngQuality: 0.6,
    "png-quality": 0.6,
    convertPng: false,
    "convert-png": false,
    maxImageDim: 0,
    "max-image-dim": 0,
    lazyLoading: false,
    "lazy-loading": false,
    authorWorkflow: false,
    "author-workflow": false,
    doctor: false,
    inspect: false,
    lang: "en",
    _: [],
    $0: "installed-package-test",
  };
}

async function fixture(file: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    ),
    "META-INF/container.xml"
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:123e4567-e89b-12d3-a456-426614174000</dc:identifier><dc:title>Installed package fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="font" href="fixture.ttf" media-type="font/ttf"/></manifest><spine><itemref idref="chapter"/></spine></package>`
    ),
    "OPS/book.opf"
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title><style>@font-face{font-family:fixture;src:url(fixture.ttf)}body{font-family:fixture}</style></head><body><h1 id="chapter">Chapter</h1><pre>Keep  these spaces &amp; entities.</pre></body></html>`
    ),
    "OPS/chapter.xhtml"
  );
  zip.addBuffer(
    Buffer.from(
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#chapter">Chapter</a></li></ol></nav></body></html>`
    ),
    "OPS/nav.xhtml"
  );
  zip.addBuffer(
    await fs.readFile(path.join(repo, "scripts/fixtures/fonts/fixture.ttf")),
    "OPS/fixture.ttf"
  );
  const written = pipeline(zip.outputStream, createWriteStream(file, { flags: "wx" }));
  zip.end();
  await written;
}

async function assertReport(file: string): Promise<void> {
  const report = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(report.success, true);
  assert.equal(report.content.integrity.valid, true);
  assert.equal(
    report.steps.find((step: { name: string }) => step.name === "Validate text preservation")
      ?.status,
    "success"
  );
  assert.equal(report.validation.source, "json");
  assert.equal(report.validation.totals.errors, 0);
  assert.equal(report.validation.totals.warnings, 0);
}

async function main(): Promise<void> {
  const validator = path.resolve(repo, process.env.EPUBCHECK_PATH ?? "epubcheck/epubcheck.jar");
  await fs.access(validator);
  run("java", ["-version"], repo);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-package-e2e-"));
  const owner = await fs.lstat(root);
  try {
    const archive = path.join(root, "epub-optimizer.tgz");
    // Exercise the real prepack build and inspect the artifact consumers receive.
    pnpm(["pack", "--out", archive], repo);
    const entries = run("tar", ["-tzf", archive], root).trim().split(/\r?\n/);
    const required = [
      "package.json",
      "README.md",
      "LICENSE",
      pkg.main,
      pkg.types,
      "scripts/install-epubcheck.sh",
    ];
    for (const name of required)
      assert.ok(entries.includes(`package/${name}`), `Missing packaged ${name}`);
    for (const entry of entries) {
      assert.ok(!entry.includes("..") && !entry.startsWith("/"), `Unsafe archive entry: ${entry}`);
      assert.ok(
        /^package\/(?:package\.json|README\.md|LICENSE|scripts\/install-epubcheck\.sh|dist\/.+\.(?:js|d\.ts))$/.test(
          entry
        ),
        `Unexpected packaged file: ${entry}`
      );
      assert.ok(!/\.(?:test|spec)\.|__tests__/.test(entry), `Packaged test: ${entry}`);
    }
    const consumer = path.join(root, "consumer");
    const cwd = path.join(root, "working-directory");
    await fs.mkdir(consumer);
    await fs.mkdir(cwd);
    await fs.writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        packageManager: pkg.packageManager,
        dependencies: { [pkg.name]: `file:${archive}` },
      })
    );
    console.log(
      "Installing the packed tarball with production dependencies in an isolated consumer..."
    );
    pnpm(
      ["install", "--prod", "--ignore-scripts", "--ignore-workspace", "--no-frozen-lockfile"],
      consumer
    );
    pnpm(["audit", "--prod"], consumer);
    const installed = path.join(consumer, "node_modules", pkg.name);
    assert.notEqual(await fs.realpath(installed), repo);
    const installedPkg = JSON.parse(
      await fs.readFile(path.join(installed, "package.json"), "utf8")
    );
    assert.equal(installedPkg.version, pkg.version);
    assert.equal(installedPkg.types, pkg.types);
    assert.deepEqual(
      await fs.readFile(path.join(installed, "scripts/install-epubcheck.sh")),
      await fs.readFile(path.join(repo, "scripts/install-epubcheck.sh"))
    );
    const bin = path.join(installed, installedPkg.bin["epub-optimizer"]);
    assert.equal(pnpm(["exec", "epub-optimizer", "--version"], consumer).trim(), pkg.version);
    assert.equal(run(process.execPath, [bin, "--version"], cwd).trim(), pkg.version);
    assert.match(run(process.execPath, [bin, "--help"], cwd), /--png-background/);
    await fs.access(
      path.join(
        consumer,
        "node_modules/.bin",
        process.platform === "win32" ? "epub-optimizer.CMD" : "epub-optimizer"
      )
    );

    await fs.writeFile(
      path.join(consumer, "consumer.ts"),
      `import { optimizeEPUB, runBatch, runWatch, type WatchOptions, type WatchReport, reportWarning, type Args, type Preset, type OptimizeOptions, type ContentProcessingOptions, type PipelineReport, type BatchReport, type EpubCheckReport } from "epub-optimizer";
export async function typedConsumer(args: Args, report?: PipelineReport): Promise<BatchReport> {
  const preset: Preset = "balanced";
  const hooks: ContentProcessingOptions = { runStep: async (_name, operation) => operation() };
  const options: OptimizeOptions = { ...hooks, skipPackaging: false };
  const result: { success: boolean; input: string; output: string } = await optimizeEPUB({ ...args, preset, pngBackground: "#ffffff" }, options);
  const validation: EpubCheckReport | undefined = report?.validation;
  void result; void validation; reportWarning("example");
  return runBatch(args);
}
export function typedWatcher(args: Args, signal: WatchOptions["signal"]): Promise<WatchReport> {
  return runWatch(args, { signal });
}
// @ts-expect-error Watch requires an event-capable cancellation signal.
runWatch({} as Args, { signal: { aborted: false } });
// @ts-expect-error API arguments must not degrade to any.
optimizeEPUB(123);
// @ts-expect-error PNG background must remain a string.
const invalidBackground: Pick<Args, "pngBackground"> = { pngBackground: 42 };
// @ts-expect-error Presets must retain their literal union.
const invalidPreset: Preset = "invalid";
void invalidBackground; void invalidPreset;
`
    );
    await fs.writeFile(
      path.join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
          lib: ["ES2022"],
        },
        files: ["consumer.ts"],
      })
    );
    run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", consumer], consumer);
    console.log(
      "Installed-package TypeScript consumer passed without repository or development typings."
    );

    const input = path.join(cwd, "input.epub");
    await fixture(input);
    const inputHash = createHash("sha256")
      .update(await fs.readFile(input))
      .digest("hex");
    const env = { ...process.env, EPUBCHECK_PATH: validator };
    run(
      process.execPath,
      [
        bin,
        "-i",
        input,
        "-o",
        "cli.epub",
        "--preset",
        "lossless",
        "--strict",
        "--fonts",
        "--clean",
        "--report-json",
        "cli.json",
      ],
      cwd,
      env
    );
    await assertReport(path.join(cwd, "cli.json"));
    const optimizedArchive = await unzipper.Open.file(path.join(cwd, "cli.epub"));
    const font = optimizedArchive.files.find((entry) => entry.path === "OPS/fixture.ttf");
    assert.ok(font);
    assert.ok(
      (await font.buffer()).length <
        (await fs.stat(path.join(repo, "scripts/fixtures/fonts/fixture.ttf"))).size
    );

    const apiArgs = options(
      input,
      path.join(cwd, "api.epub"),
      path.join(cwd, "api-extracted"),
      path.join(cwd, "api.json")
    );
    await fs.writeFile(
      path.join(consumer, "api-client.mjs"),
      `import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { optimizeEPUB, runBatch, formatFileSize } from "epub-optimizer";
import { createRequire } from "node:module";
import { formatFileSize as deepImport } from "epub-optimizer/dist/src/utils/file-size.js";
assert.equal(typeof runBatch, "function"); assert.equal(formatFileSize(1024), deepImport(1024));
const args = ${JSON.stringify(apiArgs)};
const result = await optimizeEPUB(args); assert.equal(result.success, true);
const installedRequire = createRequire(import.meta.resolve("epub-optimizer"));
const apiZip = await installedRequire("unzipper").Open.file(args.output);
const apiFont = apiZip.files.find(entry => entry.path === "OPS/fixture.ttf");
assert.ok(apiFont); assert.ok((await apiFont.buffer()).length < ${String((await fs.stat(path.join(repo, "scripts/fixtures/fonts/fixture.ttf"))).size)});

await fs.writeFile(args.output, "previous output");
try { await optimizeEPUB({ ...args, input: args.input + ".missing" }, { skipPackaging: true }); assert.fail("Missing input succeeded"); }
catch (error) {
  assert.match(error.message, /Input file not found/);
  const frame = error.stack.match(/epub-processor\\.js:(\\d+):(\\d+)/);
  assert.ok(frame, error.stack); assert.ok(Number(frame[1]) > 1); assert.ok(Number(frame[2]) < 250);
  const source = await fs.readFile(${JSON.stringify(path.join(installed, "dist/src/processors/epub-processor.js"))}, "utf8");
  assert.match(source.split("\\n")[Number(frame[1]) - 1], /Input file not found/);
}
assert.equal(await fs.readFile(args.output, "utf8"), "previous output");
`
    );
    run(process.execPath, [path.join(consumer, "api-client.mjs")], cwd, env);
    await assertReport(path.join(cwd, "api.json"));

    // A package install does not silently download a validator. Missing configuration must fail safely.
    const unconfiguredEnv = { ...process.env };
    delete unconfiguredEnv.EPUBCHECK_PATH;
    await fs.writeFile(path.join(cwd, "unconfigured.epub"), "previous output");
    const missing = spawnSync(
      process.execPath,
      [
        bin,
        "-i",
        input,
        "-o",
        "unconfigured.epub",
        "--preset",
        "lossless",
        "--report-json",
        "unconfigured.json",
      ],
      { cwd, env: unconfiguredEnv, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(missing.status, 1);
    assert.equal(await fs.readFile(path.join(cwd, "unconfigured.epub"), "utf8"), "previous output");
    const failed = JSON.parse(await fs.readFile(path.join(cwd, "unconfigured.json"), "utf8"));
    assert.equal(failed.success, false);
    assert.equal(failed.validation.exitCode, 1);
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(input))
        .digest("hex"),
      inputHash
    );
    console.log(
      "Packed CLI/API, readable error stacks, external EPUBCheck, safe unconfigured failure and input preservation passed."
    );
  } finally {
    const current = await fs.lstat(root);
    assert.ok(
      current.isDirectory() && current.dev === owner.dev && current.ino === owner.ino,
      "Package test directory ownership changed; refusing cleanup."
    );
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();

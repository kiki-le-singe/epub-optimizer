import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { optimizeEPUB, reportWarning } from "./index";
import { parseArguments } from "./cli";
import type { Args } from "./types";
import { compressEPUB } from "./processors/archive-processor";
import { run as validateEPUB } from "./scripts/validate-epub.js";
import { getContentPath } from "./utils/epub-utils";

vi.mock("./scripts/validate-epub.js", () => ({ run: vi.fn().mockResolvedValue(undefined) }));

// Mock the CLI module to avoid parsing real argv
vi.mock("./cli", () => ({
  parseArguments: vi.fn(),
}));

describe("EPUB Optimization Integration Tests", () => {
  const tempDir = path.join(os.tmpdir(), "epub-optimizer-integration-test");
  const mockInputEpub = path.join(tempDir, "input.epub");
  const mockOutputEpub = path.join(tempDir, "output.epub");
  const extractDir = path.join(tempDir, "extract");

  // Mock the args that would normally come from CLI
  const mockArgs: Args = {
    input: mockInputEpub,
    output: mockOutputEpub,
    temp: extractDir,
    clean: true,
    "jpg-quality": 80,
    jpgQuality: 80,
    "png-quality": 0.6,
    pngQuality: 0.6,
    fonts: false,
    "author-workflow": false,
    authorWorkflow: false,
    repair: false,
    strict: false,
    profile: false,
    preset: "balanced",
    "max-image-dim": 1600,
    maxImageDim: 1600,
    "convert-png": true,
    convertPng: true,
    "lazy-loading": false,
    lazyLoading: false,
    lossless: false,
    doctor: false,
    inspect: false,
    lang: "fr",
    _: [],
    $0: "epub-optimizer",
  };

  beforeEach(async () => {
    // Create the test directory
    await fs.ensureDir(tempDir);

    vi.mocked(validateEPUB).mockReset().mockResolvedValue(undefined);

    // Mock the parseArguments to return our test args
    vi.mocked(parseArguments).mockResolvedValue(mockArgs);

    // Create a minimal valid EPUB for testing
    await createMinimalEpub(mockInputEpub);

    // Spy on console methods
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Clean up test files
    await fs.remove(tempDir);
    vi.restoreAllMocks();
  });

  it("optimizes an EPUB file end-to-end", async () => {
    vi.mocked(validateEPUB).mockImplementationOnce(async (options) => {
      expect(options?.output).not.toBe(mockOutputEpub);
      expect(await fs.pathExists(options?.output as string)).toBe(true);
      expect(await fs.pathExists(mockOutputEpub)).toBe(false);
      expect(await fs.pathExists(extractDir)).toBe(true);
    });
    const result = await optimizeEPUB();

    // Verify successful completion
    expect(result).toEqual({
      success: true,
      input: mockInputEpub,
      output: mockOutputEpub,
    });

    // Verify output file exists
    expect(await fs.pathExists(mockOutputEpub)).toBe(true);

    // Verify temporary files were cleaned up
    expect(await fs.pathExists(extractDir)).toBe(false);

    // --- NEW: Check for SVG optimization and lazy loading ---
    // Extract the optimized EPUB to a temp dir to inspect contents
    const unzipDir = path.join(tempDir, "unzipped");
    await fs.ensureDir(unzipDir);
    // Use unzipper to extract
    const unzipper = await import("unzipper");
    await fs
      .createReadStream(mockOutputEpub)
      .pipe(unzipper.Extract({ path: unzipDir }))
      .promise();
    // Check for SVG minification (if any SVGs present)
    const contentDir = await getContentPath(unzipDir);
    const contentImages = path.join(contentDir, "images");
    if (await fs.pathExists(contentImages)) {
      const files = await fs.readdir(contentImages);
      for (const file of files) {
        if (file.endsWith(".svg")) {
          const svgContent = await fs.readFile(path.join(contentImages, file), "utf8");
          expect(svgContent).not.toContain("<!--"); // Comments should be removed
        }
      }
    }
    // Check for loading="lazy" in XHTML files
    if (await fs.pathExists(contentDir)) {
      const files = await fs.readdir(contentDir);
      for (const file of files) {
        if (file.endsWith(".xhtml")) {
          const xhtml = await fs.readFile(path.join(contentDir, file), "utf8");
          if (xhtml.includes("<img")) {
            expect(xhtml).toContain('loading="lazy"');
          }
        }
      }
    }
  });

  it.each([false, true])(
    "collects explicit API-hook warnings with strict=%s and protects output when rejected",
    async (strict) => {
      const reportJson = path.join(tempDir, "hook-report.json");
      await fs.writeFile(mockOutputEpub, "previous output");
      const result = optimizeEPUB(
        { ...mockArgs, strict, reportJson },
        {
          afterExtract: () => reportWarning("custom hook warning"),
        }
      );
      if (strict) {
        await expect(result).rejects.toThrow("Strict mode rejected");
        expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
        expect(validateEPUB).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toMatchObject({ success: true });
        expect(validateEPUB).toHaveBeenCalled();
      }
      const report = await fs.readJson(reportJson);
      expect(
        report.steps.find((step: { name: string }) => step.name === "Analyze input content")
      ).toMatchObject({
        status: strict ? "failed" : "success",
        messages: ["custom hook warning"],
      });
    }
  );

  it("keeps overlapping API runs isolated when one book emits a warning", async () => {
    let readyA!: () => void;
    let readyB!: () => void;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const startedA = new Promise<void>((resolve) => {
      readyA = resolve;
    });
    const startedB = new Promise<void>((resolve) => {
      readyB = resolve;
    });
    const waitA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const waitB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const reportA = path.join(tempDir, "a.json");
    const reportB = path.join(tempDir, "b.json");
    const first = optimizeEPUB(
      {
        ...mockArgs,
        strict: true,
        temp: path.join(tempDir, "extract-a"),
        output: path.join(tempDir, "a.epub"),
        reportJson: reportA,
      },
      {
        afterExtract: async () => {
          readyA();
          await waitA;
        },
      }
    );
    await startedA;
    const second = optimizeEPUB(
      {
        ...mockArgs,
        temp: path.join(tempDir, "extract-b"),
        output: path.join(tempDir, "b.epub"),
        reportJson: reportB,
      },
      {
        afterExtract: async () => {
          reportWarning("only book B");
          readyB();
          await waitB;
        },
      }
    );
    await startedB;
    releaseA();
    await expect(first).resolves.toMatchObject({ success: true });
    releaseB();
    await expect(second).resolves.toMatchObject({ success: true });
    const a = await fs.readJson(reportA);
    const b = await fs.readJson(reportB);
    expect(a.steps.flatMap((step: { messages: string[] }) => step.messages)).not.toContain(
      "only book B"
    );
    expect(
      b.steps.find((step: { name: string }) => step.name === "Analyze input content").messages
    ).toContain("only book B");
  });

  it.each(["invalid EPUB", "EPUBCheck exceeded its time limit"])(
    "preserves an existing output and input when API validation fails: %s",
    async (reason) => {
      const existing = Buffer.from("previous output");
      const inputBefore = await fs.readFile(mockInputEpub);
      await fs.writeFile(mockOutputEpub, existing);
      vi.mocked(validateEPUB).mockRejectedValueOnce(new Error(reason));
      await expect(optimizeEPUB({ ...mockArgs, clean: true })).rejects.toThrow(reason);
      expect(await fs.readFile(mockOutputEpub)).toEqual(existing);
      expect(await fs.readFile(mockInputEpub)).toEqual(inputBefore);
      expect(await fs.pathExists(extractDir)).toBe(true);
      expect((await fs.readdir(tempDir)).filter((file) => file.includes(".candidate-"))).toEqual(
        []
      );
    }
  );

  it("blocks API content changes before validation or output publication", async () => {
    await fs.writeFile(mockOutputEpub, "previous output");
    await expect(
      optimizeEPUB(
        { ...mockArgs },
        {
          afterExtract: async (dir) => {
            const file = path.join(dir, "content.html");
            await fs.writeFile(
              file,
              (await fs.readFile(file, "utf8")).replace("Hello World", "Changed text")
            );
          },
        }
      )
    ).rejects.toThrow(/text/i);
    expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
    expect(validateEPUB).not.toHaveBeenCalled();
  });

  it("writes HTML and JSON after successful publication and cleanup", async () => {
    const reportHtml = path.join(tempDir, "report.html");
    const reportJson = path.join(tempDir, "report.json");
    await optimizeEPUB({ ...mockArgs, reportHtml, reportJson });
    const html = await fs.readFile(reportHtml, "utf8");
    expect(html).toContain("Output publication: <strong>completed</strong>");
    expect(html).toContain("Resources before and after");
    expect((await fs.readJson(reportJson)).resources.length).toBeGreaterThan(0);
    expect(await fs.pathExists(extractDir)).toBe(false);
  });

  it("preserves the validated output when writing the final JSON report fails", async () => {
    const reportJson = path.join(tempDir, "failed-report.json");
    await fs.writeFile(mockOutputEpub, "previous output");
    await expect(
      optimizeEPUB(
        { ...mockArgs, reportJson },
        {
          afterExtract: () => fs.ensureDir(reportJson),
        }
      )
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(validateEPUB).toHaveBeenCalled();
    expect((await fs.readFile(mockOutputEpub)).subarray(0, 2).toString()).toBe("PK");
    expect(await fs.pathExists(extractDir)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write JSON report:")
    );
  });

  it("writes a failed HTML report without replacing an existing output", async () => {
    const reportHtml = path.join(tempDir, "report.html");
    await fs.writeFile(mockOutputEpub, "previous output");
    vi.mocked(validateEPUB).mockRejectedValueOnce(new Error("validation failed"));
    await expect(optimizeEPUB({ ...mockArgs, reportHtml })).rejects.toThrow("validation failed");
    expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
    const html = await fs.readFile(reportHtml, "utf8");
    expect(html).toContain("EPUBCheck: <strong>failed</strong>");
    expect(html).toContain("Output publication: <strong>not completed</strong>");
  });

  it("retains structured validation errors in both reports without publishing a failed candidate", async () => {
    const reportHtml = path.join(tempDir, "failed.html");
    const reportJson = path.join(tempDir, "failed.json");
    const validation = {
      source: "json" as const,
      checkerVersion: "5.4.0",
      exitCode: 1,
      totals: { fatals: 0, errors: 1, warnings: 0, infos: 0 },
      messages: [
        {
          code: "RSC-005",
          severity: "ERROR" as const,
          message: "Invalid content",
          additionalLocations: 0,
          locations: [{ path: "content.html", line: 3, column: 8 }],
        },
      ],
    };
    await fs.writeFile(mockOutputEpub, "previous output");
    vi.mocked(validateEPUB).mockImplementationOnce((options) => {
      options?.onReport?.(validation);
      throw new Error("validation failed");
    });
    await expect(optimizeEPUB({ ...mockArgs, reportHtml, reportJson })).rejects.toThrow(
      "validation failed"
    );
    expect((await fs.readJson(reportJson)).validation).toEqual(validation);
    expect(await fs.readFile(reportHtml, "utf8")).toContain("RSC-005");
    expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
  });

  it("refuses HTML reports aliasing EPUBs or JSON reports", async () => {
    const reportHtml = path.join(tempDir, "report.html");
    await fs.link(mockInputEpub, reportHtml);
    await expect(optimizeEPUB({ ...mockArgs, reportHtml })).rejects.toThrow(/different/);
    await fs.remove(reportHtml);
    const reportJson = path.join(tempDir, "report.json");
    await fs.writeFile(reportJson, "previous report");
    await fs.link(reportJson, reportHtml);
    await expect(optimizeEPUB({ ...mockArgs, reportJson, reportHtml })).rejects.toThrow(
      /different/
    );
    expect(await fs.readFile(reportJson, "utf8")).toBe("previous report");
    expect(validateEPUB).not.toHaveBeenCalled();
  });
  it("does not publish or validate when only preparing extracted content", async () => {
    await fs.writeFile(mockOutputEpub, "previous output");
    await optimizeEPUB({ ...mockArgs }, { skipPackaging: true });
    expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
    expect(await fs.pathExists(extractDir)).toBe(true);
    expect(validateEPUB).not.toHaveBeenCalled();
  });

  it.each([
    { pngBackground: "#ffffff00" },
    { pngBackground: "#ffffff", preset: "lossless" as const },
    { pngBackground: "#ffffff", convertPng: false },
  ])("rejects invalid API background options before touching outputs: %j", async (options) => {
    await fs.writeFile(mockOutputEpub, "previous output");
    const input = await fs.readFile(mockInputEpub);
    for (const skipPackaging of [false, true]) {
      await expect(optimizeEPUB({ ...mockArgs, ...options }, { skipPackaging })).rejects.toThrow(
        "--png-background"
      );
    }
    expect(await fs.readFile(mockOutputEpub, "utf8")).toBe("previous output");
    expect(await fs.readFile(mockInputEpub)).toEqual(input);
    expect(await fs.pathExists(extractDir)).toBe(false);
    expect(validateEPUB).not.toHaveBeenCalled();
  });

  it("optimizes an EPUB and preserves temporary files when clean=false", async () => {
    // Override the clean flag
    vi.mocked(parseArguments).mockResolvedValue({
      ...mockArgs,
      clean: false,
    });

    // Run the optimization process
    await optimizeEPUB();

    // Verify temporary files were preserved
    expect(await fs.pathExists(extractDir)).toBe(true);
  });

  it("handles missing input file gracefully", async () => {
    // Override the input to a non-existent file
    const nonExistentInput = path.join(tempDir, "nonexistent.epub");
    vi.mocked(parseArguments).mockResolvedValue({
      ...mockArgs,
      input: nonExistentInput,
    });

    // Delete the input file if it somehow exists
    if (await fs.pathExists(nonExistentInput)) {
      await fs.unlink(nonExistentInput);
    }

    // Should throw an error about the missing input file
    await expect(optimizeEPUB()).rejects.toThrow("Input file not found");
  });

  it("optimizes an EPUB with custom quality settings", async () => {
    // Override quality settings
    vi.mocked(parseArguments).mockResolvedValue({
      ...mockArgs,
      jpgQuality: 90,
      pngQuality: 0.7,
    });

    // Run the optimization process
    await optimizeEPUB();

    // Verify successful output
    expect(await fs.pathExists(mockOutputEpub)).toBe(true);
  });

  it("optimizes an EPUB with no images gracefully", async () => {
    // Create a minimal EPUB with no images
    const noImageEpub = path.join(tempDir, "no-image.epub");
    const noImageExtractDir = path.join(tempDir, "no-image-extract");
    const noImageOutput = path.join(tempDir, "no-image-output.epub");

    // Helper to create a no-image EPUB
    await createMinimalEpub(noImageEpub, { withImage: false });

    // Mock args for this test
    vi.mocked(parseArguments).mockResolvedValue({
      ...mockArgs,
      input: noImageEpub,
      output: noImageOutput,
      temp: noImageExtractDir,
    });

    // Run the optimizer
    const result = await optimizeEPUB();

    // Should succeed
    expect(result.success).toBe(true);
    expect(await fs.pathExists(noImageOutput)).toBe(true);
  });
});

async function createMinimalEpub(filePath: string, opts: { withImage?: boolean } = {}) {
  const tempStructureDir = path.join(path.dirname(filePath), "temp-epub-structure");
  await fs.ensureDir(tempStructureDir);

  // Create mimetype file (must be first in the ZIP with no compression)
  await fs.writeFile(path.join(tempStructureDir, "mimetype"), "application/epub+zip");

  // Create META-INF directory
  await fs.ensureDir(path.join(tempStructureDir, "META-INF"));

  // Create container.xml
  await fs.writeFile(
    path.join(tempStructureDir, "META-INF", "container.xml"),
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`
  );

  // Create content OPF file
  await fs.writeFile(
    path.join(tempStructureDir, "content.opf"),
    `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf">
      <metadata>
        <dc:title>Test Book</dc:title>
        <dc:language>en</dc:language>
        <dc:identifier>test-id</dc:identifier>
      </metadata>
      <manifest>
        <item id="content" href="content.html" media-type="application/xhtml+xml"/>
        ${opts.withImage === false ? "" : '<item id="image" href="image.jpg" media-type="image/jpeg"/>'}
      </manifest>
      <spine>
        <itemref idref="content"/>
      </spine>
    </package>`
  );

  // Create a minimal HTML file
  await fs.writeFile(
    path.join(tempStructureDir, "content.html"),
    `<!DOCTYPE html>
    <html>
      <head><title>Test</title></head>
      <body><h1>Hello World</h1>${opts.withImage === false ? "" : '<img src="image.jpg" alt="Test Image">'}</body>
    </html>`
  );

  // Only add image if requested
  if (opts.withImage !== false) {
    const testImageBuffer = Buffer.alloc(1000, 0xff);
    await fs.writeFile(path.join(tempStructureDir, "image.jpg"), testImageBuffer);
  }

  try {
    await compressEPUB(filePath, tempStructureDir);

    // Cleanup temp structure
    await fs.remove(tempStructureDir);
  } catch (error) {
    // Fallback if compressEPUB fails
    console.error("Failed to create test EPUB using compressEPUB:", error);

    // Just create a dummy file so tests can proceed
    await fs.writeFile(filePath, "dummy epub content");

    // Cleanup temp structure
    await fs.remove(tempStructureDir);
  }
}

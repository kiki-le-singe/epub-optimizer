import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import type { Args } from "./types.js";

// Import the function we'll test
// We need to use dynamic import to mock the dependencies first
let formatFileSize: (bytes: number) => string;

// Mock dependencies before importing the module
vi.mock("fs-extra", () => ({
  default: {
    pathExists: vi.fn(),
    ensureDir: vi.fn(),
    remove: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
  },
}));

vi.mock("./cli.js", () => ({
  parseArguments: vi.fn().mockResolvedValue({
    input: "test.epub",
    output: "optimized.epub",
    temp: "/tmp/epub-extract",
    clean: true,
    "jpg-quality": 70,
    jpgQuality: 70,
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
  } as Args),
}));

vi.mock("./processors/archive-processor.js", () => ({
  extractEPUB: vi.fn().mockResolvedValue("/tmp/extracted"),
  compressEPUB: vi.fn().mockResolvedValue("/tmp/optimized.epub"),
}));

vi.mock("./processors/html-processor.js", () => ({
  processHTML: vi.fn().mockResolvedValue(5),
}));

vi.mock("./processors/image-processor.js", () => ({
  optimizeImages: vi.fn().mockResolvedValue(10),
}));

vi.mock("./processors/image-converter.js", () => ({
  convertPngToJpeg: vi.fn().mockResolvedValue(new Set()),
}));

vi.mock("./processors/js-processor.js", () => ({
  minifyJavaScript: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./processors/svg-optimizer.js", () => ({
  optimizeSVGs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./processors/lazy-img.js", () => ({
  addLazyLoadingToImages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./processors/font-processor.js", () => ({
  subsetFonts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./utils/epub-features.js", () => ({
  detectEpubFeatures: vi.fn().mockResolvedValue({
    encryptionKind: "none",
    encryptedHrefs: [],
    fixedLayout: false,
  }),
}));

// vi.resetAllMocks() clears parseArguments' resolved value between tests, so
// any test that drives optimizeEPUB past arg-parsing must re-establish it.
function makeArgs(): Args {
  return {
    input: "test.epub",
    output: "optimized.epub",
    temp: "/tmp/epub-extract",
    clean: true,
    "jpg-quality": 70,
    jpgQuality: 70,
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
  } as Args;
}

// Import after mocking
beforeEach(async () => {
  vi.mocked(fs.pathExists).mockResolvedValue(true as unknown as void);
  vi.mocked(fs.stat).mockResolvedValue({
    isFile: () => true,
  } as unknown as void);
  vi.mocked(fs.lstat).mockResolvedValue({
    isFile: () => true,
  } as unknown as void);

  // Import the module dynamically to get the mocked version
  const module = await import("./index.js");
  // Cast to specific type to bypass TypeScript errors during testing
  formatFileSize = module.formatFileSize;
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("index.ts", () => {
  describe("optimizeEPUB", () => {
    it("processes an EPUB file correctly", async () => {
      const module = await import("./index.js");
      await module.optimizeEPUB();

      // Check that extractEPUB was called with the right arguments
      const { extractEPUB } = await import("./processors/archive-processor.js");
      expect(extractEPUB).toHaveBeenCalledWith("test.epub", "/tmp/epub-extract");

      // Check that processHTML was called
      const { processHTML } = await import("./processors/html-processor.js");
      expect(processHTML).toHaveBeenCalled();

      // Check that optimizeImages was called
      const { optimizeImages } = await import("./processors/image-processor.js");
      expect(optimizeImages).toHaveBeenCalled();

      // Check that compressEPUB was called with the right arguments
      const { compressEPUB } = await import("./processors/archive-processor.js");
      expect(compressEPUB).toHaveBeenCalledWith("optimized.epub", "/tmp/epub-extract");
    });

    it("refuses a DRM-encrypted EPUB before any processing", async () => {
      const { parseArguments } = await import("./cli.js");
      vi.mocked(parseArguments).mockResolvedValueOnce(makeArgs());
      const { detectEpubFeatures } = await import("./utils/epub-features.js");
      vi.mocked(detectEpubFeatures).mockResolvedValueOnce({
        encryptionKind: "drm",
        encryptedHrefs: [],
        fixedLayout: false,
      });

      const module = await import("./index.js");
      await expect(module.optimizeEPUB()).rejects.toThrow(/encrypted\/DRM-protected/);

      // The EPUB must never be repacked when refused.
      const { compressEPUB } = await import("./processors/archive-processor.js");
      expect(compressEPUB).not.toHaveBeenCalled();
    });

    it("disables image downscaling for fixed-layout EPUBs", async () => {
      const { parseArguments } = await import("./cli.js");
      vi.mocked(parseArguments).mockResolvedValueOnce(makeArgs());
      const { detectEpubFeatures } = await import("./utils/epub-features.js");
      vi.mocked(detectEpubFeatures).mockResolvedValueOnce({
        encryptionKind: "none",
        encryptedHrefs: [],
        fixedLayout: true,
      });

      const module = await import("./index.js");
      await module.optimizeEPUB();

      const { optimizeImages } = await import("./processors/image-processor.js");
      expect(optimizeImages).toHaveBeenCalledWith(
        "/tmp/epub-extract",
        expect.objectContaining({ maxDim: undefined })
      );
    });

    it("exits with code 1 when an error occurs", async () => {
      // Reset parseArguments mock to return valid args for this test
      const { parseArguments } = await import("./cli.js");
      vi.mocked(parseArguments).mockResolvedValueOnce({
        input: "test.epub",
        output: "optimized.epub",
        temp: "/tmp/epub-extract",
        clean: true,
        "jpg-quality": 70,
        jpgQuality: 70,
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
      } as Args);

      // Mock fs.pathExists to return false to trigger the file not found error
      vi.mocked(fs.pathExists).mockResolvedValueOnce(false as unknown as void);

      const module = await import("./index.js");

      // Create a spy for console.error
      const consoleSpy = vi.spyOn(console, "error");

      // The function should now throw due to our modification
      await expect(module.optimizeEPUB()).rejects.toThrow("Input file not found: test.epub");

      // Check that console.error was called with the error message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error: Input file not found")
      );
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(500)).toBe("500.00 B");
    });

    it("formats kilobytes correctly", () => {
      expect(formatFileSize(1500)).toBe("1.46 KB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1500000)).toBe("1.43 MB");
    });

    it("formats gigabytes correctly", () => {
      expect(formatFileSize(1500000000)).toBe("1.40 GB");
    });
  });

  describe("reportFileSizeComparison", () => {
    it("calculates size reduction correctly", async () => {
      const module = await import("./index.js");
      const reportFileSizeComparison = module.reportFileSizeComparison;

      // Mock file stats
      vi.mocked(fs.stat).mockResolvedValueOnce({ size: 2000000 } as unknown as void);
      vi.mocked(fs.stat).mockResolvedValueOnce({ size: 1000000 } as unknown as void);

      // Create a spy for console.log
      const consoleSpy = vi.spyOn(console, "log");

      await reportFileSizeComparison("original.epub", "optimized.epub");

      // Check that console.log was called with the correct reduction percentage
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Reduction: 50.00%"));
    });

    it("handles errors gracefully", async () => {
      const module = await import("./index.js");
      const reportFileSizeComparison = module.reportFileSizeComparison;

      // Make fs.stat throw an error
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error("File not found"));

      // Create a spy for console.error
      const consoleSpy = vi.spyOn(console, "error");

      await reportFileSizeComparison("original.epub", "optimized.epub");

      // Check that console.error was called
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not generate file size comparison")
      );
    });
  });
});

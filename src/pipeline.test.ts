import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./cli.js", () => ({
  parseArguments: vi.fn().mockResolvedValue({
    input: "in.epub",
    output: "out.epub",
    temp: "/tmp/ep",
    clean: false,
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
    lang: "fr",
    _: [],
    $0: "epub-optimizer",
  }),
}));
vi.mock("./index.js", () => ({
  optimizeEPUB: vi
    .fn()
    .mockImplementation(
      async (
        _args: unknown,
        options: { afterExtract?: (tempDir: string) => Promise<void> | void }
      ) => {
        await options.afterExtract?.("/tmp/ep");
        return { success: true, input: "in.epub", output: "out.epub" };
      }
    ),
  reportFileSizeComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./scripts/fix/index.js", () => ({
  runFixes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./scripts/ops/update-structure.js", () => ({
  runStructureUpdates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./scripts/create-epub.js", () => ({
  run: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./scripts/validate-epub.js", () => ({
  run: vi.fn(),
}));
vi.mock("fs-extra", () => ({
  default: { pathExists: vi.fn().mockResolvedValue(false) },
}));
vi.mock("./utils/temp-dir.js", () => ({
  removeTempDir: vi.fn().mockResolvedValue("/tmp/ep"),
}));
vi.mock("./utils/output-transaction.js", () => ({
  assertDistinctInputOutput: vi.fn(),
  assertSafeOutputTarget: vi.fn().mockResolvedValue(undefined),
  assertSafeReportPath: vi.fn(),
  createCandidateOutputPath: vi.fn().mockResolvedValue("/tmp/candidate.epub"),
  commitCandidateOutput: vi.fn().mockResolvedValue(undefined),
  discardCandidateOutput: vi.fn().mockResolvedValue(undefined),
}));
const contentMetrics = {
  manifestItems: 3,
  spineItems: 1,
  contentDocuments: 2,
  images: 1,
  navigationEntries: 1,
  internalReferences: 5,
  missingReferences: 0,
  missingReferenceTargets: [],
};
vi.mock("./utils/epub-integrity.js", () => ({
  collectEpubContentMetrics: vi.fn().mockResolvedValue(contentMetrics),
  compareEpubContentMetrics: vi.fn().mockReturnValue({
    valid: true,
    checks: [],
    newMissingReferences: [],
    issues: [],
  }),
  assertEpubContentIntegrity: vi.fn(),
}));
vi.mock("./utils/author-workflow-config.js", () => ({
  loadAuthorWorkflowConfig: vi.fn().mockResolvedValue({ summaryHref: "chapter-2.xhtml" }),
}));

describe("pipeline orchestration", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("runs generic optimization without author workflow structure updates by default", async () => {
    const { main } = await import("./pipeline.js");
    const { optimizeEPUB } = await import("./index.js");
    const { runFixes } = await import("./scripts/fix/index.js");
    const { runStructureUpdates } = await import("./scripts/ops/update-structure.js");
    const { run: createEPUBFile } = await import("./scripts/create-epub.js");
    const { run: validateEPUB } = await import("./scripts/validate-epub.js");

    await main();

    expect(optimizeEPUB).toHaveBeenCalledTimes(1);
    expect(optimizeEPUB).toHaveBeenCalledWith(
      expect.objectContaining({ temp: "/tmp/ep" }),
      expect.objectContaining({ skipPackaging: true })
    );
    expect(runFixes).not.toHaveBeenCalled();
    expect(runStructureUpdates).not.toHaveBeenCalled();
    expect(createEPUBFile).toHaveBeenCalledWith({
      tempDir: "/tmp/ep",
      output: "/tmp/candidate.epub",
    });
    expect(validateEPUB).toHaveBeenCalledWith({ output: "/tmp/candidate.epub", strict: false });
  });

  it("runs author workflow structure updates when --author-workflow is set", async () => {
    const { parseArguments } = await import("./cli.js");
    vi.mocked(parseArguments).mockResolvedValueOnce({
      input: "in.epub",
      output: "out.epub",
      temp: "/tmp/ep",
      clean: false,
      "jpg-quality": 70,
      jpgQuality: 70,
      "png-quality": 0.6,
      pngQuality: 0.6,
      fonts: false,
      "author-workflow": true,
      authorWorkflow: true,
      repair: true,
      strict: false,
      profile: false,
      preset: "author",
      "max-image-dim": 1600,
      maxImageDim: 1600,
      "convert-png": true,
      convertPng: true,
      "lazy-loading": true,
      lazyLoading: true,
      lossless: false,
      lang: "fr",
      _: [],
      $0: "epub-optimizer",
    });

    const { main } = await import("./pipeline.js");
    const { runFixes } = await import("./scripts/fix/index.js");
    const { runStructureUpdates } = await import("./scripts/ops/update-structure.js");

    await main();

    expect(runFixes).toHaveBeenCalledWith({ tempDir: "/tmp/ep", strict: false });
    expect(runStructureUpdates).toHaveBeenCalledWith({
      tempDir: "/tmp/ep",
      lang: "fr",
      strict: false,
      authorConfig: { summaryHref: "chapter-2.xhtml" },
    });
  });

  it("invokes cleanup when --clean is set", async () => {
    const { parseArguments } = await import("./cli.js");
    vi.mocked(parseArguments).mockResolvedValueOnce({
      input: "in.epub",
      output: "out.epub",
      temp: "/tmp/ep",
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
      lang: "fr",
      _: [],
      $0: "epub-optimizer",
    });

    const { main } = await import("./pipeline.js");
    const { removeTempDir } = await import("./utils/temp-dir.js");

    await main();

    expect(removeTempDir).toHaveBeenCalledWith("/tmp/ep", {
      inputPath: "in.epub",
      outputPath: "out.epub",
    });
  });

  it("does not publish the output when candidate validation fails", async () => {
    const { run: validateEPUB } = await import("./scripts/validate-epub.js");
    const { commitCandidateOutput, discardCandidateOutput } =
      await import("./utils/output-transaction.js");
    vi.mocked(validateEPUB).mockImplementationOnce(() => {
      throw new Error("invalid candidate");
    });

    const { main } = await import("./pipeline.js");
    await expect(main()).rejects.toThrow("invalid candidate");

    expect(commitCandidateOutput).not.toHaveBeenCalled();
    expect(discardCandidateOutput).toHaveBeenCalledWith("/tmp/candidate.epub");
  });

  it("does not create or publish a candidate when before/after integrity fails", async () => {
    const { assertEpubContentIntegrity } = await import("./utils/epub-integrity.js");
    const { run: createEPUBFile } = await import("./scripts/create-epub.js");
    const { commitCandidateOutput } = await import("./utils/output-transaction.js");
    vi.mocked(assertEpubContentIntegrity).mockImplementationOnce(() => {
      throw new Error("content regression");
    });

    const { main } = await import("./pipeline.js");
    await expect(main()).rejects.toThrow("content regression");

    expect(createEPUBFile).not.toHaveBeenCalled();
    expect(commitCandidateOutput).not.toHaveBeenCalled();
  });
});

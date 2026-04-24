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
    lang: "fr",
    _: [],
    $0: "epub-optimizer",
  }),
}));
vi.mock("./index.js", () => ({
  optimizeEPUB: vi.fn().mockResolvedValue({ success: true, input: "in.epub", output: "out.epub" }),
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
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
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

  it("runs each step in order and forwards the shared temp/lang/output", async () => {
    const { main } = await import("./pipeline.js");
    const { optimizeEPUB } = await import("./index.js");
    const { runFixes } = await import("./scripts/fix/index.js");
    const { runStructureUpdates } = await import("./scripts/ops/update-structure.js");
    const { run: createEPUBFile } = await import("./scripts/create-epub.js");
    const { run: validateEPUB } = await import("./scripts/validate-epub.js");

    await main();

    expect(optimizeEPUB).toHaveBeenCalledTimes(1);
    expect(optimizeEPUB).toHaveBeenCalledWith(expect.objectContaining({ temp: "/tmp/ep" }), {
      skipPackaging: true,
    });
    expect(runFixes).toHaveBeenCalledWith({ tempDir: "/tmp/ep" });
    expect(runStructureUpdates).toHaveBeenCalledWith({ tempDir: "/tmp/ep", lang: "fr" });
    expect(createEPUBFile).toHaveBeenCalledWith({ tempDir: "/tmp/ep", output: "out.epub" });
    expect(validateEPUB).toHaveBeenCalledWith({ output: "out.epub" });
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
      lang: "fr",
      _: [],
      $0: "epub-optimizer",
    });

    const { main } = await import("./pipeline.js");
    const { spawnSync } = await import("node:child_process");

    await main();

    expect(spawnSync).toHaveBeenCalledWith("rm", ["-rf", "/tmp/ep"], expect.anything());
  });
});

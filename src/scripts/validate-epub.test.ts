import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { parseEpubCheckMessages, run } from "./validate-epub.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const successSummary = "Messages: 0 fatals / 0 errors / 0 warnings / 0 infos\n";

describe("validate EPUB", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: successSummary,
      stderr: "",
    } as ReturnType<typeof spawnSync>);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses EPUBCheck message totals", () => {
    expect(parseEpubCheckMessages("Messages: 1 fatal / 2 errors / 3 warnings / 4 infos")).toEqual({
      fatals: 1,
      errors: 2,
      warnings: 3,
      infos: 4,
    });
  });

  it("accepts warning-free EPUBCheck output", () => {
    expect(() => run({ output: "output.epub", strict: true })).not.toThrow();
  });

  it("reports warnings and rejects them in strict mode", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 0,
      stdout: "Messages: 0 fatals / 0 errors / 2 warnings / 0 infos\n",
      stderr: "",
    } as ReturnType<typeof spawnSync>);

    expect(() => run({ output: "output.epub", strict: true })).toThrow(
      "EPUBCheck warnings are not allowed in strict mode"
    );
    expect(console.warn).toHaveBeenCalledWith("EPUBCheck reported 2 warning(s).");
  });

  it("rejects non-zero EPUBCheck exits", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "invalid",
    } as ReturnType<typeof spawnSync>);

    expect(() => run({ output: "output.epub" })).toThrow("EPUB validation failed");
  });
});

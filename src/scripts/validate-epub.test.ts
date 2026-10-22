import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { parseEpubCheckMessages, run } from "./validate-epub.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const successSummary = "Messages: 0 fatals / 0 errors / 0 warnings / 0 infos\n";

describe("validate EPUB", () => {
  beforeEach(() => {
    vi.mocked(spawnSync)
      .mockReset()
      .mockReturnValue({
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
    expect(spawnSync).toHaveBeenLastCalledWith(
      "java",
      expect.arrayContaining(["--locale", "en", "--failonwarnings"]),
      expect.any(Object)
    );
  });

  it("does not enable EPUBCheck warning failures in non-strict mode", () => {
    run({ output: "output.epub" });
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).not.toContain("--failonwarnings");
  });

  it.each(["", "Messages: 0 fatale / 0 erreur / 1 avertissement / 0 info"])(
    "fails closed in strict mode when the validator summary is unreadable: %s",
    (stdout) => {
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout, stderr: "" } as ReturnType<
        typeof spawnSync
      >);
      expect(() => run({ output: "output.epub", strict: true })).toThrow(
        "Could not read EPUBCheck message totals"
      );
    }
  );

  it("reports unreadable summaries without rejecting non-strict validation", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as ReturnType<
      typeof spawnSync
    >);
    expect(() => run({ output: "output.epub" })).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read EPUBCheck"));
  });

  it("still rejects the native strict warning failure exit code", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "Messages: 0 fatals / 0 errors / 1 warning / 0 infos",
      stderr: "",
    } as ReturnType<typeof spawnSync>);
    expect(() => run({ output: "output.epub", strict: true })).toThrow("EPUB validation failed");
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

  it("rejects a timed-out validator and applies the configured deadline", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    } as ReturnType<typeof spawnSync>);
    expect(() => run({ output: "output.epub", timeoutMs: 1000 })).toThrow("1000 ms time limit");
    expect(spawnSync).toHaveBeenLastCalledWith(
      "java",
      expect.any(Array),
      expect.objectContaining({ timeout: 1000, killSignal: "SIGKILL" })
    );
  });
});

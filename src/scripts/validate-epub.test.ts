import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseEpubCheckMessages, run } from "./validate-epub.js";
import type { EpubCheckReport } from "../utils/epubcheck-report.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const successSummary = "Messages: 0 fatals / 0 errors / 0 warnings / 0 infos\n";
const cleanJson = () => ({
  checker: { checkerVersion: "5.4.0", nFatal: 0, nError: 0, nWarning: 0, nUsage: 0 },
  messages: [] as Array<Record<string, unknown>>,
});
let reportPath: string;
function mockValidation(
  options: {
    json?: unknown;
    raw?: string;
    missing?: boolean;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
    afterWrite?: (file: string) => void;
  } = {}
) {
  vi.mocked(spawnSync).mockImplementation(((_command: string, args: string[]) => {
    reportPath = args[args.indexOf("--json") + 1]!;
    if (!options.missing)
      fs.writeFileSync(reportPath, options.raw ?? JSON.stringify(options.json ?? cleanJson()));
    options.afterWrite?.(reportPath);
    return {
      status: options.status === undefined ? 0 : options.status,
      stdout: options.stdout ?? successSummary,
      stderr: options.stderr ?? "",
      error: options.error,
    };
  }) as typeof spawnSync);
}

describe("validate EPUB", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    mockValidation();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("retains the legacy parser for fallback summaries", () => {
    expect(parseEpubCheckMessages("Messages: 1 fatal / 2 errors / 3 warnings / 4 infos")).toEqual({
      fatals: 1,
      errors: 2,
      warnings: 3,
      infos: 4,
    });
    expect(parseEpubCheckMessages("unrecognized summary")).toBeUndefined();
  });

  it("accepts structured results independently of the human summary and cleans its private directory", () => {
    mockValidation({ stdout: "unrecognized/localized human output" });
    const onReport = vi.fn();
    run({ output: "output.epub", strict: true, onReport });
    expect(onReport).toHaveBeenCalledWith({
      source: "json",
      exitCode: 0,
      checkerVersion: "5.4.0",
      totals: { fatals: 0, errors: 0, warnings: 0, infos: 0 },
      messages: [],
    });
    expect(spawnSync).toHaveBeenLastCalledWith(
      "java",
      expect.arrayContaining(["--json", reportPath, "--locale", "en", "--failonwarnings"]),
      expect.any(Object)
    );
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("does not enable native warning failures in non-strict mode", () => {
    run({ output: "output.epub" });
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).not.toContain("--failonwarnings");
  });

  it.each([false, true])(
    "records warning codes and locations with strict=%s, before rejecting warnings when required",
    (strict) => {
      const json = cleanJson();
      json.checker.nWarning = 1;
      json.messages = [
        {
          ID: "OPF-001",
          severity: "WARNING",
          message: "Generated warning",
          locations: [{ path: "OPS/content.opf", line: 4, column: 7, context: "<metadata/>" }],
        },
      ];
      mockValidation({ json, status: strict ? 1 : 0 });
      const onReport = vi.fn();
      if (strict)
        expect(() => run({ output: "output.epub", strict, onReport })).toThrow(
          "EPUB validation failed"
        );
      else expect(() => run({ output: "output.epub", strict, onReport })).not.toThrow();
      expect(console.warn).toHaveBeenCalledWith("EPUBCheck reported 1 warning(s).");
      expect(onReport.mock.calls[0]?.[0]).toMatchObject({
        source: "json",
        totals: { warnings: 1 },
        messages: [
          {
            code: "OPF-001",
            severity: "WARNING",
            locations: [{ path: "OPS/content.opf", line: 4, column: 7, context: "<metadata/>" }],
          },
        ],
      });
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("WARNING(OPF-001): OPS/content.opf(4,7)")
      );
      expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
    }
  );

  it("rejects warning diagnostics in strict mode even if native exit is zero", () => {
    const json = cleanJson();
    json.checker.nWarning = 2;
    mockValidation({ json });
    expect(() => run({ output: "output.epub", strict: true })).toThrow(
      "EPUBCheck warnings are not allowed"
    );
  });

  it.each(["count", "message"])(
    "rejects error diagnostics despite a zero native exit: %s",
    (kind) => {
      const json = cleanJson();
      if (kind === "count") json.checker.nError = 1;
      else
        json.messages = [
          { ID: "RSC-005", severity: "ERROR", message: "Invalid content", locations: [] },
        ];
      mockValidation({ json });
      expect(() => run({ output: "output.epub" })).toThrow("despite exit 0");
    }
  );

  it.each([{ missing: true }, { raw: "not JSON" }, { json: { checker: {}, messages: [] } }])(
    "preserves strict validation using readable native totals when JSON is unavailable: %o",
    (options) => {
      mockValidation(options);
      const onReport = vi.fn();
      expect(() => run({ output: "output.epub", strict: true, onReport })).not.toThrow();
      expect(onReport.mock.calls[0]?.[0]).toMatchObject({
        source: "text",
        messages: [],
        diagnosticsError: expect.stringContaining("unavailable"),
      });
      expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
    }
  );

  it("keeps non-strict text fallback explicit instead of inventing detailed diagnostics", () => {
    mockValidation({ missing: true });
    const onReport = vi.fn();
    run({ output: "output.epub", onReport });
    expect(onReport).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "text",
        totals: { fatals: 0, errors: 0, warnings: 0, infos: 0 },
        messages: [],
        diagnosticsError: expect.stringContaining("unavailable"),
      })
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Could not read EPUBCheck JSON")
    );
  });

  it("still rejects unreadable totals in strict mode when JSON is unavailable", () => {
    mockValidation({ missing: true, stdout: "localized or unreadable totals" });
    expect(() => run({ output: "output.epub", strict: true })).toThrow(
      "Could not read EPUBCheck message totals"
    );
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("does not accept text fallback warnings in strict mode", () => {
    mockValidation({
      missing: true,
      stdout: "Messages: 0 fatals / 0 errors / 2 warnings / 0 infos",
    });
    expect(() => run({ output: "output.epub", strict: true })).toThrow("warnings are not allowed");
  });

  it("preserves non-strict native success with explicitly unavailable totals and diagnostics", () => {
    mockValidation({ missing: true, stdout: "" });
    const onReport = vi.fn();
    expect(() => run({ output: "output.epub", onReport })).not.toThrow();
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({
      source: "unavailable",
      exitCode: 0,
      messages: [],
    });
  });

  it("rejects a nonzero exit even when the JSON report looks clean", () => {
    mockValidation({ status: 1 });
    expect(() => run({ output: "output.epub" })).toThrow("EPUB validation failed");
  });

  it("reports timeout independently of a partial JSON file and cleans its private report", () => {
    mockValidation({
      status: null,
      raw: "{",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    const onReport = vi.fn();
    expect(() => run({ output: "output.epub", timeoutMs: 1000, onReport })).toThrow(
      "1000 ms time limit"
    );
    expect(spawnSync).toHaveBeenLastCalledWith(
      "java",
      expect.any(Array),
      expect.objectContaining({ timeout: 1000, killSignal: "SIGKILL" })
    );
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({
      source: "unavailable",
      exitCode: null,
      diagnosticsError: expect.stringContaining("time limit"),
    });
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("reports launch errors without converting them into successful validation", () => {
    mockValidation({
      status: null,
      missing: true,
      error: Object.assign(new Error("java not found"), { code: "ENOENT" }),
    });
    const reports: EpubCheckReport[] = [];
    expect(() =>
      run({ output: "output.epub", onReport: (report) => reports.push(report) })
    ).toThrow("Failed to run EPUBCheck");
    expect(reports[0]?.diagnosticsError).toContain("java not found");
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("uses unique report paths on subsequent validations", () => {
    run({ output: "output.epub" });
    const first = reportPath;
    run({ output: "output.epub" });
    expect(reportPath).not.toBe(first);
    expect(fs.existsSync(path.dirname(first))).toBe(false);
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("rejects an oversized JSON report without accepting it as complete diagnostics", () => {
    mockValidation({ afterWrite: (file) => fs.truncateSync(file, 16 * 1024 * 1024 + 1) });
    const onReport = vi.fn();
    run({ output: "output.epub", strict: true, onReport });
    expect(onReport.mock.calls[0]?.[0]).toMatchObject({
      source: "text",
      diagnosticsError: expect.stringContaining("16 MiB"),
    });
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("does not follow a diagnostic-file symlink or delete its external target", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "epubcheck-test-outside-"));
    const target = path.join(outside, "keep.json");
    const original = JSON.stringify(cleanJson());
    fs.writeFileSync(target, original);
    try {
      mockValidation({
        afterWrite: (file) => {
          fs.unlinkSync(file);
          fs.symlinkSync(target, file);
        },
      });
      const onReport = vi.fn();
      run({ output: "output.epub", strict: true, onReport });
      expect(onReport.mock.calls[0]?.[0]).toMatchObject({
        source: "text",
        diagnosticsError: expect.stringContaining("regular file"),
      });
      expect(fs.readFileSync(target, "utf8")).toBe(original);
      expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to read or clean a report directory replaced by a symlink", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "epubcheck-test-outside-"));
    const target = path.join(outside, "diagnostics.json");
    fs.writeFileSync(target, "keep this external file");
    let originalDirectory = "";
    try {
      mockValidation({
        afterWrite: (file) => {
          const directory = path.dirname(file);
          originalDirectory = `${directory}-original`;
          fs.renameSync(directory, originalDirectory);
          fs.symlinkSync(outside, directory, "dir");
        },
      });
      const onReport = vi.fn();
      expect(() => run({ output: "output.epub", onReport })).toThrow("ownership changed");
      expect(onReport).toHaveBeenCalled();
      expect(fs.readFileSync(target, "utf8")).toBe("keep this external file");
    } finally {
      fs.unlinkSync(path.dirname(reportPath));
      if (originalDirectory) fs.rmSync(originalDirectory, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cleans private diagnostics even if the report callback throws", () => {
    expect(() =>
      run({
        output: "output.epub",
        onReport: () => {
          throw new Error("consumer error");
        },
      })
    ).toThrow("consumer error");
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });
});

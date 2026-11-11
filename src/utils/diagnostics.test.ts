import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectDiagnostics,
  reportError,
  reportInfo,
  reportWarning,
  reportWarningToStdout,
  type Diagnostic,
} from "./diagnostics.js";

afterEach(() => vi.restoreAllMocks());

describe("explicit diagnostics", () => {
  it("preserves stdout/stderr calls and argument formatting while classifying severity explicitly", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostics: Diagnostic[] = [];
    const reason = new Error("broken resource");
    const result = await collectDiagnostics(
      () => {
        reportInfo("Warning: informational content");
        reportWarning("missing", "file.xhtml");
        reportError("failed", reason);
        reportWarningToStdout("Warning: legacy stdout message");
        return 42;
      },
      (diagnostic) => diagnostics.push(diagnostic)
    );
    expect(result).toBe(42);
    expect(diagnostics).toEqual([
      { severity: "warning", message: "missing file.xhtml" },
      { severity: "error", message: "failed Error: broken resource" },
      { severity: "warning", message: "Warning: legacy stdout message" },
    ]);
    expect(log).toHaveBeenCalledWith("Warning: informational content");
    expect(log).toHaveBeenCalledWith("Warning: legacy stdout message");
    expect(warn).toHaveBeenCalledWith("missing", "file.xhtml");
    expect(error).toHaveBeenCalledWith("failed", reason);
  });

  it("closes a failing scope and keeps later standalone warnings outside that report", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages: Diagnostic[] = [];
    await expect(
      collectDiagnostics(
        () => {
          reportWarning("inside");
          throw new Error("failed operation");
        },
        (diagnostic) => messages.push(diagnostic)
      )
    ).rejects.toThrow("failed operation");
    reportWarning("outside");
    expect(messages).toEqual([{ severity: "warning", message: "inside" }]);
    expect(console.warn).toHaveBeenCalledWith("outside");
  });
});

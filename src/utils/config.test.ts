import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config", () => {
  it("resolves the default validator from the package rather than the working directory", async () => {
    vi.stubEnv("EPUBCHECK_PATH", undefined);
    vi.spyOn(process, "cwd").mockReturnValue("/unrelated-directory");
    const { default: config } = await import("./config.js");
    expect(config.epubcheckPath).toBe(
      fileURLToPath(new URL("../../epubcheck/epubcheck.jar", import.meta.url))
    );
    expect(path.isAbsolute(config.epubcheckPath)).toBe(true);
  });

  it("preserves an explicit relative EPUBCHECK_PATH override", async () => {
    vi.stubEnv("EPUBCHECK_PATH", "tools/custom.jar");
    const { default: config } = await import("./config.js");
    expect(config.epubcheckPath).toBe("tools/custom.jar");
  });
  it("allows Docker to provide an absolute EPUBCheck path", async () => {
    vi.stubEnv("EPUBCHECK_PATH", "/app/epubcheck/epubcheck.jar");
    const { default: config } = await import("./config.js");

    expect(config.epubcheckPath).toBe("/app/epubcheck/epubcheck.jar");
  });
});

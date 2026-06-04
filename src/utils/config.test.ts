import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config", () => {
  it("allows Docker to provide an absolute EPUBCheck path", async () => {
    vi.stubEnv("EPUBCHECK_PATH", "/app/epubcheck/epubcheck.jar");
    const { default: config } = await import("./config.js");

    expect(config.epubcheckPath).toBe("/app/epubcheck/epubcheck.jar");
  });
});

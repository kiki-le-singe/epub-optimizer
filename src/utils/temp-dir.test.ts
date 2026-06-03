import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { assertSafeTempDir, removeTempDir } from "./temp-dir.js";

describe("temp-dir safety", () => {
  const root = path.join(os.tmpdir(), "epub-optimizer-temp-dir-test");
  const cwd = path.join(root, "workspace");

  beforeEach(async () => {
    await fs.remove(root);
    await fs.ensureDir(cwd);
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  it("resolves safe relative temp paths from the working directory", () => {
    expect(
      assertSafeTempDir("temp_epub", {
        cwd,
        inputPath: "book.epub",
        outputPath: "book-optimized.epub",
      })
    ).toBe(path.join(cwd, "temp_epub"));
  });

  it("rejects filesystem roots", () => {
    expect(() => assertSafeTempDir(path.parse(cwd).root, { cwd })).toThrow(
      "Refusing unsafe temporary directory"
    );
  });

  it("rejects the current working directory", () => {
    expect(() => assertSafeTempDir(cwd, { cwd })).toThrow(
      "Refusing to use the current working directory"
    );
  });

  it("rejects the home directory", () => {
    const homeDir = path.join(root, "home");
    expect(() => assertSafeTempDir(homeDir, { cwd, homeDir })).toThrow(
      "Refusing to use the home directory"
    );
  });

  it("rejects a temp directory that contains the input EPUB", () => {
    expect(() =>
      assertSafeTempDir(root, {
        cwd,
        inputPath: path.join(root, "book.epub"),
      })
    ).toThrow("contains the input EPUB");
  });

  it("rejects a temp directory that contains the output EPUB", () => {
    expect(() =>
      assertSafeTempDir(root, {
        cwd,
        outputPath: path.join(root, "book-optimized.epub"),
      })
    ).toThrow("contains the output EPUB");
  });

  it("removes only a safe temp directory", async () => {
    const tempDir = path.join(cwd, "temp_epub");
    await fs.ensureDir(tempDir);
    await fs.writeFile(path.join(tempDir, "artifact.txt"), "temporary");

    await expect(
      removeTempDir(tempDir, {
        cwd,
        inputPath: path.join(cwd, "book.epub"),
        outputPath: path.join(cwd, "book-optimized.epub"),
      })
    ).resolves.toBe(tempDir);
    expect(await fs.pathExists(tempDir)).toBe(false);
  });
});

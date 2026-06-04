import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  assertDistinctInputOutput,
  assertSafeOutputTarget,
  assertSafeReportPath,
  commitCandidateOutput,
  createCandidateOutputPath,
} from "./output-transaction.js";

const root = path.join(os.tmpdir(), "epub-optimizer-output-transaction-test");

afterEach(async () => {
  await fs.remove(root);
});

describe("output transaction", () => {
  it("refuses identical input and output paths", () => {
    expect(() => assertDistinctInputOutput("book.epub", "./book.epub")).toThrow(
      "Input and output paths must be different"
    );
  });

  it("refuses a JSON report that would overwrite the input or output", () => {
    expect(() => assertSafeReportPath("book.epub", "./book.epub", "out.epub")).toThrow(
      "JSON report path must be different"
    );
    expect(() => assertSafeReportPath("out.epub", "book.epub", "./out.epub")).toThrow(
      "JSON report path must be different"
    );
  });

  it("detects hard links that point at the same file", async () => {
    const input = path.join(root, "input.epub");
    const output = path.join(root, "output.epub");
    await fs.ensureDir(root);
    await fs.writeFile(input, "original");
    await fs.link(input, output);

    expect(() => assertDistinctInputOutput(input, output)).toThrow(
      "Input and output paths must be different"
    );
    expect(() => assertSafeReportPath(output, input, "other.epub")).toThrow(
      "JSON report path must be different"
    );
  });

  it("detects missing targets that alias through a symbolic-link parent", async () => {
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    const output = path.join(realDir, "output.epub");
    const report = path.join(aliasDir, "output.epub");
    await fs.ensureDir(realDir);
    await fs.symlink(realDir, aliasDir, "dir");

    expect(() => assertSafeReportPath(report, "input.epub", output)).toThrow(
      "JSON report path must be different"
    );
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "detects case-only aliases on case-insensitive platforms",
    () => {
      expect(() =>
        assertSafeReportPath(
          path.join(root, "OUTPUT.epub"),
          "input.epub",
          path.join(root, "output.epub")
        )
      ).toThrow("JSON report path must be different");
    }
  );

  it("refuses to replace a directory or symbolic link as the output target", async () => {
    const directory = path.join(root, "directory.epub");
    const target = path.join(root, "target.epub");
    const symlink = path.join(root, "symlink.epub");
    const brokenSymlink = path.join(root, "broken-symlink.epub");
    await fs.ensureDir(directory);
    await fs.writeFile(target, "existing");
    await fs.symlink(target, symlink);
    await fs.symlink(path.join(root, "missing.epub"), brokenSymlink);

    await expect(assertSafeOutputTarget(directory)).rejects.toThrow("refusing unsafe target");
    await expect(assertSafeOutputTarget(symlink)).rejects.toThrow("refusing unsafe target");
    await expect(assertSafeOutputTarget(brokenSymlink)).rejects.toThrow("refusing unsafe target");
    await expect(assertSafeOutputTarget(target)).resolves.toBeUndefined();
  });

  it("refuses a JSON report path that is not a regular file", async () => {
    const directory = path.join(root, "report.json");
    await fs.ensureDir(directory);
    expect(() => assertSafeReportPath(directory, "input.epub", "output.epub")).toThrow(
      "JSON report path must be a regular file"
    );
  });

  it("publishes a candidate only when explicitly committed", async () => {
    const output = path.join(root, "output.epub");
    await fs.ensureDir(root);
    await fs.writeFile(output, "previous");
    const candidate = await createCandidateOutputPath(output);
    await fs.writeFile(candidate, "validated");

    expect(await fs.readFile(output, "utf8")).toBe("previous");
    await commitCandidateOutput(candidate, output);
    expect(await fs.readFile(output, "utf8")).toBe("validated");
  });
});

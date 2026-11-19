import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import config from "../utils/config.js";
import { getLang, getTempDir, isEntryPoint, parseArgs } from "./utils.js";

const originalArgv = process.argv;
const withArgs = (...args: string[]) => {
  process.argv = ["node", "/scripts/tool.js", ...args];
};
afterEach(() => {
  process.argv = originalArgv;
});

describe("script argument helpers", () => {
  it.each([
    [["--temp", "/abs/work"], "/abs/work"],
    [["-t", "/abs/work"], "/abs/work"],
    [["--temp=/abs/work"], "/abs/work"],
    [["-t=/abs/a=b"], "/abs/a=b"],
    [["--temp=rel/dir"], path.join(process.cwd(), "rel/dir")],
    [["--other", "x"], path.join(process.cwd(), config.tempDir)],
    [["--temp"], path.join(process.cwd(), config.tempDir)],
  ])("getTempDir(%j) is %s", (args, expected) => {
    withArgs(...args);
    expect(getTempDir()).toBe(expected);
  });

  it.each([
    [["--lang", "fr"], "fr"],
    [["--lang=de"], "de"],
    [["--lang"], config.lang],
    [[], config.lang],
  ])("getLang(%j) is %s", (args, expected) => {
    withArgs(...args);
    expect(getLang()).toBe(expected);
  });

  it("parses input and output with their aliases and defaults", () => {
    withArgs("-i", "in.epub");
    expect(parseArgs()).toMatchObject({ input: "in.epub", output: config.outputEPUB });
    withArgs("--output", "out.epub");
    const withoutInput = parseArgs(false, true);
    expect(withoutInput).toMatchObject({ output: "out.epub" });
    expect(withoutInput.input).toBeUndefined();
  });
});

describe("isEntryPoint", () => {
  it("matches the executed file through a symlink and rejects other modules", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "entry-point-"));
    try {
      const script = path.join(dir, "script.js");
      const link = path.join(dir, "link.js");
      await fs.writeFile(script, "");
      await fs.symlink(script, link);
      process.argv = ["node", link];
      expect(isEntryPoint(pathToFileURL(script).href)).toBe(true);
      expect(isEntryPoint(pathToFileURL(path.join(dir, "other.js")).href)).toBe(false);
      process.argv = ["node"];
      expect(isEntryPoint(pathToFileURL(script).href)).toBe(false);
    } finally {
      await fs.remove(dir);
    }
  });
});

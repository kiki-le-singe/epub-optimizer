import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { readCliConfig } from "./cli-config.js";
import { parseArguments } from "../cli.js";
let root: string;
const argv = process.argv;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-config-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.argv = argv;
  await fs.remove(root);
});
it("applies defaults < config < CLI including negated booleans and anchors config paths", async () => {
  const file = path.join(root, "options.json");
  await fs.writeJson(file, {
    preset: "lossless",
    fonts: true,
    input: "book.epub",
    "jpg-quality": 85,
  });
  process.argv = ["node", "tool", "--config", file, "--no-fonts", "--jpg-quality", "90"];
  const args = await parseArguments();
  expect(args.preset).toBe("lossless");
  expect(args.fonts).toBe(false);
  expect(args.input).toBe(path.join(root, "book.epub"));
  expect(args.jpgQuality).toBe(90);
  expect(args.convertPng).toBe(false);
});
it.each([
  { "apply-storage-plan": "plan.json" },
  { __proto__: null, include: "other.json" },
  { fonts: "yes" },
  { "jpg-quality": null },
  [],
])("rejects unsafe or mistyped config %j", async (value) => {
  const file = path.join(root, "config.json");
  await fs.writeJson(file, value);
  expect(() => readCliConfig(file)).toThrow();
});
it("validates configured modes and numeric ranges through the CLI", async () => {
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("CLI rejected configuration");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const file = path.join(root, "config.json");
  await fs.writeJson(file, { batch: "books", input: "book.epub", "output-dir": "out" });
  process.argv = ["node", "tool", "--config", file];
  await expect(parseArguments()).rejects.toThrow("CLI rejected configuration");
  await fs.writeJson(file, { "image-concurrency": 0 });
  await expect(parseArguments()).rejects.toThrow("CLI rejected configuration");
});
it("rejects oversized files, symlinks and prototype keys", async () => {
  const file = path.join(root, "config.json");
  await fs.writeFile(file, '{"__proto__":{}}');
  expect(() => readCliConfig(file)).toThrow("Unsupported");
  await fs.writeFile(file, " ".repeat(65537));
  expect(() => readCliConfig(file)).toThrow("64 KiB");
  const link = path.join(root, "link.json");
  await fs.symlink(file, link);
  expect(() => readCliConfig(link)).toThrow();
});

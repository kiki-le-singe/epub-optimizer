import { afterEach, describe, expect, it } from "vitest";
import { parseArguments } from "./cli.js";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
});

describe("CLI options", () => {
  it("uses distinct temporary paths for independent default invocations", async () => {
    process.argv = ["node", "epub-optimizer"];
    const first = await parseArguments();
    const second = await parseArguments();
    expect(first.temp).toMatch(/^temp_epub-/);
    expect(second.temp).not.toBe(first.temp);
  });

  it("preserves an explicit destination and resolves the validation deadline", async () => {
    process.argv = [
      "node",
      "epub-optimizer",
      "--temp",
      "chosen-temp",
      "--validation-timeout",
      "300000",
      "--preset",
      "lossless",
      "--strict",
      "--image-concurrency",
      "2",
    ];
    const args = await parseArguments();
    expect(args.temp).toBe("chosen-temp");
    expect(args.validationTimeout).toBe(300000);
    expect(args.strict).toBe(true);
    expect(args.imageConcurrency).toBe(2);
    expect(args.lossless).toBe(true);
    expect(args.convertPng).toBe(false);
  });
});

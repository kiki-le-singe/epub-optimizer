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
    expect(first.pngBackground).toBeUndefined();
  });
  it("normalizes an explicit PNG background and carries it into batch options", async () => {
    process.argv = [
      "node",
      "epub-optimizer",
      "--png-background",
      "#AaBBcC",
      "--batch",
      "books",
      "--output-dir",
      "optimized",
    ];
    const args = await parseArguments();
    expect(args.pngBackground).toBe("#aabbcc");
    expect(args["png-background"]).toBe("#aabbcc");
    expect(args.convertPng).toBe(true);
  });
  it.each(["red", "#fff", "#ffffff00", "#12345g", ""])(
    "rejects invalid or non-opaque PNG background %j",
    async (color) => {
      process.argv = ["node", "epub-optimizer", "--png-background", color];
      await expect(parseArguments()).rejects.toThrow("#RRGGBB");
    }
  );
  it.each([["--preset", "lossless"], ["--no-convert-png"], ["--doctor"]])(
    "rejects conflicting background options %j",
    async (...flags) => {
      process.argv = ["node", "epub-optimizer", "--png-background", "#ffffff", ...flags];
      await expect(parseArguments()).rejects.toThrow(/lossless|conversion|doctor/);
    }
  );

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
  it("accepts a standalone HTML report alongside JSON", async () => {
    process.argv = [
      "node",
      "epub-optimizer",
      "--report-html",
      "reports/book.html",
      "--report-json",
      "reports/book.json",
    ];
    const args = await parseArguments();
    expect(args.reportHtml).toBe("reports/book.html");
    expect(args.reportJson).toBe("reports/book.json");
  });
  it("parses batch directories without changing per-book preset settings", async () => {
    process.argv = [
      "node",
      "epub-optimizer",
      "--batch",
      "books",
      "--output-dir",
      "optimized",
      "--preset",
      "lossless",
      "--clean",
    ];
    const args = await parseArguments();
    expect(args.batch).toBe("books");
    expect(args.outputDir).toBe("optimized");
    expect(args.lossless).toBe(true);
    expect(args.clean).toBe(true);
  });
  it("parses watch settings without enabling modifying passes", async () => {
    process.argv = [
      "node",
      "epub-optimizer",
      "--watch",
      "inbox",
      "--output-dir",
      "out",
      "--watch-settle-ms",
      "5000",
    ];
    const args = await parseArguments();
    expect(args.watch).toBe("inbox");
    expect(args.outputDir).toBe("out");
    expect(args.watchSettleMs).toBe(5000);
    expect(args.authorWorkflow).toBe(false);
    expect(args.repair).toBe(false);
  });
});

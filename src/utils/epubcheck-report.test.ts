import { describe, expect, it } from "vitest";
import { parseEpubCheckJson } from "./epubcheck-report.js";
const fixture = () => ({
  checker: { checkerVersion: "5.4.0", nFatal: 1, nError: 2, nWarning: 3, nUsage: 4 },
  messages: [
    {
      ID: "RSC-005",
      severity: "ERROR",
      message: "Invalid XHTML",
      additionalLocations: 8,
      locations: [
        { path: "OPS/chapter.xhtml", line: 12, column: 3, context: "<p>broken</p>" },
        { path: "book.epub", line: -1, column: -1, context: null },
      ],
      suggestion: "Check the markup",
    },
  ],
  publication: { title: "Do not copy unrelated metadata" },
  items: [{ arbitrary: true }],
});
describe("EPUBCheck JSON normalization", () => {
  it("retains counts, codes, severity, locations, context, suggestions and omitted-location counts", () => {
    expect(parseEpubCheckJson(JSON.stringify(fixture()))).toEqual({
      checkerVersion: "5.4.0",
      totals: { fatals: 1, errors: 2, warnings: 3, infos: 4 },
      messages: [
        {
          code: "RSC-005",
          severity: "ERROR",
          message: "Invalid XHTML",
          additionalLocations: 8,
          locations: [
            { path: "OPS/chapter.xhtml", line: 12, column: 3, context: "<p>broken</p>" },
            { path: "book.epub", line: undefined, column: undefined },
          ],
          suggestion: "Check the markup",
        },
      ],
    });
  });
  it.each([
    null,
    [],
    {},
    { checker: {}, messages: [] },
    { checker: fixture().checker, messages: null },
  ])("rejects unsupported report structures: %o", (value) => {
    expect(() => parseEpubCheckJson(JSON.stringify(value))).toThrow();
  });
  it.each([-1, 0.5, "2", null, 1e100])("rejects invalid counter values: %s", (value) => {
    const report = fixture();
    Object.assign(report.checker, { nError: value });
    expect(() => parseEpubCheckJson(JSON.stringify(report))).toThrow("count");
  });
  it.each([
    { severity: "unknown" },
    { locations: null },
    { ID: 3 },
    { message: null },
    { additionalLocations: -1 },
    { locations: [{ path: 5 }] },
    { locations: [{ path: "a.xhtml", line: -2 }] },
  ])("rejects invalid diagnostic fields: %o", (value) => {
    const report = fixture();
    Object.assign(report.messages[0]!, value);
    expect(() => parseEpubCheckJson(JSON.stringify(report))).toThrow();
  });
  it("accepts all documented severity levels and missing optional location data", () => {
    const report = {
      checker: fixture().checker,
      messages: ["FATAL", "ERROR", "WARNING", "INFO", "USAGE"].map((severity) => ({
        ID: "TEST",
        severity,
        message: "Data",
        locations: [{ path: "a.xhtml" }],
      })),
    };
    expect(
      parseEpubCheckJson(JSON.stringify(report)).messages.map((message) => message.severity)
    ).toEqual(["FATAL", "ERROR", "WARNING", "INFO", "USAGE"]);
  });
  it("rejects malformed JSON without interpreting it as instructions", () => {
    expect(() => parseEpubCheckJson("not JSON")).toThrow();
  });
});

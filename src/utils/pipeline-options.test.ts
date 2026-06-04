import { describe, expect, it } from "vitest";
import { resolvePipelineOptions } from "./pipeline-options.js";

describe("resolvePipelineOptions", () => {
  it("keeps the balanced preset generic and conservative", () => {
    expect(resolvePipelineOptions({ preset: "balanced" })).toEqual({
      preset: "balanced",
      authorWorkflow: false,
      repair: false,
      convertPng: true,
      lazyLoading: false,
      maxImageDim: 1600,
      lossless: false,
    });
  });

  it("makes the author preset run the complete author workflow", () => {
    expect(resolvePipelineOptions({ preset: "author" })).toMatchObject({
      authorWorkflow: true,
      repair: true,
      lazyLoading: true,
      lossless: false,
    });
  });

  it("disables lossy image transformations in lossless mode", () => {
    expect(resolvePipelineOptions({ preset: "lossless" })).toMatchObject({
      convertPng: false,
      maxImageDim: 0,
      lossless: true,
    });
  });
});

import { describe, expect, it } from "vitest";
import { resolvePipelineOptions } from "./pipeline-options.js";

describe("resolvePipelineOptions", () => {
  it("keeps the balanced preset generic and conservative", () => {
    expect(resolvePipelineOptions({ preset: "balanced" })).toEqual({
      preset: "balanced",
      authorWorkflow: false,
      repair: false,
      convertPng: true,
      convertWebp: false,
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
      convertWebp: false,
      maxImageDim: 0,
      lossless: true,
    });
  });

  it("makes WebP conversion opt-in for every preset and refuses it in lossless mode", () => {
    expect(resolvePipelineOptions({ preset: "author" }).convertWebp).toBe(false);
    expect(resolvePipelineOptions({ preset: "balanced", convertWebp: true }).convertWebp).toBe(
      true
    );
    expect(() => resolvePipelineOptions({ preset: "lossless", convertWebp: true })).toThrow(
      "--convert-webp cannot be combined with the lossless preset."
    );
  });
});

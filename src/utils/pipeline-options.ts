import type { Args, Preset } from "../types.js";

interface RawPipelineOptions {
  preset: Preset;
  authorWorkflow?: boolean;
  repair?: boolean;
  convertPng?: boolean;
  lazyLoading?: boolean;
  maxImageDim?: number;
  pngBackground?: string;
  doctor?: boolean;
  inspect?: boolean;
}

export interface ResolvedPipelineOptions {
  preset: Preset;
  authorWorkflow: boolean;
  repair: boolean;
  convertPng: boolean;
  lazyLoading: boolean;
  maxImageDim: number;
  lossless: boolean;
  pngBackground?: string;
}

/** An explicit opaque color; reject conflicting modes instead of silently ignoring it. */
export function resolvePngBackground(options: {
  pngBackground?: unknown;
  preset?: Preset;
  lossless?: boolean;
  convertPng?: boolean;
  doctor?: boolean;
  inspect?: boolean;
}): string | undefined {
  const color = options.pngBackground;
  if (color === undefined) return undefined;
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("--png-background must be an opaque color in #RRGGBB format.");
  if (options.lossless || options.preset === "lossless")
    throw new Error("--png-background cannot be combined with the lossless preset.");
  if (options.convertPng === false)
    throw new Error("--png-background requires PNG-to-JPEG conversion; remove --no-convert-png.");
  if (options.doctor || options.inspect)
    throw new Error("--png-background is for optimization only, not doctor mode.");
  return color.toLowerCase();
}

export function resolvePipelineOptions(options: RawPipelineOptions): ResolvedPipelineOptions {
  const authorWorkflow = options.authorWorkflow === true || options.preset === "author";
  const lossless = options.preset === "lossless";
  const pngBackground = resolvePngBackground(options);

  return {
    preset: options.preset,
    authorWorkflow,
    repair: options.repair === true || authorWorkflow,
    convertPng: options.convertPng ?? !lossless,
    lazyLoading: options.lazyLoading ?? authorWorkflow,
    maxImageDim: options.maxImageDim ?? (lossless ? 0 : 1600),
    lossless,
    ...(pngBackground === undefined ? {} : { pngBackground }),
  };
}

export function applyPipelineOptions(args: Args): Args {
  const resolved = resolvePipelineOptions(args);
  return {
    ...args,
    "author-workflow": resolved.authorWorkflow,
    authorWorkflow: resolved.authorWorkflow,
    repair: resolved.repair,
    "convert-png": resolved.convertPng,
    convertPng: resolved.convertPng,
    "lazy-loading": resolved.lazyLoading,
    lazyLoading: resolved.lazyLoading,
    "max-image-dim": resolved.maxImageDim,
    maxImageDim: resolved.maxImageDim,
    lossless: resolved.lossless,
    ...(resolved.pngBackground === undefined
      ? {}
      : { pngBackground: resolved.pngBackground, "png-background": resolved.pngBackground }),
  };
}

import type { Args, Preset } from "../types.js";

interface RawPipelineOptions {
  preset: Preset;
  authorWorkflow?: boolean;
  repair?: boolean;
  convertPng?: boolean;
  lazyLoading?: boolean;
  maxImageDim?: number;
}

export interface ResolvedPipelineOptions {
  preset: Preset;
  authorWorkflow: boolean;
  repair: boolean;
  convertPng: boolean;
  lazyLoading: boolean;
  maxImageDim: number;
  lossless: boolean;
}

export function resolvePipelineOptions(options: RawPipelineOptions): ResolvedPipelineOptions {
  const authorWorkflow = options.authorWorkflow === true || options.preset === "author";
  const lossless = options.preset === "lossless";

  return {
    preset: options.preset,
    authorWorkflow,
    repair: options.repair === true || authorWorkflow,
    convertPng: options.convertPng ?? !lossless,
    lazyLoading: options.lazyLoading ?? authorWorkflow,
    maxImageDim: options.maxImageDim ?? (lossless ? 0 : 1600),
    lossless,
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
  };
}

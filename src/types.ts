export type Preset = "balanced" | "lossless" | "author";

export interface Args {
  input: string;
  batch?: string;
  /** Maximum concurrent books in batch mode; defaults to 1. */
  jobs?: number;
  storage?: string;
  storagePlan?: string;
  applyStoragePlan?: string;
  keepRevisions?: number;
  watch?: string;
  watchSettleMs?: number;
  outputDir?: string;
  output: string;
  temp: string;
  clean: boolean;
  "jpg-quality": number;
  jpgQuality: number;
  "png-quality": number;
  pngQuality: number;
  /** Minimum SSIM for lossy image re-encodes; 0 disables. Defaults to 0.85 when omitted. */
  "min-image-ssim"?: number;
  minImageSsim?: number;
  /** Optional opaque #RRGGBB background for eligible PNG-to-JPEG conversion. */
  pngBackground?: string;
  "png-background"?: string;
  fonts: boolean;
  "author-workflow": boolean;
  authorWorkflow: boolean;
  "author-config"?: string;
  authorConfig?: string;
  repair: boolean;
  strict: boolean;
  validationTimeout?: number;
  imageConcurrency?: number;
  profile: boolean;
  preset: Preset;
  "report-json"?: string;
  reportJson?: string;
  "report-html"?: string;
  reportHtml?: string;
  doctor: boolean;
  inspect: boolean;
  "max-image-dim": number;
  maxImageDim: number;
  "convert-png": boolean;
  convertPng: boolean;
  /** Opt-in conversion of PNG/JPEG images to WebP (EPUB 3 only). */
  "convert-webp"?: boolean;
  convertWebp?: boolean;
  "lazy-loading": boolean;
  lazyLoading: boolean;
  lossless: boolean;
  lang: string;
  _: (string | number)[];
  $0: string;
}

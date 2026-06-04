export type Preset = "balanced" | "lossless" | "author";

export interface Args {
  input: string;
  output: string;
  temp: string;
  clean: boolean;
  "jpg-quality": number;
  jpgQuality: number;
  "png-quality": number;
  pngQuality: number;
  fonts: boolean;
  "author-workflow": boolean;
  authorWorkflow: boolean;
  repair: boolean;
  strict: boolean;
  profile: boolean;
  preset: Preset;
  "report-json"?: string;
  reportJson?: string;
  "max-image-dim": number;
  maxImageDim: number;
  "convert-png": boolean;
  convertPng: boolean;
  "lazy-loading": boolean;
  lazyLoading: boolean;
  lossless: boolean;
  lang: string;
  _: (string | number)[];
  $0: string;
}

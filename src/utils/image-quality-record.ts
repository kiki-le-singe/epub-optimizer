// Public report types only: no Node.js or sharp types, so API consumers can
// type-check reports without installing @types/node.
export type ImageQualityOutcome = "accepted" | "fallback" | "kept-original";

/** Visual similarity of one lossy image transformation, as recorded in run reports. */
export interface ImageQualityRecord {
  /** Path relative to the extracted EPUB root, with forward slashes. */
  path: string;
  /** Lossy step that produced the encode: in-place recompression or PNG-to-JPEG conversion. */
  operation: "recompress" | "png-to-jpeg";
  /** Output path when the image was converted to another format. */
  convertedTo?: string;
  /** SSIM of the encode that was kept, or of the best rejected encode. */
  ssim: number;
  outcome: ImageQualityOutcome;
}

import fs from "fs-extra";
import path from "node:path";
import * as cheerio from "cheerio";
import { getOPFPath, parseOPF } from "./epub-utils.js";

/**
 * XML Encryption algorithm URIs used for EPUB *font obfuscation* (not DRM).
 * These scramble embedded fonts so they only render inside their own book; the
 * rest of the publication is plain and safe to optimize.
 */
const FONT_OBFUSCATION_ALGORITHMS = new Set([
  "http://www.idpf.org/2008/embedding", // IDPF / EPUB font obfuscation
  "http://ns.adobe.com/pdf/enc#RC", // Adobe font obfuscation
]);

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".woff", ".woff2", ".ttc", ".dfont"]);

function isFontHref(href: string): boolean {
  const clean = href.split(/[?#]/, 1)[0] ?? href;
  const dot = clean.lastIndexOf(".");
  return dot >= 0 && FONT_EXTENSIONS.has(clean.slice(dot).toLowerCase());
}

/**
 * - `none`: no `META-INF/encryption.xml`.
 * - `obfuscation`: every encrypted entry uses a known font-obfuscation
 *   algorithm — safe to optimize everything else, leave the fonts untouched.
 * - `drm`: real content encryption (or an unrecognized scheme) — refuse, since
 *   re-encoding/repacking would corrupt protected resources.
 */
export type EncryptionKind = "none" | "obfuscation" | "drm";

export interface EpubFeatures {
  encryptionKind: EncryptionKind;
  /** Resource URIs listed in encryption.xml (decoded, as written). */
  encryptedHrefs: string[];
  /** True when the package declares a pre-paginated (fixed-layout) rendition. */
  fixedLayout: boolean;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Reads `META-INF/encryption.xml` (if any) and classifies it. */
async function detectEncryption(
  epubDir: string
): Promise<{ kind: EncryptionKind; hrefs: string[] }> {
  const encPath = path.join(epubDir, "META-INF", "encryption.xml");
  if (!(await fs.pathExists(encPath))) {
    return { kind: "none", hrefs: [] };
  }

  let $: cheerio.CheerioAPI;
  try {
    const content = await fs.readFile(encPath, "utf-8");
    $ = cheerio.load(content, { xmlMode: true });
  } catch {
    // Present but unreadable/malformed → treat as encrypted and refuse.
    return { kind: "drm", hrefs: [] };
  }

  // Attribute selectors are prefix-agnostic (`enc:EncryptionMethod` and
  // `EncryptionMethod` both carry an `Algorithm` attribute), so we avoid the
  // XML-namespace-prefix matching problem entirely.
  const algorithms: string[] = [];
  $("[Algorithm]").each((_, el) => {
    const algorithm = $(el).attr("Algorithm");
    if (algorithm) algorithms.push(algorithm);
  });

  const hrefs: string[] = [];
  $("[URI]").each((_, el) => {
    const uri = $(el).attr("URI");
    if (uri) hrefs.push(safeDecodeURIComponent(uri));
  });

  // encryption.xml exists but we couldn't read any algorithm or resource → be
  // conservative and treat it as DRM rather than risk corrupting content.
  if (algorithms.length === 0 && hrefs.length === 0) {
    return { kind: "drm", hrefs };
  }

  // Font obfuscation is safe to skip-and-optimize-the-rest. We classify it as
  // obfuscation when every encrypted entry is either a known obfuscation
  // algorithm OR a font file (covers producers like Pages that encrypt only the
  // embedded fonts). Anything else encrypted means real content DRM → refuse.
  const allObfuscationAlgorithms =
    algorithms.length > 0 && algorithms.every((a) => FONT_OBFUSCATION_ALGORITHMS.has(a));
  const allEncryptedAreFonts = hrefs.length > 0 && hrefs.every(isFontHref);

  if (allObfuscationAlgorithms || allEncryptedAreFonts) {
    return { kind: "obfuscation", hrefs };
  }
  return { kind: "drm", hrefs };
}

/** Reads the OPF and detects a pre-paginated (fixed-layout) rendition. */
async function detectFixedLayout(epubDir: string): Promise<boolean> {
  try {
    const opfPath = await getOPFPath(epubDir);
    const $ = await parseOPF(opfPath);

    // EPUB3 global rendition: <meta property="rendition:layout">pre-paginated</meta>
    const globalLayout = $('meta[property="rendition:layout"]').first().text().trim().toLowerCase();
    if (globalLayout === "pre-paginated") {
      return true;
    }

    // Per-spine override: <itemref properties="rendition:layout-pre-paginated"/>
    return $('itemref[properties~="rendition:layout-pre-paginated"]').length > 0;
  } catch {
    return false;
  }
}

/**
 * Inspects an extracted EPUB for shapes that need special handling before any
 * optimization runs: encrypted/DRM/obfuscated resources and fixed-layout.
 */
export async function detectEpubFeatures(epubDir: string): Promise<EpubFeatures> {
  const [encryption, fixedLayout] = await Promise.all([
    detectEncryption(epubDir),
    detectFixedLayout(epubDir),
  ]);

  return {
    encryptionKind: encryption.kind,
    encryptedHrefs: encryption.hrefs,
    fixedLayout,
  };
}

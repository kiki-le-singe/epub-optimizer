import type { CheerioAPI } from "cheerio";

/**
 * Keep NCX navigation metadata consistent with the actual depth-first document
 * order. Kindle relies on monotonically increasing playOrder values.
 */
export function normalizeNCXNavigation($: CheerioAPI): void {
  let maxDepth = 0;

  $("navMap navPoint").each((index, element) => {
    $(element).attr("playOrder", String(index + 1));
    maxDepth = Math.max(maxDepth, $(element).parents("navPoint").length + 1);
  });

  const depth = String(maxDepth);
  const depthMeta = $('meta[name="dtb:depth"]');
  if (depthMeta.length > 0) {
    depthMeta.attr("content", depth);
  } else {
    $("head").append(`<meta name="dtb:depth" content="${depth}"/>`);
  }
}

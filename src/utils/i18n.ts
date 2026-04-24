import config from "./config.js";

/**
 * Gets a localized label for the cover
 * @param lang Optional language override (e.g. from CLI); falls back to config
 */
export function getCoverLabel(lang?: string): string {
  const resolved = lang || config.lang || config.defaultLang;

  return config.labels?.[resolved as keyof typeof config.labels]?.cover;
}

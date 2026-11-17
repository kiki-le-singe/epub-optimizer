import { languages, type UiLanguage } from "../../src/ui/translations.js";

export const themes = ["system", "light-green", "light-blue", "dark-green", "dark-blue"] as const;
export type Theme = (typeof themes)[number];

export const preferences = {
  get(key: string): string | null {
    try {
      return localStorage.getItem("epub-optimizer-" + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem("epub-optimizer-" + key, value);
    } catch {
      /* Browser storage may be unavailable. */
    }
  },
};
export function initialLanguage(): UiLanguage {
  const saved = preferences.get("language");
  if (languages.includes(saved as UiLanguage)) return saved as UiLanguage;
  return (
    ((navigator.languages ?? [navigator.language])
      .map((value) => value.split("-")[0])
      .find((value) => languages.includes(value as UiLanguage)) as UiLanguage | undefined) ?? "en"
  );
}
export function initialTheme(): Theme {
  let saved = preferences.get("theme");
  if (saved === "light" || saved === "dark") saved += "-green";
  return themes.includes(saved as Theme) ? (saved as Theme) : "system";
}
export function applyTheme(theme: Theme, dark: boolean): void {
  const mode = theme === "system" ? (dark ? "dark" : "light") : theme.split("-")[0]!;
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.accent = theme.endsWith("-blue") ? "blue" : "green";
  document.documentElement.classList.toggle("dark", mode === "dark");
}

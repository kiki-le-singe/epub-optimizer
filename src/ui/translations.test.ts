import { expect, it } from "vitest";
import { languages, uiMessages } from "./translations.js";
import { uiHtml } from "./page.js";

it("provides every interface and error message in all five languages with matching placeholders", () => {
  const keys = Object.keys(uiMessages.fr).sort();
  expect(languages).toEqual(["fr", "en", "it", "es", "de"]);
  for (const language of languages) {
    expect(Object.keys(uiMessages[language]).sort()).toEqual(keys);
    for (const key of keys as (keyof typeof uiMessages.fr)[]) {
      expect(uiMessages[language][key].trim()).not.toBe("");
      expect(uiMessages[language][key].match(/\{\w+\}/g) ?? []).toEqual(
        uiMessages.fr[key].match(/\{\w+\}/g) ?? []
      );
    }
  }
});
it("bootstraps the React bundle using same-origin assets without inline scripts", () => {
  const html = uiHtml("a".repeat(64), 1024 * 1024);
  expect(html).toContain('id="root"');
  expect(html).toContain('type="module" src="/app.js"');
  expect(html).toContain('href="/app.css"');
  expect(html).not.toMatch(/<script[^>]*>[^<]+/);
  expect(html).not.toContain("https://");
});

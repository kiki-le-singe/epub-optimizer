import { describe, it, expect, vi } from "vitest";
import { getCoverLabel } from "./i18n.js";

// Create a proper mock for the config
vi.mock("./config.js", () => {
  return {
    default: {
      lang: "fr",
      defaultLang: "en",
      labels: {
        fr: {
          cover: "Couverture",
        },
        en: {
          cover: "Cover",
        },
      },
    },
  };
});

describe("i18n utilities", () => {
  describe("getCoverLabel", () => {
    it("should return the proper label based on config", () => {
      // We're using the mock values from above
      expect(getCoverLabel()).toBe("Couverture");
    });
  });
});

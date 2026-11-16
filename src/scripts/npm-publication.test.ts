import { expect, it } from "vitest";
import { validateNpmPublication } from "../../scripts/validate-npm-publication.js";
const sha = "a".repeat(40),
  digest = "sha256:" + "b".repeat(64);
const release = { tagName: "v3.15.0", isDraft: false, isPrerelease: false };
const record = {
  schema: 1 as const,
  version: "3.15.0",
  sha,
  image: "ghcr.io/kiki-le-singe/epub-optimizer",
  digest,
  platforms: { amd64: digest, arm64: digest },
};
it("accepts only a published stable release bound to its tested source", () => {
  expect(() =>
    validateNpmPublication("v3.15.0", sha, "3.15.0", release, "v3.15.0", record)
  ).not.toThrow();
});
it.each([{ isDraft: true }, { isPrerelease: true }, { tagName: "v3.14.0" }])(
  "refuses invalid releases %j",
  (change) => {
    expect(() =>
      validateNpmPublication("v3.15.0", sha, "3.15.0", { ...release, ...change }, "v3.15.0", record)
    ).toThrow("latest published");
  }
);
it("refuses older versions, changed tags and mismatched image records", () => {
  expect(() =>
    validateNpmPublication("v3.15.0", sha, "3.15.0", release, "v3.16.0", record)
  ).toThrow();
  expect(() =>
    validateNpmPublication("v3.15.1", sha, "3.15.0", release, "v3.15.0", record)
  ).toThrow();
  expect(() =>
    validateNpmPublication("v3.15.0", sha, "3.15.0", release, "v3.15.0", {
      ...record,
      sha: "c".repeat(40),
    })
  ).toThrow();
});

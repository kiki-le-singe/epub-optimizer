import { expect, it } from "vitest";
import { dockerHubPlan } from "../../scripts/dockerhub-plan.js";
const sha = "a".repeat(40),
  digest = `sha256:${"b".repeat(64)}`;
const release = { tagName: "v3.16.1", isDraft: false, isPrerelease: false };
const record = {
  schema: 1 as const,
  version: "3.16.1",
  sha,
  image: "ghcr.io/kiki-le-singe/epub-optimizer",
  digest,
  platforms: { amd64: digest, arm64: digest },
};
const plan = (changes: Partial<typeof record> = {}, target = "example/epub-optimizer") =>
  dockerHubPlan("v3.16.1", sha, "v3.16.1", release, { ...record, ...changes }, target);
it("copies a released digest without selecting an architecture or rebuilding", () => {
  expect(plan()).toEqual({
    source: `${record.image}@${digest}`,
    digest,
    version: "3.16.1",
    target: "example/epub-optimizer",
  });
});
it.each([
  "",
  "docker.io/example/epub-optimizer",
  "example/other",
  "../epub-optimizer",
  "Example/epub-optimizer",
])("refuses an unsafe or unintended destination %s", (target) => {
  expect(() => plan({}, target)).toThrow("target");
});
it("rejects older releases, drafts and prereleases before copying", () => {
  expect(() =>
    dockerHubPlan("v3.16.1", sha, "v3.17.0", release, record, "example/epub-optimizer")
  ).toThrow("latest");
  for (const change of [{ isDraft: true }, { isPrerelease: true }])
    expect(() =>
      dockerHubPlan(
        "v3.16.1",
        sha,
        "v3.16.1",
        { ...release, ...change },
        record,
        "example/epub-optimizer"
      )
    ).toThrow("latest");
});
it("rejects source substitutions and missing platform records", () => {
  expect(() => plan({ sha: "c".repeat(40) })).toThrow("record");
  expect(() => plan({ image: "ghcr.io/other/image" })).toThrow("record");
  expect(() => plan({ digest: "invalid" })).toThrow("digest");
  expect(() => plan({ platforms: { amd64: digest } as typeof record.platforms })).toThrow("AMD64");
});

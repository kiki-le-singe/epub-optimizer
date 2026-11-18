import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readReleaseExamples,
  RELEASE_EXAMPLE_RULES,
  updateReleaseExamples,
} from "../../scripts/release-examples.js";

const names = [...new Set(RELEASE_EXAMPLE_RULES.map((rule) => rule.file))];
const repository = () =>
  Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.resolve(name), "utf8")]));
const next = "sha256:" + "a".repeat(64);

describe("release examples", () => {
  it("names one release and one tested digest across Compose, the setup helper and the guides", () => {
    const { versions, digests } = readReleaseExamples(repository());
    expect(versions).toHaveLength(1);
    expect(digests).toHaveLength(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("moves every reference to a new release and leaves the rest of each file alone", () => {
    const before = repository();
    const { versions, digests } = readReleaseExamples(before);
    const after = updateReleaseExamples(before, "9.8.7", next);

    expect(readReleaseExamples(after)).toEqual({ versions: ["9.8.7"], digests: [next] });
    expect(after["compose.watch.yaml"]).toContain(
      "${EPUB_OPTIMIZER_DOCKER_IMAGE:-ghcr.io/kiki-le-singe/epub-optimizer:9.8.7@" + next + "}"
    );
    expect(after["scripts/setup-watch.sh"]).toContain(
      "EPUB_OPTIMIZER_DOCKER_IMAGE=ghcr.io/kiki-le-singe/epub-optimizer:9.8.7@" + next + "'"
    );
    for (const name of names) {
      // Only the old version and digest may differ: restoring them gives the original file.
      expect(
        after[name]!.replaceAll("9.8.7", versions[0]!).replaceAll(next, digests[0]!),
        name
      ).toBe(before[name]);
      // Statements about when a feature appeared are not release examples.
      expect(after[name]).not.toMatch(/from version 9\.8\.7|before 9\.8\.7/);
    }
    expect(updateReleaseExamples(after, "9.8.7", next)).toEqual(after);
  });

  it("refuses prereleases, malformed digests and documentation it no longer recognizes", () => {
    const files = repository();
    expect(() => updateReleaseExamples(files, "3.20.0-rc.1", next)).toThrow("stable version");
    expect(() => updateReleaseExamples(files, "3.20.0", "sha256:abc")).toThrow("index digest");
    expect(() => updateReleaseExamples(files, "3.20.0", "latest")).toThrow("index digest");
    expect(() =>
      updateReleaseExamples({ ...files, "docs/DOCKERHUB.md": "reworded" }, "3.20.0", next)
    ).toThrow(/No release reference .* in docs\/DOCKERHUB\.md/);
  });
});

// @ts-expect-error Native Node TypeScript requires the source extension.
import { assertVersion, validateRecord, type ImageRecord } from "./release-helpers.ts";

/** Refuse drafts, older releases and source/package mismatches before npm publication. */
export function validateNpmPublication(
  tag: string,
  sha: string,
  version: string,
  release: { tagName: string; isDraft: boolean; isPrerelease: boolean },
  latestTag: string,
  record: ImageRecord
): void {
  assertVersion(version, false);
  if (tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid npm tag/source binding.");
  if (release.tagName !== tag || release.isDraft || release.isPrerelease || latestTag !== tag)
    throw new Error("npm publication requires the latest published stable GitHub release.");
  validateRecord(record, version, sha, "ghcr.io/kiki-le-singe/epub-optimizer");
}

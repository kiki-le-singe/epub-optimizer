// @ts-expect-error Native Node TypeScript requires the source extension.
import { assertVersion, validateRecord, type ImageRecord } from "./release-helpers.ts";

export function dockerHubPlan(
  tag: string,
  sha: string,
  latestTag: string,
  release: { tagName: string; isDraft: boolean; isPrerelease: boolean },
  record: ImageRecord,
  target: string
): { source: string; version: string; target: string; digest: string } {
  const version = tag.replace(/^v/, "");
  assertVersion(version, false);
  if (tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid Docker Hub release tag/source.");
  if (release.tagName !== tag || release.isDraft || release.isPrerelease || latestTag !== tag)
    throw new Error("Docker Hub mirroring requires the latest published stable release.");
  if (!/^[a-z0-9][a-z0-9_-]{1,38}\/epub-optimizer$/.test(target))
    throw new Error("Docker Hub target must be an explicit namespace/epub-optimizer repository.");
  validateRecord(record, version, sha, "ghcr.io/kiki-le-singe/epub-optimizer");
  return { source: `${record.image}@${record.digest}`, version, target, digest: record.digest };
}

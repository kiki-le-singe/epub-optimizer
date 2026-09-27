export interface ImageRecord {
  schema: 1;
  version: string;
  sha: string;
  image: string;
  digest: string;
  platforms: Record<string, string>;
}

export function assertVersion(version: string, prerelease?: boolean): void {
  const number = "(?:0|[1-9][0-9]*)";
  if (
    !new RegExp(`^${number}\\.${number}\\.${number}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(
      version
    )
  ) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const suffix = version.split("-").slice(1).join("-");
  if (suffix.split(".").some((part) => /^0[0-9]+$/.test(part)))
    throw new Error("Invalid numeric prerelease identifier.");
  if (prerelease !== undefined && version.includes("-") !== prerelease) {
    throw new Error("The prerelease flag must match the package.json version suffix.");
  }
}

export function assertDigest(digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid image digest.");
}

export function validateRecord(
  record: ImageRecord,
  version: string,
  sha: string,
  image: string
): void {
  if (
    record.schema !== 1 ||
    record.version !== version ||
    record.sha !== sha ||
    record.image !== image
  ) {
    throw new Error("Release image record does not match the version, commit and repository.");
  }
  assertDigest(record.digest);
  if (Object.keys(record.platforms).sort().join(",") !== "amd64,arm64") {
    throw new Error("Both tested AMD64 and ARM64 image digests are required.");
  }
  Object.values(record.platforms).forEach(assertDigest);
}

export function parseRemoteTag(status: number | null, stdout: string): string | undefined {
  if (status === 2) return undefined;
  if (status !== 0) throw new Error("Cannot verify the remote tag; check network/authentication.");
  const lines = stdout.trim().split("\n");
  const line = lines.find((entry) => entry.endsWith("^{}")) ?? lines[0];
  const sha = line?.split(/\s+/)[0];
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid remote tag response.");
  return sha;
}

export function compareVersions(candidate: string, previous: string): number {
  assertVersion(candidate);
  assertVersion(previous);
  const parts = (version: string) => {
    const dash = version.indexOf("-");
    return {
      core: (dash < 0 ? version : version.slice(0, dash)).split(".").map(BigInt),
      pre: dash < 0 ? [] : version.slice(dash + 1).split("."),
    };
  };
  const left = parts(candidate);
  const right = parts(previous);
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index])
      return left.core[index]! > right.core[index]! ? 1 : -1;
  }
  if (!left.pre.length || !right.pre.length)
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function stableVersionAtLeast(candidate: string, previous: string): boolean {
  assertVersion(candidate, false);
  assertVersion(previous, false);
  return compareVersions(candidate, previous) >= 0;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = String.raw`\d+\.\d+\.\d+`;
const DIGEST = "sha256:[0-9a-f]{64}";

interface Rule {
  file: string;
  /** Text before the version; the version (and digest, when pinned) follows it. */
  before: string;
  /** Text after the version or digest. */
  after: string;
  /** The reference also carries the tested index digest. */
  pinned?: boolean;
}

/**
 * Every place that names the current stable release. A rule that matches
 * nothing is an error, so reworded documentation cannot silently stop being
 * updated.
 */
export const RELEASE_EXAMPLE_RULES: readonly Rule[] = [
  {
    file: "compose.watch.yaml",
    before: "ghcr.io/kiki-le-singe/epub-optimizer:",
    after: "}",
    pinned: true,
  },
  {
    file: "scripts/setup-watch.sh",
    before: "EPUB_OPTIMIZER_DOCKER_IMAGE=ghcr.io/kiki-le-singe/epub-optimizer:",
    after: "'",
    pinned: true,
  },
  {
    file: "docs/NAS.md",
    before: "EPUB_OPTIMIZER_DOCKER_IMAGE=docker.io/boopykiki/epub-optimizer:",
    after: "\n",
    pinned: true,
  },
  { file: "docs/NAS.md", before: "pin release ", after: " " },
  { file: "docs/DOCKERHUB.md", before: "`v", after: "`). It uses Skopeo" },
  { file: "README.md", before: "  boopykiki/epub-optimizer:", after: " \\" },
  { file: "README.md", before: "(`ghcr.io/kiki-le-singe/epub-optimizer:", after: "`). Both" },
  { file: "docs/WATCH.md", before: "using the published ", after: " image" },
  { file: "docs/WATCH.md", before: "pin the published ", after: " release" },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = (rule: Rule) =>
  new RegExp(
    `(${escape(rule.before)})(${VERSION})${rule.pinned ? `@(${DIGEST})` : ""}(?=${escape(rule.after)})`,
    "g"
  );

export function assertReleaseTarget(version: string, digest: string): void {
  if (!new RegExp(`^${VERSION}$`).test(version))
    throw new Error("Expected a stable version such as 3.19.0.");
  if (!new RegExp(`^${DIGEST}$`).test(digest))
    throw new Error("Expected the tested index digest: sha256 followed by 64 hex characters.");
}

/** Versions and digests currently named by the rules, for consistency checks. */
export function readReleaseExamples(files: Readonly<Record<string, string>>): {
  versions: string[];
  digests: string[];
} {
  const versions = new Set<string>();
  const digests = new Set<string>();
  for (const rule of RELEASE_EXAMPLE_RULES) {
    const content = files[rule.file];
    const matches = content === undefined ? [] : [...content.matchAll(pattern(rule))];
    if (matches.length === 0)
      throw new Error(
        `No release reference "${rule.before}<version>" in ${rule.file}; update scripts/release-examples.ts.`
      );
    for (const match of matches) {
      versions.add(match[2]!);
      if (rule.pinned) digests.add(match[3]!);
    }
  }
  return { versions: [...versions].sort(), digests: [...digests].sort() };
}

/** Returns the files with every release reference set to `version` and `digest`. */
export function updateReleaseExamples(
  files: Readonly<Record<string, string>>,
  version: string,
  digest: string
): Record<string, string> {
  assertReleaseTarget(version, digest);
  readReleaseExamples(files);
  const updated: Record<string, string> = { ...files };
  for (const rule of RELEASE_EXAMPLE_RULES)
    updated[rule.file] = updated[rule.file]!.replace(
      pattern(rule),
      (_match, before: string) => before + version + (rule.pinned ? `@${digest}` : "")
    );
  return updated;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [version, digest] = process.argv.slice(2);
  if (!version || !digest)
    throw new Error(
      "Usage: pnpm release:examples <version> <index digest from the release's release-image.json>"
    );
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const names = [...new Set(RELEASE_EXAMPLE_RULES.map((rule) => rule.file))];
  const files = Object.fromEntries(
    names.map((name) => [name, fs.readFileSync(path.join(repoRoot, name), "utf8")])
  );
  const updated = updateReleaseExamples(files, version, digest);
  for (const name of names) {
    if (updated[name] === files[name]) continue;
    fs.writeFileSync(path.join(repoRoot, name), updated[name]!);
    console.log(`Updated ${name}`);
  }
  console.log(`Release examples name ${version} at ${digest}.`);
}

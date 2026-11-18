import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const documents = [
  "README.md",
  ...fs
    .readdirSync("docs")
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

/** Lines outside fenced code blocks, where headings and links are real. */
function prose(file: string): string[] {
  let fenced = false;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    });
}

/** GitHub's heading anchor: lower case, punctuation removed, spaces as hyphens. */
function anchor(heading: string): string {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replaceAll(" ", "-");
}

function anchors(file: string): Set<string> {
  return new Set(
    prose(file).flatMap((line) => {
      const heading = /^#{1,6} (.+?)\s*$/.exec(line);
      return heading ? [anchor(heading[1]!)] : [];
    })
  );
}

it("keeps every relative link and heading anchor in the documentation resolvable", () => {
  const broken: string[] = [];
  for (const file of documents) {
    for (const line of prose(file)) {
      for (const match of line.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [relative, fragment] = target.split("#") as [string, string | undefined];
        const destination = relative === "" ? file : path.join(path.dirname(file), relative);
        if (!fs.existsSync(destination)) broken.push(`${file}: ${target} (missing file)`);
        else if (fragment && destination.endsWith(".md") && !anchors(destination).has(fragment))
          broken.push(`${file}: ${target} (missing heading)`);
      }
    }
  }
  expect(broken).toEqual([]);
});

it("keeps the README an overview that points to the detailed guides", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  for (const guide of ["CLI", "REPORTS", "WATCH", "DOCKER", "DEVELOPMENT", "LOCAL-UI", "NAS"])
    expect(readme, guide).toContain(`(docs/${guide}.md)`);
  expect(readme.split("\n").length).toBeLessThan(700);
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertVersion,
  compareVersions,
  parseRemoteTag,
  validateRecord,
} from "../../scripts/release-helpers.js";
import { scanFailures } from "../../scripts/check-image-scan.js";
import { saveDiagnostics } from "../../scripts/ci-diagnostics.js";

const sha = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const amd64 = "sha256:" + "c".repeat(64);
const arm64 = "sha256:" + "d".repeat(64);
const image = "ghcr.io/example/epub";
const record = {
  schema: 1 as const,
  version: "3.7.0",
  sha,
  image,
  digest,
  platforms: { amd64, arm64 },
};
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function fixture(overrides: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-release-test-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const state = {
    sha,
    digest,
    amd64,
    arm64,
    record,
    draft: true,
    tag: sha,
    version: "3.7.0",
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: state.version }));
  const stub = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const s = JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STATE));
const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify([cmd,...args])+'\\n');
const write = x => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
if(cmd === 'git') {
 if(args[0] === 'ls-remote') { if(s.remoteError) process.exit(128); if(!s.tag) process.exit(2); write(s.tag+'\\trefs/tags/v'+s.version+'^{}\\n'); }
 if(args[0] === 'rev-parse') write(args[1]==='origin/develop' && s.sync ? 'e'.repeat(40) : s.sha);
 if(args[0] === 'merge-base') { if(s.sync && args[3]==='e'.repeat(40)) process.exit(1); if(s.diverged && args[2]==='e'.repeat(40)) process.exit(1); process.exit(0); }
 if(args[0] === 'push' && s.rejectPush) process.exit(1);
} else if(cmd === 'gh') {
 if(args[0] === 'api') {
  const endpoint = args.find(x=>x.startsWith('repos/'));
  if(endpoint.includes('/releases/assets/')) write(s.record);
  else if(endpoint.includes('/releases?')) {
   const releases = s.noRelease ? [] : [{id:1,tag_name:'v'+s.version,draft:s.draft,prerelease:s.version.includes('-'),assets:s.noRecord?[]:[{id:1,name:'release-image.json'}],html_url:'https://example.test/release'}];
   if(s.newer) releases.push({id:2,tag_name:'v4.0.0',draft:false,prerelease:false,assets:[]});
   write([releases]);
  } else if(endpoint.includes('/pulls?')) write(s.existingPR ? [{html_url:'https://example.test/pr/8',number:8}] : []);
  else if(endpoint.endsWith('/pulls')) write({html_url:'https://example.test/pr/8',number:8});
  else throw new Error('Unexpected API request: '+endpoint);
 }
} else if(cmd === 'docker') {
 if(args.includes('inspect')) { const ref = args[3]; const current = ref.endsWith('@'+s.amd64) ? s.amd64 : ref.endsWith('@'+s.arm64) ? s.arm64 : s.digest;
 write({digest:current,manifests:(current===s.digest?[s.amd64,s.arm64]:[current]).map(digest=>({digest}))}); }
}
`;
  for (const cmd of ["git", "gh", "docker"])
    fs.writeFileSync(path.join(bin, cmd), stub, { mode: 0o755 });
  return (command: string) => {
    const log = path.join(dir, "calls.jsonl");
    fs.writeFileSync(log, "");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.resolve("scripts/release.ts"), command],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          GITHUB_REPOSITORY: "example/epub",
          GITHUB_REF: "refs/heads/main",
          GITHUB_OUTPUT: path.join(dir, "output"),
          GITHUB_STEP_SUMMARY: path.join(dir, "summary"),
          RELEASE_TAG: "v" + state.version,
          PRERELEASE: String(state.version.includes("-")),
          RELEASE_TEST_STATE: path.join(dir, "state.json"),
          RELEASE_TEST_LOG: log,
        },
      }
    );
    return { ...result, calls: fs.readFileSync(log, "utf8") };
  };
}

describe("release safety", { timeout: 20_000 }, () => {
  it("distinguishes absent tags from network failures and peels annotated tags", () => {
    expect(parseRemoteTag(2, "")).toBeUndefined();
    expect(() => parseRemoteTag(128, "")).toThrow("network/authentication");
    expect(
      parseRemoteTag(0, `${"e".repeat(40)}\trefs/tags/v3.7.0\n${sha}\trefs/tags/v3.7.0^{}`)
    ).toBe(sha);
  });
  it("validates versions, prerelease flags and numeric ordering", () => {
    expect(() => assertVersion("03.7.0")).toThrow();
    expect(() => assertVersion("3.7.0-rc.01")).toThrow();
    expect(() => assertVersion("3.7.0", true)).toThrow();
    expect(compareVersions("3.10.0", "3.9.0")).toBe(1);
    expect(compareVersions("3.7.0-rc.10", "3.7.0-rc.2")).toBe(1);
    expect(compareVersions("3.7.0-rc.2", "3.7.0")).toBe(-1);
  });
  it("requires both tested architectures and the exact source commit", () => {
    expect(() => validateRecord(record, "3.7.0", sha, image)).not.toThrow();
    expect(() => validateRecord({ ...record, sha: "e".repeat(40) }, "3.7.0", sha, image)).toThrow();
    expect(() =>
      validateRecord({ ...record, platforms: { amd64 } }, "3.7.0", sha, image)
    ).toThrow();
  });
  it("reuses a completed image record when planning a retry", () => {
    const result = fixture()("plan");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("build=false");
  });
  it("can resume after a tag was created but before a record was saved", () => {
    const result = fixture({ noRecord: true })("plan");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("build=true");
  });
  it("refuses a tag pointing at another commit without publishing anything", () => {
    const result = fixture({ tag: "f".repeat(40) })("plan");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different commit");
    expect(result.calls).not.toContain('"docker"');
  });
  it("preserves a draft's notes and image record on retry", () => {
    const result = fixture()("draft");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("preserving notes");
    expect(result.calls).not.toContain('"POST"');
    expect(result.calls).not.toContain('"create"');
  });
  it("refuses to promote an unpublished draft", () => {
    const result = fixture()("finalize");
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain('"docker"');
  });
  it("promotes a stable published release without rebuilding", () => {
    const result = fixture({ draft: false })("finalize");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(image + ":3.7.0");
    expect(result.calls).toContain(image + ":latest");
    expect(result.calls).not.toContain('"build"');
  });
  it("never moves latest backwards when finalizing an older release", () => {
    const result = fixture({ draft: false, newer: true })("finalize");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain(image + ":latest");
  });
  it("does not promote a prerelease to latest", () => {
    const result = fixture({
      version: "3.7.0-rc.1",
      draft: false,
      record: { ...record, version: "3.7.0-rc.1" },
    })("finalize");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain(image + ":latest");
  });
  it("fast-forwards develop and explicitly dispatches CI after a bot push", () => {
    const result = fixture({ draft: false, sync: true })("finalize");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`${sha}:refs/heads/develop`);
    expect(result.calls).toContain('"workflow","run","ci.yml","--ref","develop"');
    expect(result.calls).not.toContain('"POST"');
  });
  it.each([{ diverged: true }, { rejectPush: true }])(
    "opens a synchronization PR when a fast-forward is unavailable: %j",
    (options) => {
      const result = fixture({ draft: false, sync: true, ...options })("finalize");
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain('"POST","repos/example/epub/pulls"');
      expect(result.calls).toContain("pull-request=8");
    }
  );
  it("reuses a synchronization PR and dispatches checks for its merge ref", () => {
    const result = fixture({ draft: false, sync: true, diverged: true, existingPR: true })(
      "finalize"
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain('"POST"');
    expect(result.calls).toContain("pull-request=8");
  });
  it("fails closed when the remote tag cannot be checked", () => {
    const result = fixture({ remoteError: true })("plan");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("network/authentication");
  });
});

describe("CI diagnostics", () => {
  it("blocks fixable critical findings and rejects missing scan results", () => {
    expect(
      scanFailures({
        Results: [
          {
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-critical",
                PkgName: "java",
                Severity: "CRITICAL",
                FixedVersion: "17.1",
              },
              { VulnerabilityID: "CVE-unfixed", PkgName: "os", Severity: "CRITICAL" },
              { VulnerabilityID: "CVE-high", PkgName: "os", Severity: "HIGH", FixedVersion: "1" },
            ],
          },
        ],
      })
    ).toEqual(["CVE-critical: java (fixed in 17.1)"]);
    expect(() => scanFailures({})).toThrow();
  });
  it("exports generated JSON reports but not EPUB files or symlinks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-diagnostics-test-"));
    dirs.push(dir);
    const run = path.join(dir, "run");
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, "report.json"), '{"success":false}');
    fs.writeFileSync(path.join(run, "book.epub"), "book");
    fs.symlinkSync(path.join(run, "report.json"), path.join(run, "link.json"));
    const previous = process.env.EPUB_E2E_ARTIFACT_DIR;
    process.env.EPUB_E2E_ARTIFACT_DIR = path.join(dir, "out");
    try {
      await saveDiagnostics(run, "local");
      expect(fs.readdirSync(path.join(dir, "out", "local", "run"))).toEqual(["report.json"]);
    } finally {
      if (previous === undefined) delete process.env.EPUB_E2E_ARTIFACT_DIR;
      else process.env.EPUB_E2E_ARTIFACT_DIR = previous;
    }
  });
});

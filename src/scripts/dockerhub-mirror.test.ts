import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = "success") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-hub-test-"));
  dirs.push(dir);
  const manifests: Record<string, string> = {};
  const save = (value: unknown) => {
    const raw = JSON.stringify(value);
    const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    manifests[digest] = raw;
    return digest;
  };
  const amd64 = save({ manifests: [{ digest: `sha256:${"c".repeat(64)}` }] });
  const arm64 = save({ manifests: [{ digest: `sha256:${"d".repeat(64)}` }] });
  const digest = save({
    manifests: [{ digest: `sha256:${"c".repeat(64)}` }, { digest: `sha256:${"d".repeat(64)}` }],
  });
  const state = {
    mode,
    manifests,
    digest,
    sha: "a".repeat(40),
    record: {
      schema: 1,
      version: "3.16.1",
      sha: "a".repeat(40),
      image: "ghcr.io/kiki-le-singe/epub-optimizer",
      digest,
      platforms: { amd64, arm64 },
    },
  };
  const statePath = path.join(dir, "state.json"),
    logPath = path.join(dir, "calls.jsonl");
  fs.writeFileSync(statePath, JSON.stringify(state));
  const stub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const state = JSON.parse(fs.readFileSync(process.env.HUB_TEST_STATE));
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.HUB_TEST_LOG, JSON.stringify([name,...args])+'\\n');
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (name === 'git') { if (args[0] === 'rev-parse') out(state.sha); }
else if (name === 'gh') {
 if (args.includes('--jq')) out(state.mode==='newerAfterCopy' && state.copied ? 'v3.17.0':'v3.16.1');
 else if (args.includes('release')) out({tagName:'v3.16.1',isDraft:false,isPrerelease:false});
 else if (args.some(a=>a.includes('/assets/'))) out(state.record);
 else out({assets:[{id:1,name:'release-image.json'}]});
} else if (args[0] === 'copy') {
 if(state.mode==='copyFails') { process.stderr.write('copy interrupted'); process.exit(1); }
 state.copied=true;fs.writeFileSync(process.env.HUB_TEST_STATE,JSON.stringify(state));
} else {
 const ref=args[args.length-1];
 if(ref.includes('docker.io/') && !state.copied) {
  if(state.mode==='destinationMismatch') out('{}');
  else { process.stderr.write(state.mode==='authFailure'?'unauthorized':'manifest unknown'); process.exit(1); }
 } else if(state.mode==='sourceMismatch' && ref.includes('ghcr.io/') && ref.includes('@')) out('{}');
 else out(state.manifests[ref.includes('@')?ref.split('@')[1]:state.digest]);
}
`;
  for (const command of ["git", "gh", "skopeo"])
    fs.writeFileSync(path.join(dir, command), stub, { mode: 0o755 });
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", path.resolve("scripts/mirror-dockerhub.ts")],
    {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: "kiki-le-singe/epub-optimizer",
        DOCKERHUB_IMAGE: "example/epub-optimizer",
        RELEASE_TAG: "v3.16.1",
        HUB_TEST_STATE: statePath,
        HUB_TEST_LOG: logPath,
        GITHUB_STEP_SUMMARY: "",
      },
      encoding: "utf8",
      timeout: 20_000,
    }
  );
  const copies = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[])
    .filter((call) => call[0] === "skopeo" && call[1] === "copy");
  return { result, copies, digest };
}
it("mirrors the exact index with all architectures and verifies version and latest", () => {
  const { result, copies, digest } = fixture();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(copies).toHaveLength(2);
  for (const copy of copies)
    expect(copy.slice(2, 5)).toEqual([
      "--all",
      "--preserve-digests",
      `docker://ghcr.io/kiki-le-singe/epub-optimizer@${digest}`,
    ]);
  expect(copies[1]?.at(-1)).toBe("docker://docker.io/example/epub-optimizer:latest");
});
it.each(["sourceMismatch", "destinationMismatch", "authFailure"])(
  "blocks publication for %s",
  (mode) => {
    const { result, copies } = fixture(mode);
    expect(result.status).not.toBe(0);
    expect(copies).toHaveLength(0);
  }
);
it.each(["copyFails", "newerAfterCopy"])("leaves latest untouched after %s", (mode) => {
  const { result, copies } = fixture(mode);
  expect(result.status).not.toBe(0);
  expect(copies).toHaveLength(1);
  expect(copies[0]?.at(-1)).toBe("docker://docker.io/example/epub-optimizer:3.16.1");
});

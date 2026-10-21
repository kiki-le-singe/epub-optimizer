import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mergeCheckedPullRequest, prepareBranch } from "../../scripts/release-pr.js";

const repo = "example/epub";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergedSha = "c".repeat(40);
const options = {
  repo,
  branch: "codex/release-3.8.0",
  base: "main" as const,
  headSha,
  baseSha,
  title: "Prepare release v3.8.0",
  body: "Release preparation",
};

function coordinator(overrides: Record<string, unknown> = {}) {
  const pr = {
    number: 8,
    html_url: "https://example.test/pr/8",
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    head: { sha: headSha, ref: options.branch, repo: { full_name: repo } },
    base: { sha: baseSha, ref: "main", repo: { full_name: repo } },
  };
  const run = {
    id: 12,
    event: "pull_request",
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    pull_requests: [{ number: 8, head: { sha: headSha }, base: { sha: baseSha } }],
  };
  const state = {
    pr,
    runs: [run],
    existing: false,
    target: baseSha,
    jobs: [{ name: "Required CI", status: "completed", conclusion: "success" }],
    merged: true,
    ...overrides,
  };
  let time = 0;
  const request = vi.fn((method: string, endpoint: string, _body?: unknown): unknown => {
    if (endpoint.startsWith("pulls?")) return state.existing ? [pr] : [];
    if (method === "POST" && endpoint === "pulls") return pr;
    if (method === "PUT")
      return { merged: state.merged, sha: mergedSha, message: "Blocked by rules" };
    if (endpoint === "pulls/8") return state.pr;
    if (endpoint === "branches/main") return { commit: { sha: state.target } };
    if (endpoint.startsWith("actions/workflows/ci.yml/runs?")) return { workflow_runs: state.runs };
    if (endpoint.startsWith("actions/runs/"))
      return { total_count: state.jobs.length, jobs: state.jobs };
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  });
  const services = {
    request: request as <T>(method: string, endpoint: string, body?: unknown) => T,
    now: () => time,
    pause: async () => {
      time += 10;
    },
    timeoutMs: 20,
  };
  return {
    state,
    run,
    pr,
    request,
    services,
    merge: () => mergeCheckedPullRequest(options, services),
  };
}

describe("release PR checks", () => {
  it("waits for real PR CI, then merges only its exact head through GitHub", async () => {
    const ctx = coordinator();
    const completed = structuredClone(ctx.run);
    ctx.run.status = "queued";
    ctx.services.pause = async () => {
      ctx.state.runs = [completed];
    };
    await expect(ctx.merge()).resolves.toBe(mergedSha);
    expect(ctx.request).toHaveBeenCalledWith("PUT", "pulls/8/merge", {
      sha: headSha,
      merge_method: "merge",
    });
  });
  it("reuses an existing PR on retry", async () => {
    const ctx = coordinator({ existing: true });
    await ctx.merge();
    expect(ctx.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it.each(["failure", "cancelled", "skipped", "neutral", "action_required", null])(
    "does not merge when the final gate is %s",
    async (conclusion) => {
      const ctx = coordinator({ jobs: [{ name: "Required CI", status: "completed", conclusion }] });
      await expect(ctx.merge()).rejects.toThrow("Required CI");
      expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    }
  );
  it("rejects successful CI without the aggregate gate", async () => {
    await expect(coordinator({ jobs: [] }).merge()).rejects.toThrow("Required CI");
  });
  it.each(["workflow_dispatch", "push"])(
    "does not accept a %s run as PR validation",
    async (event) => {
      const ctx = coordinator();
      ctx.run.event = event;
      await expect(ctx.merge()).rejects.toThrow("Timed out");
      expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    }
  );
  it.each(["head", "base", "number", "association"])(
    "rejects CI for a different %s",
    async (field) => {
      const ctx = coordinator();
      if (field === "head") ctx.run.head_sha = "d".repeat(40);
      if (field === "base") ctx.run.pull_requests[0]!.base.sha = "d".repeat(40);
      if (field === "number") ctx.run.pull_requests[0]!.number = 9;
      if (field === "association") ctx.run.pull_requests = [];
      await expect(ctx.merge()).rejects.toThrow("Timed out");
      expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    }
  );
  it("does not hide a newer failed run behind an older success", async () => {
    const ctx = coordinator();
    ctx.state.runs.push({ ...ctx.run, id: 13, conclusion: "failure" });
    await expect(ctx.merge()).rejects.toThrow("CI failed");
  });
  it("stops if the target changes after successful CI", async () => {
    const ctx = coordinator();
    ctx.request.mockImplementation((method, endpoint) => {
      if (endpoint.startsWith("pulls?")) return [ctx.pr];
      if (endpoint === "pulls/8") return ctx.pr;
      if (endpoint === "branches/main") return { commit: { sha: ctx.state.target } };
      if (endpoint.startsWith("actions/workflows/")) return { workflow_runs: [ctx.run] };
      if (endpoint.startsWith("actions/runs/")) {
        ctx.state.target = "d".repeat(40);
        return { total_count: 1, jobs: ctx.state.jobs };
      }
      throw new Error(`Unexpected ${method} ${endpoint}`);
    });
    await expect(ctx.merge()).rejects.toThrow("main changed");
    expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("keeps a changed or conflicting PR open", async () => {
    for (const change of [
      { head: { ...coordinator().pr.head, sha: "d".repeat(40) } },
      { mergeable: false },
      { draft: true },
    ]) {
      const ctx = coordinator();
      Object.assign(ctx.pr, change);
      await expect(ctx.merge()).rejects.toThrow();
      expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    }
  });
  it("checks the source again before merging", async () => {
    const ctx = coordinator();
    await expect(
      mergeCheckedPullRequest(
        {
          ...options,
          beforeMerge: () => {
            throw new Error("develop changed");
          },
        },
        ctx.services
      )
    ).rejects.toThrow("develop changed");
    expect(ctx.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it("honors GitHub's refusal instead of pushing around repository rules", async () => {
    await expect(coordinator({ merged: false }).merge()).rejects.toThrow("GitHub refused");
  });
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("release automation branches", () => {
  it("updates only its own branch and preserves commits across retries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-release-git-test-"));
    dirs.push(dir);
    const origin = path.join(dir, "origin.git");
    const cwd = path.join(dir, "work");
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: fs.existsSync(cwd) ? cwd : dir,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init", "--bare", origin);
    git("clone", origin, cwd);
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    git("checkout", "-b", "main");
    fs.writeFileSync(path.join(cwd, "base.txt"), "base");
    git("add", ".");
    git("commit", "-m", "Base");
    const base = git("rev-parse", "HEAD");
    git("push", "origin", "main");
    git("checkout", "-b", "develop");
    fs.writeFileSync(path.join(cwd, "feature.txt"), "feature");
    git("add", ".");
    git("commit", "-m", "Feature");
    const source = git("rev-parse", "HEAD");
    git("push", "origin", "develop");
    const branch = "codex/release-3.8.0";
    fs.writeFileSync(path.join(cwd, "local.txt"), "Unrelated local work");
    const first = prepareBranch({ cwd, branch, base, source, message: "Prepare release" });
    expect(git("show", `${first}:feature.txt`)).toBe("feature");
    fs.writeFileSync(path.join(cwd, "feature2.txt"), "next");
    git("add", "feature2.txt");
    git("commit", "-m", "Next feature");
    const next = git("rev-parse", "HEAD");
    const second = prepareBranch({ cwd, branch, base, source: next, message: "Update release" });
    expect(git("merge-base", first, second)).toBe(first);
    expect(git("show", `${second}:feature2.txt`)).toBe("next");
    expect(git("ls-remote", "origin", "refs/heads/main")).toContain(base);
    expect(git("ls-remote", "origin", "refs/heads/develop")).toContain(source);
    expect(git("status", "--porcelain")).toBe("?? local.txt");
    expect(fs.readFileSync(path.join(cwd, "local.txt"), "utf8")).toBe("Unrelated local work");
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 20_000);
});

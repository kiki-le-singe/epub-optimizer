import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

export function run(command: string, args: string[], cwd = process.cwd(), input?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`
    );
  return result.stdout.trim();
}

export function repository(cwd: string): string {
  const remote = run("git", ["remote", "get-url", "origin"], cwd);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
    remote
  );
  if (!match || (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== match[1]))
    throw new Error("origin must match the selected GITHUB_REPOSITORY on github.com.");
  return match[1]!;
}

export function api<T>(repo: string, method: string, endpoint: string, body?: unknown): T {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository.");
  return JSON.parse(
    run(
      "gh",
      [
        "api",
        "--method",
        method,
        `repos/${repo}/${endpoint}`,
        ...(body === undefined ? [] : ["--input", "-"]),
      ],
      undefined,
      body === undefined ? undefined : JSON.stringify(body)
    )
  ) as T;
}

export function summary(message: string): void {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

/** Only the automation branch is pushed. Existing commits survive retries; no force push. */
export function prepareBranch(options: {
  cwd: string;
  branch: string;
  base: string;
  source: string;
  message: string;
  update?: (worktree: string) => void;
}): string {
  const { cwd, branch, base, source, message, update } = options;
  if (!/^codex\/[\w.-]+$/.test(branch)) throw new Error("Expected a codex/ automation branch.");
  const ref = `refs/heads/${branch}`;
  const remote = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", ref], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (remote.status !== 0 && remote.status !== 2)
    throw new Error("Cannot verify the automation branch; check network/authentication.");
  let start = base;
  if (remote.status === 0) {
    run("git", ["fetch", "origin", ref], cwd);
    start = run("git", ["rev-parse", "FETCH_HEAD"], cwd);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-release-pr-"));
  const worktree = path.join(dir, "checkout");
  let added = false;
  try {
    run("git", ["worktree", "add", "--detach", worktree, start], cwd);
    added = true;
    run("git", ["merge", "--no-ff", base, "-m", `Update ${branch} from its target`], worktree);
    run("git", ["merge", "--no-ff", source, "-m", message], worktree);
    update?.(worktree);
    const head = run("git", ["rev-parse", "HEAD"], worktree);
    run("git", ["push", "origin", `HEAD:${ref}`], worktree);
    return head;
  } finally {
    // dir was uniquely created here. Never recursively delete a checkout Git could not remove.
    if (
      !added ||
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd }).status === 0
    )
      fs.rmSync(dir, { recursive: true, force: true });
    else console.warn(`Could not remove release worktree: ${worktree}`);
  }
}

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  head: { sha: string; ref: string; repo: { full_name: string } };
  base: { sha: string; ref: string; repo: { full_name: string } };
}

interface WorkflowRun {
  id: number;
  event: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  pull_requests: Array<{ number: number; head: { sha: string }; base: { sha: string } }>;
}

interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PullRequestOptions {
  repo: string;
  branch: string;
  base: "main" | "develop";
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  beforeMerge?: () => void;
}

interface Services {
  request: <T>(method: string, endpoint: string, body?: unknown) => T;
  now: () => number;
  pause: () => Promise<void>;
  timeoutMs: number;
}

/** A manual dispatch is deliberately ineligible: only CI for this PR and this base can merge. */
export async function mergeCheckedPullRequest(
  options: PullRequestOptions,
  services: Services = {
    request: (method, endpoint, body) => api(options.repo, method, endpoint, body),
    now: Date.now,
    pause: () => setTimeout(20_000),
    timeoutMs: 45 * 60_000,
  }
): Promise<string> {
  const { repo, branch, base, headSha, baseSha, title, body, beforeMerge } = options;
  const { request, now, pause, timeoutMs } = services;
  const prs = request<Array<{ number: number; html_url: string }>>(
    "GET",
    `pulls?state=open&base=${base}&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`
  );
  if (prs.length > 1) throw new Error("Multiple automation PRs match this branch.");
  const pr =
    prs[0] ??
    request<{ number: number; html_url: string }>("POST", "pulls", {
      head: branch,
      base,
      title,
      body,
    });
  summary(`Automation PR: ${pr.html_url}`);
  const deadline = now() + timeoutMs;
  const snapshot = () => {
    const current = request<PullRequest>("GET", `pulls/${pr.number}`);
    if (
      current.state !== "open" ||
      current.merged ||
      current.draft ||
      current.head.sha !== headSha ||
      current.head.ref !== branch ||
      current.head.repo.full_name !== repo ||
      current.base.sha !== baseSha ||
      current.base.ref !== base ||
      current.base.repo.full_name !== repo
    )
      throw new Error(`PR #${pr.number} changed; retry after checking its head and target.`);
    const target = request<{ commit: { sha: string } }>("GET", `branches/${base}`);
    if (target.commit.sha !== baseSha)
      throw new Error(`${base} changed during CI; retry preparation.`);
    if (current.mergeable === false) throw new Error(`PR #${pr.number} has merge conflicts.`);
    return current;
  };
  while (now() < deadline) {
    snapshot();
    const runs = request<{ workflow_runs: WorkflowRun[] }>(
      "GET",
      `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${headSha}&per_page=100`
    )
      .workflow_runs.filter(
        (run) =>
          run.event === "pull_request" &&
          run.head_sha === headSha &&
          run.pull_requests.some(
            (item) =>
              item.number === pr.number && item.head.sha === headSha && item.base.sha === baseSha
          )
      )
      .sort((a, b) => b.id - a.id);
    const run = runs[0];
    if (run?.status === "completed") {
      if (run.conclusion !== "success")
        throw new Error(`CI failed for PR #${pr.number}: ${run.conclusion}.`);
      const jobs: Job[] = [];
      for (let page = 1; ; page++) {
        const result = request<{ total_count: number; jobs: Job[] }>(
          "GET",
          `actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`
        );
        jobs.push(...result.jobs);
        if (jobs.length >= result.total_count) break;
        if (!result.jobs.length) throw new Error("Incomplete CI job response.");
      }
      const gates = jobs.filter((job) => job.name === "Required CI");
      if (
        gates.length !== 1 ||
        gates[0]!.status !== "completed" ||
        gates[0]!.conclusion !== "success"
      )
        throw new Error(`PR #${pr.number} is missing a successful Required CI check.`);
      if (snapshot().mergeable !== true) {
        await pause();
        continue;
      }
      beforeMerge?.();
      // The expected head protects against concurrent updates. GitHub enforces all other rules.
      const merged = request<{ merged: boolean; sha: string; message?: string }>(
        "PUT",
        `pulls/${pr.number}/merge`,
        { sha: headSha, merge_method: "merge" }
      );
      if (!merged.merged)
        throw new Error(
          `GitHub refused PR #${pr.number}: ${merged.message ?? "check repository rules"}`
        );
      summary(`Merged PR #${pr.number} after Required CI: ${merged.sha}`);
      return merged.sha;
    }
    await pause();
  }
  throw new Error(
    `Timed out waiting for PR #${pr.number}. It remains open; check CI, approvals and App credentials before retrying.`
  );
}

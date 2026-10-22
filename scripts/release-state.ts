import { setTimeout } from "node:timers/promises";
// @ts-expect-error Native Node TypeScript requires the source extension.
import { api, summary } from "./release-pr.ts";

interface Timing {
  now: () => number;
  pause: (milliseconds: number) => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
}

const defaultTiming: Timing = {
  now: Date.now,
  pause: async (milliseconds) => {
    await setTimeout(milliseconds);
  },
  timeoutMs: 3 * 60_000,
  intervalMs: 10_000,
};

/** Retry incomplete reads only; API/authentication errors and failed checks fail closed. */
async function waitForState<T>(
  description: string,
  read: () => { value?: T; state: string },
  timing: Timing
): Promise<T> {
  const deadline = timing.now() + timing.timeoutMs;
  let previous: string | undefined;
  for (;;) {
    const { value, state } = read();
    if (value !== undefined) {
      summary(`${description}: ${state}`);
      return value;
    }
    const remaining = deadline - timing.now();
    if (remaining <= 0)
      throw new Error(
        `Timed out after ${timing.timeoutMs / 1000}s waiting for ${description}. Last observed: ${state}. Check GitHub before retrying; no check was bypassed.`
      );
    if (state !== previous) {
      summary(`Waiting for ${description}: ${state}`);
      previous = state;
    }
    await timing.pause(Math.min(timing.intervalMs, remaining));
  }
}

interface DevelopRun {
  id: number;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export async function waitForDevelopCI(
  repo: string,
  sha: string,
  services = {
    read: () =>
      api<{ workflow_runs: DevelopRun[] }>(
        repo,
        "GET",
        `actions/workflows/ci.yml/runs?event=push&branch=develop&head_sha=${sha}&per_page=100`
      ).workflow_runs,
    timing: defaultTiming,
  }
): Promise<void> {
  await waitForState(
    `develop push CI in ${repo} at ${sha}`,
    () => {
      const runs = services.read();
      const run = runs
        .filter(
          (item) => item.event === "push" && item.head_branch === "develop" && item.head_sha === sha
        )
        .sort((a, b) => b.id - a.id)[0];
      if (!run) return { state: `no matching run (${runs.length} run(s) returned by GitHub)` };
      const state = `run ${run.id}, status=${run.status}, conclusion=${run.conclusion ?? "null"}`;
      if (run.status === "completed" && run.conclusion !== null) {
        if (run.conclusion !== "success")
          throw new Error(
            `develop CI failed at ${sha}: ${state}. Inspect https://github.com/${repo}/actions/runs/${run.id} before retrying.`
          );
        return { value: true, state };
      }
      return { state };
    },
    services.timing
  );
}

interface Publication {
  id: number;
  tag_name: string;
  draft: boolean;
}

export async function waitForPublishedRelease<T extends Publication>(
  tag: string,
  read: () => T[],
  expectedId?: number,
  timing = defaultTiming
): Promise<T> {
  if (expectedId !== undefined && (!Number.isSafeInteger(expectedId) || expectedId <= 0))
    throw new Error("Expected a positive GitHub release ID.");
  return waitForState(
    `published GitHub release ${tag}${expectedId === undefined ? "" : ` (ID ${expectedId})`}`,
    () => {
      const release = read().find((item) => item.tag_name === tag);
      if (!release) return { state: "release absent from the catalogue" };
      if (expectedId !== undefined && release.id !== expectedId)
        throw new Error(
          `Release ${tag} has ID ${release.id}, expected ${expectedId}; refusing promotion.`
        );
      if (release.draft !== false) {
        // A published event can arrive before the catalogue reflects publication.
        // A manual dispatch still requires the operator to publish the draft first.
        if (expectedId === undefined)
          throw new Error(
            `Publish the GitHub release ${tag} (ID ${release.id}) before promoting Docker tags.`
          );
        return { state: `release ID ${release.id}, draft=${String(release.draft)}` };
      }
      return { value: release, state: `release ID ${release.id}, draft=false` };
    },
    timing
  );
}

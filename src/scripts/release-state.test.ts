import { describe, expect, it, vi } from "vitest";
import { waitForDevelopCI, waitForPublishedRelease } from "../../scripts/release-state.js";

const sha = "a".repeat(40);
const run = {
  id: 91,
  event: "push",
  head_branch: "develop",
  head_sha: sha,
  status: "completed",
  conclusion: "success" as string | null,
};
const release = { id: 42, tag_name: "v3.7.4", draft: false, assets: [] };

function clock(timeoutMs = 25) {
  let time = 0;
  return {
    now: () => time,
    pause: vi.fn(async (milliseconds: number) => {
      time += milliseconds;
    }),
    timeoutMs,
    intervalMs: 10,
  };
}

describe("release state propagation", () => {
  it("waits for a missing run, pending CI and an incomplete conclusion at the pinned SHA", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ ...run, status: "in_progress", conclusion: null }])
      .mockReturnValueOnce([{ ...run, conclusion: null }])
      .mockReturnValue([run]);
    const timing = clock(40);
    await waitForDevelopCI("example/epub", sha, { read, timing });
    expect(read).toHaveBeenCalledTimes(4);
    expect(timing.pause).toHaveBeenCalledTimes(3);
  });

  it.each([
    { event: "workflow_dispatch" },
    { event: "pull_request" },
    { head_branch: "main" },
    { head_sha: "b".repeat(40) },
  ])("never accepts an unrelated successful CI run: %j", async (change) => {
    const read = vi.fn(() => [{ ...run, ...change }]);
    await expect(waitForDevelopCI("example/epub", sha, { read, timing: clock() })).rejects.toThrow(
      `develop push CI in example/epub at ${sha}`
    );
    expect(read).toHaveBeenCalledTimes(4);
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required"])(
    "rejects the newest %s run immediately rather than accepting an older success",
    async (conclusion) => {
      const read = vi.fn(() => [run, { ...run, id: 92, conclusion }]);
      const timing = clock();
      await expect(waitForDevelopCI("example/epub", sha, { read, timing })).rejects.toThrow(
        `run 92, status=completed, conclusion=${conclusion}`
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(timing.pause).not.toHaveBeenCalled();
    }
  );

  it("waits for the newest run instead of accepting an older successful run", async () => {
    const read = vi.fn(() => [run, { ...run, id: 92, status: "queued", conclusion: null }]);
    const timing = clock();
    await expect(waitForDevelopCI("example/epub", sha, { read, timing })).rejects.toThrow(
      "Last observed: run 92, status=queued, conclusion=null"
    );
    expect(timing.pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([10, 10, 5]);
  });

  it("allows a newly published release to propagate, preserving its exact identity", async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ ...release, draft: true }])
      .mockReturnValue([release]);
    await expect(
      waitForPublishedRelease(release.tag_name, read, release.id, clock())
    ).resolves.toBe(release);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([{ catalogue: [] }, { catalogue: [{ ...release, draft: true }] }])(
    "never promotes a release that remains missing or draft: %j",
    async ({ catalogue }) => {
      const promote = vi.fn();
      await expect(
        waitForPublishedRelease(release.tag_name, () => catalogue, release.id, clock()).then(
          promote
        )
      ).rejects.toThrow("Timed out after 0.025s");
      expect(promote).not.toHaveBeenCalled();
    }
  );

  it("also waits for a missing catalogue entry during a manual retry", async () => {
    const read = vi.fn().mockReturnValueOnce([]).mockReturnValue([release]);
    await expect(waitForPublishedRelease(release.tag_name, read, undefined, clock())).resolves.toBe(
      release
    );
  });

  it("requires manual publication before a manually dispatched draft can be promoted", async () => {
    const timing = clock();
    await expect(
      waitForPublishedRelease(
        release.tag_name,
        () => [{ ...release, draft: true }],
        undefined,
        timing
      )
    ).rejects.toThrow("Publish the GitHub release v3.7.4 (ID 42)");
    expect(timing.pause).not.toHaveBeenCalled();
  });

  it("does not mistake an incomplete draft flag for proof of publication", async () => {
    await expect(
      waitForPublishedRelease(
        release.tag_name,
        () => [{ ...release, draft: undefined as unknown as boolean }],
        release.id,
        clock()
      )
    ).rejects.toThrow("Last observed: release ID 42, draft=undefined");
  });

  it("refuses a recreated release with the same tag and a different ID", async () => {
    await expect(
      waitForPublishedRelease(release.tag_name, () => [release], 43, clock())
    ).rejects.toThrow("ID 42, expected 43; refusing promotion");
  });

  it.each([0, -1, NaN, 1.5])("rejects an invalid event release ID: %s", async (id) => {
    const read = vi.fn();
    await expect(waitForPublishedRelease(release.tag_name, read, id, clock())).rejects.toThrow(
      "positive GitHub release ID"
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("reports API errors immediately instead of disguising authentication failures as pending CI", async () => {
    const timing = clock();
    const read = vi.fn(() => {
      throw new Error("GitHub HTTP 403: Resource not accessible by integration");
    });
    await expect(waitForDevelopCI("example/epub", sha, { read, timing })).rejects.toThrow(
      "HTTP 403"
    );
    await expect(
      waitForPublishedRelease(release.tag_name, read, release.id, timing)
    ).rejects.toThrow("HTTP 403");
    expect(read).toHaveBeenCalledTimes(2);
    expect(timing.pause).not.toHaveBeenCalled();
  });
});

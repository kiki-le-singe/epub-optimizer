import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runWatch } from "./watch.js";
import { runOptimization } from "./optimization.js";
import type { Args } from "./types.js";

vi.mock("./optimization.js", () => ({ runOptimization: vi.fn() }));
let root: string, args: Args;
let controllers: AbortController[];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-watch-test-"));
  await fs.mkdir(path.join(root, "in"));
  args = {
    watch: path.join(root, "in"),
    outputDir: path.join(root, "out"),
    watchSettleMs: 25,
    input: "unused",
    output: "unused",
    preset: "balanced",
    strict: true,
    clean: true,
  } as Args;
  controllers = [];
  vi.mocked(runOptimization).mockReset();
  vi.mocked(runOptimization).mockImplementation(async (book) => {
    await fs.writeFile(book.output, "validated");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  controllers.forEach((c) => c.abort());
  vi.restoreAllMocks();
  await fs.remove(root);
});
function controller(): AbortController {
  const c = new AbortController();
  controllers.push(c);
  return c;
}
async function runFor(ms = 120) {
  const c = controller();
  const timer = setTimeout(() => c.abort(), ms);
  try {
    return await runWatch(args, { signal: c.signal, pollIntervalMs: 5 });
  } finally {
    clearTimeout(timer);
  }
}
async function add(name = "a.epub", text = "original") {
  await fs.writeFile(path.join(args.watch!, name), text);
}
async function jobs() {
  return (await fs.readdir(args.outputDir!)).filter(
    (n) => !n.startsWith(".") && n !== "index.html"
  );
}

describe("watched folder", () => {
  it("waits for quiet files, snapshots them, and does not rerun unchanged inputs", async () => {
    await add();
    const c = controller();
    const running = runWatch(args, { signal: c.signal, pollIntervalMs: 5 });
    await delay(15);
    await fs.appendFile(path.join(args.watch!, "a.epub"), "-finished");
    expect(runOptimization).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runOptimization).toHaveBeenCalledOnce());
    const book = vi.mocked(runOptimization).mock.calls[0][0];
    expect(book.input).not.toBe(path.join(args.watch!, "a.epub"));
    await delay(40);
    c.abort();
    expect(await running).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
    expect(await fs.pathExists(path.dirname(book.input))).toBe(false);
    expect(await fs.readFile(path.join(args.watch!, "a.epub"), "utf8")).toBe("original-finished");
    expect(await fs.pathExists(path.join(args.outputDir!, ".epub-watch.lock"))).toBe(false);
  });
  it("recognizes completed books after restart and processes new content without replacing old outputs", async () => {
    await add();
    expect((await runFor()).succeeded).toBe(1);
    const first = (await jobs())[0];
    expect((await runFor()).skipped).toBe(1);
    expect(runOptimization).toHaveBeenCalledOnce();
    await add("a.epub", "changed");
    expect((await runFor()).succeeded).toBe(1);
    expect(await jobs()).toHaveLength(2);
    expect(await fs.readFile(path.join(args.outputDir!, first, "optimized.epub"), "utf8")).toBe(
      "validated"
    );
    args.fonts = true;
    expect((await runFor()).succeeded).toBe(1);
    expect(await jobs()).toHaveLength(3);
  });
  it("continues after a failure, attempts an unchanged failure only once per session, and can retry after restart", async () => {
    await add("a.epub");
    await add("b.EPUB");
    vi.mocked(runOptimization).mockImplementation(async (book) => {
      if ((await fs.readFile(book.input, "utf8")) === "original") throw new Error("bad book");
      await fs.writeFile(book.output, "validated");
    });
    await add("b.EPUB", "good");
    expect(await runFor()).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
    expect(runOptimization).toHaveBeenCalledTimes(2);
    expect(await runFor()).toEqual({ succeeded: 0, failed: 1, skipped: 1 });
    expect(runOptimization).toHaveBeenCalledTimes(3);
  });
  it("accepts empty directories, ignores partial names, nested books, empty files and symlinks", async () => {
    await add("a.epub.part");
    await add("empty.epub", "");
    await fs.mkdir(path.join(args.watch!, "nested"));
    await fs.writeFile(path.join(args.watch!, "nested", "book.epub"), "book");
    await fs.symlink(path.join(args.watch!, "a.epub.part"), path.join(args.watch!, "link.epub"));
    expect(await runFor()).toEqual({ succeeded: 0, failed: 0, skipped: 0 });
    expect(runOptimization).not.toHaveBeenCalled();
  });
  it("rejects nested/aliased directories and symlink roots before processing", async () => {
    const signal = controller().signal;
    await expect(
      runWatch({ ...args, outputDir: path.join(args.watch!, "out") }, { signal })
    ).rejects.toThrow("parent directory");
    expect(await fs.pathExists(path.join(args.watch!, "out"))).toBe(false);
    await fs.symlink(args.watch!, path.join(root, "alias"));
    await expect(
      runWatch({ ...args, watch: path.join(root, "alias") }, { signal })
    ).rejects.toThrow("real directory");
    await fs.symlink(args.watch!, args.outputDir!);
    await expect(runWatch(args, { signal })).rejects.toThrow();
  });
  it("excludes simultaneous watchers and releases its own lock on graceful stop", async () => {
    const c = controller(),
      running = runWatch(args, { signal: c.signal, pollIntervalMs: 5 });
    await vi.waitFor(async () =>
      expect(await fs.pathExists(path.join(args.outputDir!, ".epub-watch.lock"))).toBe(true)
    );
    await expect(runWatch(args, { signal: controller().signal })).rejects.toThrow(
      /EEXIST|holds the output guard/
    );
    c.abort();
    await running;
    expect((await runFor()).failed).toBe(0);
  });
  it("finishes the current book but starts no next book after shutdown", async () => {
    await add("a.epub");
    await add("b.epub");
    const c = controller();
    vi.mocked(runOptimization).mockImplementation(async (book) => {
      c.abort();
      await delay(10);
      await fs.writeFile(book.output, "validated");
    });
    expect(await runWatch(args, { signal: c.signal, pollIntervalMs: 5 })).toEqual({
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(runOptimization).toHaveBeenCalledOnce();
  });
  it("queues changes made to the live source while optimizing a private snapshot", async () => {
    await add();
    const c = controller();
    const texts: string[] = [];
    vi.mocked(runOptimization).mockImplementation(async (book) => {
      texts.push(await fs.readFile(book.input, "utf8"));
      await fs.writeFile(book.output, "validated");
      if (texts.length === 1) await add("a.epub", "updated");
      else c.abort();
    });
    const timer = setTimeout(() => c.abort(), 2000);
    try {
      expect((await runWatch(args, { signal: c.signal, pollIntervalMs: 5 })).succeeded).toBe(2);
    } finally {
      clearTimeout(timer);
    }
    expect(texts).toEqual(["original", "updated"]);
  });
  it("refuses altered completed outputs rather than overwriting them", async () => {
    await add();
    await runFor();
    const job = (await jobs())[0];
    await fs.writeFile(path.join(args.outputDir!, job, "optimized.epub"), "external change");
    expect((await runFor()).failed).toBe(1);
    expect(runOptimization).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(args.outputDir!, job, "optimized.epub"), "utf8")).toBe(
      "external change"
    );
  });
  it("protects live input hard links from report writes on retry", async () => {
    await add();
    await runFor();
    const job = path.join(args.outputDir!, (await jobs())[0]);
    await fs.remove(path.join(job, "completed.json"));
    await fs.link(path.join(args.watch!, "a.epub"), path.join(job, "report.json"));
    expect((await runFor()).failed).toBe(1);
    expect(runOptimization).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(args.watch!, "a.epub"), "utf8")).toBe("original");
  });
  it("refuses symlink job directories", async () => {
    await add();
    await runFor();
    const job = path.join(args.outputDir!, (await jobs())[0]);
    await fs.remove(job);
    await fs.ensureDir(path.join(root, "foreign"));
    await fs.symlink(path.join(root, "foreign"), job);
    expect((await runFor()).failed).toBe(1);
    expect(await fs.readdir(path.join(root, "foreign"))).toEqual([]);
  });
  it("does not delete a replaced lock", async () => {
    const c = controller(),
      running = runWatch(args, { signal: c.signal, pollIntervalMs: 5 });
    const lock = path.join(args.outputDir!, ".epub-watch.lock");
    await vi.waitFor(async () => expect(await fs.pathExists(lock)).toBe(true));
    await fs.rename(lock, lock + ".original");
    await fs.writeFile(lock, "foreign");
    c.abort();
    await expect(running).rejects.toThrow("replaced watch lock");
    expect(await fs.readFile(lock, "utf8")).toBe("foreign");
  });
  it.each([
    { batch: "elsewhere" },
    { doctor: true },
    { inspect: true },
    { reportJson: "summary.json" },
    { reportHtml: "summary.html" },
    { watchSettleMs: 0 },
    { watch: undefined },
    { outputDir: undefined },
  ])("rejects unsupported configuration before processing: %j", async (patch) => {
    await expect(
      runWatch({ ...args, ...patch }, { signal: controller().signal })
    ).rejects.toThrow();
    expect(runOptimization).not.toHaveBeenCalled();
  });
  it("includes author configuration contents in restart identity", async () => {
    await add();
    args.authorWorkflow = true;
    args.authorConfig = path.join(root, "author.json");
    await fs.writeJson(args.authorConfig, { summaryHref: "first.xhtml" });
    const summaries: string[] = [];
    vi.mocked(runOptimization).mockImplementation(async (book) => {
      summaries.push((await fs.readJson(book.authorConfig!)).summaryHref);
      await fs.writeFile(book.output, "validated");
    });
    await runFor();
    await fs.writeJson(args.authorConfig, { summaryHref: "second.xhtml" });
    await runFor();
    expect(summaries).toEqual(["first.xhtml", "second.xhtml"]);
    expect(await jobs()).toHaveLength(2);
  });
  it.skipIf(process.platform === "win32")(
    "rejects a replaced output FIFO without blocking the watcher",
    async () => {
      await add();
      await runFor();
      const target = path.join(args.outputDir!, (await jobs())[0], "optimized.epub");
      await fs.remove(target);
      execFileSync("mkfifo", [target]);
      expect((await runFor()).failed).toBe(1);
      expect(runOptimization).toHaveBeenCalledOnce();
    }
  );
});

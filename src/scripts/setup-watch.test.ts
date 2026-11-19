import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "epub-nas-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function setup(store: string, env = path.join(root, "watch.env")) {
  return spawnSync("sh", [path.resolve("scripts/setup-watch.sh"), store, env], {
    encoding: "utf8",
  });
}
it("creates literal paths, owner-only env and directories without overwriting settings", async () => {
  const store = path.join(root, "books $literal spaces");
  expect(setup(store).status).toBe(0);
  const env = await fs.readFile(path.join(root, "watch.env"), "utf8");
  expect(env).toContain(`EPUB_WATCH_INBOX='${await fs.realpath(store)}/inbox'`);
  // The helper and the Compose default must offer the same tested image.
  const pinned = /ghcr\.io\/kiki-le-singe\/epub-optimizer:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/;
  const image = pinned.exec(env)?.[0];
  expect(image).toBeDefined();
  expect(env).toContain(`EPUB_OPTIMIZER_DOCKER_IMAGE=${image}\n`);
  expect(await fs.readFile(path.resolve("compose.watch.yaml"), "utf8")).toContain(
    `\${EPUB_OPTIMIZER_DOCKER_IMAGE:-${image}}`
  );
  expect((await fs.stat(path.join(root, "watch.env"))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(store, "optimized"))).isDirectory()).toBe(true);
  expect(setup(store).status).toBe(1);
  expect(await fs.readFile(path.join(root, "watch.env"), "utf8")).toBe(env);
});
it("preserves user files and refuses symlinks and line breaks", async () => {
  const store = path.join(root, "data");
  await fs.mkdir(store);
  await fs.writeFile(path.join(store, "original.epub"), "preserve");
  expect(setup(store).status).toBe(0);
  expect(await fs.readFile(path.join(store, "original.epub"), "utf8")).toBe("preserve");
  const link = path.join(root, "link");
  await fs.symlink(store, link);
  expect(setup(link, path.join(root, "other.env")).status).toBe(1);
  expect(setup(path.join(root, "bad\npath")).status).toBe(1);
});

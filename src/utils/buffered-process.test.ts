import { expect, it } from "vitest";
import { runBufferedProcess } from "./buffered-process.js";
it("captures native exit status and separate streams without blocking timers", async () => {
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  const result = await runBufferedProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{console.log('out');console.error('err');process.exitCode=3},50)"],
    5000
  );
  clearTimeout(timer);
  expect(ticked).toBe(true);
  expect(result.status).toBe(3);
  expect(result.stdout).toBe("out\n");
  expect(result.stderr).toBe("err\n");
  expect(result.error).toBeUndefined();
});
it("kills a stalled child and reports a timeout", async () => {
  const result = await runBufferedProcess(process.execPath, ["-e", "setInterval(()=>{},100)"], 50);
  expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
  expect(result.status).toBeNull();
});
it("bounds combined stdout/stderr and kills overflowing children", async () => {
  const result = await runBufferedProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},100)"],
    5000,
    100
  );
  expect(result.error).toMatchObject({ code: "ENOBUFS" });
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(100);
});
it("reports missing commands without leaving a timeout behind", async () => {
  const result = await runBufferedProcess("/missing-epub-test-command", [], 5000);
  expect(result.error).toMatchObject({ code: "ENOENT" });
});

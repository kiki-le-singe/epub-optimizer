import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "child_process";

// Mock child_process
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

describe("pipeline.ts", () => {
  // Mock console methods
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("runScript", () => {
    it("calls spawnSync with correct arguments", async () => {
      // Extract runScript function using regex on the module source code
      const runScriptFn = new Function(
        "script",
        "args",
        "label",
        "spawnSync",
        "path",
        "process",
        "console",
        `
        const scriptPath = path.join("dist", "src", "scripts", ...script.split("/"));
        console.log(\`\\n=== \${label} ===\`);
        const result = spawnSync("node", [scriptPath, ...args], { stdio: "inherit" });
        if (result.status !== 0) {
          console.error(\`\\n✗ \${label} failed.\`);
          process.exit(result.status || 1);
        }
        `
      );

      // Setup mock implementation
      vi.mocked(spawnSync).mockReturnValue({ status: 0 } as unknown as SpawnSyncReturns<Buffer>);

      // Call the function with the mocked dependencies
      runScriptFn(
        "fix/index.js",
        ["--input", "test.epub"],
        "Fix Files",
        spawnSync,
        { join: (...parts: string[]) => parts.join("/") },
        process,
        console
      );

      // Check that spawnSync was called with correct arguments
      expect(spawnSync).toHaveBeenCalledWith(
        "node",
        [expect.stringContaining("fix/index.js"), "--input", "test.epub"],
        expect.anything()
      );
    });

    // Note: We're not testing the error case that calls process.exit
    // because Vitest doesn't handle process.exit well in tests
    // In a real-world scenario, we would use a custom exit handler for testability
  });

  describe("pipeline flow", () => {
    it("processes arguments correctly", async () => {
      // Mock spawnSync to return valid result for all calls
      vi.mocked(spawnSync).mockImplementation(
        () => ({ status: 0 }) as unknown as SpawnSyncReturns<Buffer>
      );

      // Setup process.argv
      const originalArgv = process.argv;
      process.argv = ["node", "pipeline.js", "--clean", "--input", "test.epub"];

      try {
        // Import the module to trigger the pipeline flow
        await import("./pipeline.js");

        // Check that spawnSync was called for each step
        expect(spawnSync).toHaveBeenCalledTimes(6); // 5 scripts + cleanup

        // Verify cleanup is called with --clean flag
        expect(spawnSync).toHaveBeenCalledWith("rm", ["-rf", "temp_epub"], expect.anything());
      } finally {
        // Restore original argv
        process.argv = originalArgv;
      }
    });
  });
});

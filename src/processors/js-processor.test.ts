import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { collectDiagnostics, type Diagnostic } from "../utils/diagnostics.js";
import { minifyJavaScript } from "./js-processor.js";

describe("minifyJavaScript", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "js-processor-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  async function write(name: string, content: string): Promise<string> {
    const file = path.join(root, name);
    await fs.outputFile(file, content);
    return file;
  }
  async function run(): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    await collectDiagnostics(
      () => minifyJavaScript(root),
      (d) => diagnostics.push(d)
    );
    return diagnostics;
  }

  it("minifies nested scripts and keeps the global names that XHTML handlers call", async () => {
    const source = `
      // Called from onclick="toggleNote('n1')" in a chapter.
      function toggleNote(id) {
        var element = document.getElementById(id);
        element.hidden = !element.hidden;
        return element.hidden;
      }
      var notesShown = 0;
    `;
    const file = await write("OPS/js/notes.js", source);

    expect(await run()).toEqual([]);

    const minified = await fs.readFile(file, "utf8");
    expect(minified.length).toBeLessThan(source.length);
    expect(minified).not.toContain("Called from");
    // Run both versions against the same fake document: same globals, same behavior.
    for (const code of [source, minified]) {
      const note = { hidden: true };
      const context = vm.createContext({ document: { getElementById: () => note } });
      vm.runInContext(code, context);
      expect(vm.runInContext("toggleNote('n1')", context)).toBe(false);
      expect(vm.runInContext("typeof notesShown", context)).toBe("number");
    }
  });

  it("keeps a script that minification would not make smaller", async () => {
    // Terser adds a statement terminator: 3 bytes would become 4.
    const file = await write("OPS/tiny.js", "a=1");

    expect(await run()).toEqual([]);

    expect(await fs.readFile(file, "utf8")).toBe("a=1");
  });

  it("leaves invalid and empty scripts unchanged and reports only the invalid one", async () => {
    const invalid = await write("OPS/broken.js", "function ( {");
    const empty = await write("OPS/empty.js", "  \n");
    const valid = await write("OPS/valid.js", "var   value   =   1 + 2;");

    const diagnostics = await run();

    expect(diagnostics).toEqual([
      { severity: "warning", message: expect.stringMatching(/^Skipping broken\.js: /) },
    ]);
    expect(await fs.readFile(invalid, "utf8")).toBe("function ( {");
    expect(await fs.readFile(empty, "utf8")).toBe("  \n");
    expect(await fs.readFile(valid, "utf8")).toBe("var value=3;");
  });

  it("ignores files that are not .js and succeeds without any script", async () => {
    const data = await write("OPS/data.json", '{ "a": 1 }');
    const module = await write("OPS/app.mjs", "export const   a = 1;");

    expect(await run()).toEqual([]);

    expect(await fs.readFile(data, "utf8")).toBe('{ "a": 1 }');
    expect(await fs.readFile(module, "utf8")).toBe("export const   a = 1;");
  });
});

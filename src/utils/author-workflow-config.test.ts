import { afterEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_AUTHOR_WORKFLOW_CONFIG,
  loadAuthorWorkflowConfig,
  resolveAuthorWorkflowConfig,
} from "./author-workflow-config.js";

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((file) => fs.remove(file)));
});

describe("author workflow configuration", () => {
  it("preserves the existing project-author defaults", () => {
    expect(resolveAuthorWorkflowConfig()).toEqual({
      summaryHref: "chapter-2.xhtml",
      coverHref: "cover.xhtml",
      coverSpineId: "cover",
      chapterClasses: ["p6", "p8"],
      sectionClasses: ["p7"],
      summaryEntryClass: "p6",
      coverNavClass: "s3",
      sectionNavClass: "s4",
    });
    expect(DEFAULT_AUTHOR_WORKFLOW_CONFIG.summaryHref).toBe("chapter-2.xhtml");
  });

  it("loads partial JSON overrides while retaining unspecified defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "author-config-"));
    tempFiles.push(dir);
    const configPath = path.join(dir, "author.json");
    await fs.writeJson(configPath, {
      summaryHref: "contents.xhtml",
      chapterClasses: ["chapter-link"],
      sectionClasses: ["section-link"],
    });

    await expect(loadAuthorWorkflowConfig(configPath)).resolves.toMatchObject({
      summaryHref: "contents.xhtml",
      coverHref: "cover.xhtml",
      chapterClasses: ["chapter-link"],
      sectionClasses: ["section-link"],
    });
  });

  it("rejects unknown keys and unsafe paths", () => {
    expect(() => resolveAuthorWorkflowConfig({ unknown: true } as never)).toThrow(
      "Unknown author workflow configuration key"
    );
    expect(() => resolveAuthorWorkflowConfig({ summaryHref: "../outside.xhtml" })).toThrow(
      "Refusing summaryHref outside EPUB root"
    );
  });
});

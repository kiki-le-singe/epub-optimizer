import fs from "fs-extra";
import path from "node:path";
import { resolvePathInside } from "./path-safety.js";

export interface AuthorWorkflowConfig {
  summaryHref: string;
  coverHref: string;
  coverSpineId: string;
  chapterClasses: readonly string[];
  sectionClasses: readonly string[];
  summaryEntryClass: string;
  coverNavClass: string;
  sectionNavClass: string;
}

export const DEFAULT_AUTHOR_WORKFLOW_CONFIG: Readonly<AuthorWorkflowConfig> = Object.freeze({
  summaryHref: "chapter-2.xhtml",
  coverHref: "cover.xhtml",
  coverSpineId: "cover",
  chapterClasses: Object.freeze(["p6", "p8"]),
  sectionClasses: Object.freeze(["p7"]),
  summaryEntryClass: "p6",
  coverNavClass: "s3",
  sectionNavClass: "s4",
});

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_AUTHOR_WORKFLOW_CONFIG));
const CLASS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const XML_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function validateHref(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[?#]/.test(value)) {
    throw new Error(`${name} must be a non-empty local href without a query or fragment.`);
  }
  resolvePathInside("/epub-author-config", "/epub-author-config", value, name);
  return value;
}

function validateClassName(value: unknown, name: string): string {
  if (typeof value !== "string" || !CLASS_NAME_PATTERN.test(value)) {
    throw new Error(`${name} must be a single valid CSS class name.`);
  }
  return value;
}

function validateClassList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must contain at least one CSS class name.`);
  }
  return value.map((entry, index) => validateClassName(entry, `${name}[${index}]`));
}

export function resolveAuthorWorkflowConfig(
  overrides: Partial<AuthorWorkflowConfig> = {}
): AuthorWorkflowConfig {
  for (const key of Object.keys(overrides)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`Unknown author workflow configuration key: ${key}`);
    }
  }

  const merged = { ...DEFAULT_AUTHOR_WORKFLOW_CONFIG, ...overrides };
  if (typeof merged.coverSpineId !== "string" || !XML_ID_PATTERN.test(merged.coverSpineId)) {
    throw new Error("coverSpineId must be a valid XML identifier.");
  }

  return {
    summaryHref: validateHref(merged.summaryHref, "summaryHref"),
    coverHref: validateHref(merged.coverHref, "coverHref"),
    coverSpineId: merged.coverSpineId,
    chapterClasses: validateClassList(merged.chapterClasses, "chapterClasses"),
    sectionClasses: validateClassList(merged.sectionClasses, "sectionClasses"),
    summaryEntryClass: validateClassName(merged.summaryEntryClass, "summaryEntryClass"),
    coverNavClass: validateClassName(merged.coverNavClass, "coverNavClass"),
    sectionNavClass: validateClassName(merged.sectionNavClass, "sectionNavClass"),
  };
}

export async function loadAuthorWorkflowConfig(configPath?: string): Promise<AuthorWorkflowConfig> {
  if (!configPath) {
    return resolveAuthorWorkflowConfig();
  }

  const absolutePath = path.resolve(configPath);
  let parsed: unknown;
  try {
    parsed = await fs.readJson(absolutePath);
  } catch (error) {
    throw new Error(
      `Failed to read author workflow configuration ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Author workflow configuration must be a JSON object.");
  }

  return resolveAuthorWorkflowConfig(parsed as Partial<AuthorWorkflowConfig>);
}

export function resolveAuthorWorkflowHref(contentDir: string, href: string, label: string): string {
  return resolvePathInside(contentDir, contentDir, href, label);
}

export function createOwnerRelativeHref(ownerFile: string, targetFile: string): string {
  return encodeURI(path.relative(path.dirname(ownerFile), targetFile).split(path.sep).join("/"));
}

export function referenceTargetsFile(
  epubDir: string,
  ownerFile: string,
  reference: string | undefined,
  targetFile: string
): boolean {
  if (!reference) return false;
  try {
    return resolvePathInside(epubDir, path.dirname(ownerFile), reference) === targetFile;
  } catch {
    return false;
  }
}

export function hasAnyClass(classValue: string | undefined, classes: readonly string[]): boolean {
  if (!classValue) return false;
  const tokens = new Set(classValue.split(/\s+/).filter(Boolean));
  return classes.some((className) => tokens.has(className));
}

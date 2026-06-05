import path from "node:path";

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function isSameOrInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function resolvePathInside(
  rootDir: string,
  ownerDir: string,
  rawReference: string,
  label = "EPUB path"
): string {
  const pathPart = rawReference.split(/[?#]/, 1)[0] ?? "";
  const decoded = safeDecodeUri(pathPart).replace(/\\/g, "/");

  if (
    !decoded ||
    decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded)
  ) {
    throw new Error(`Refusing unsafe ${label}: ${rawReference}`);
  }

  const absoluteRoot = path.resolve(rootDir);
  const resolved = path.resolve(ownerDir, decoded);
  if (!isSameOrInside(resolved, absoluteRoot) || resolved === absoluteRoot) {
    throw new Error(`Refusing ${label} outside EPUB root: ${rawReference}`);
  }
  return resolved;
}

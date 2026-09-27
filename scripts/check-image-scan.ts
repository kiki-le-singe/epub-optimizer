import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

interface Vulnerability {
  VulnerabilityID: string;
  PkgName: string;
  Severity: string;
  FixedVersion?: string;
}

export function scanFailures(scan: {
  Results?: Array<{ Vulnerabilities?: Vulnerability[] }>;
}): string[] {
  if (!Array.isArray(scan.Results)) throw new Error("Missing or invalid Trivy results.");
  return scan.Results.flatMap((result) => result.Vulnerabilities ?? [])
    .filter(
      (vulnerability) => vulnerability.Severity === "CRITICAL" && vulnerability.FixedVersion?.trim()
    )
    .map(
      (vulnerability) =>
        `${vulnerability.VulnerabilityID}: ${vulnerability.PkgName} (fixed in ${vulnerability.FixedVersion})`
    );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const failures = scanFailures(
    JSON.parse(fs.readFileSync(process.argv[2] ?? "reports/trivy.json", "utf8"))
  );
  if (failures.length) {
    console.error("Fixable critical image vulnerabilities:\n" + failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      "No fixable critical vulnerabilities. Full findings are retained in the Trivy report."
    );
  }
}

export interface EpubCheckTotals {
  fatals: number;
  errors: number;
  warnings: number;
  infos: number;
}

export interface EpubCheckLocation {
  path: string;
  line?: number;
  column?: number;
  context?: string;
}

export interface EpubCheckMessage {
  code: string;
  severity: "FATAL" | "ERROR" | "WARNING" | "INFO" | "USAGE";
  message: string;
  locations: EpubCheckLocation[];
  additionalLocations: number;
  suggestion?: string;
}

export interface EpubCheckDiagnostics {
  checkerVersion: string;
  totals: EpubCheckTotals;
  messages: EpubCheckMessage[];
}

export interface EpubCheckReport {
  source: "json" | "text" | "unavailable";
  exitCode: number | null;
  checkerVersion?: string;
  totals?: EpubCheckTotals;
  messages: EpubCheckMessage[];
  diagnosticsError?: string;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid EPUBCheck JSON field: ${field}.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid EPUBCheck JSON field: ${field}.`);
  return value;
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid EPUBCheck JSON count: ${field}.`);
  return value as number;
}

function coordinate(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === -1 || value === 0) return undefined;
  const result = count(value, field);
  return result;
}

/** Normalize only documented diagnostics, without copying publication metadata. */
export function parseEpubCheckJson(input: string): EpubCheckDiagnostics {
  const report = object(JSON.parse(input), "report");
  const checker = object(report.checker, "checker");
  const totals = {
    fatals: count(checker.nFatal, "checker.nFatal"),
    errors: count(checker.nError, "checker.nError"),
    warnings: count(checker.nWarning, "checker.nWarning"),
    infos: count(checker.nUsage, "checker.nUsage"),
  };
  if (!Array.isArray(report.messages)) throw new Error("Invalid EPUBCheck JSON messages.");
  const messages = report.messages.map((entry): EpubCheckMessage => {
    const message = object(entry, "message");
    const severity = string(message.severity, "message.severity");
    if (!["FATAL", "ERROR", "WARNING", "INFO", "USAGE"].includes(severity))
      throw new Error("Invalid EPUBCheck JSON severity.");
    if (!Array.isArray(message.locations)) throw new Error("Invalid EPUBCheck JSON locations.");
    const locations = message.locations.map((entry): EpubCheckLocation => {
      const location = object(entry, "location");
      return {
        path: string(location.path, "location.path"),
        line: coordinate(location.line, "location.line"),
        column: coordinate(location.column, "location.column"),
        ...(location.context == null
          ? {}
          : { context: string(location.context, "location.context") }),
      };
    });
    return {
      code: string(message.ID, "message.ID"),
      severity: severity as EpubCheckMessage["severity"],
      message: string(message.message, "message.message"),
      locations,
      additionalLocations: count(message.additionalLocations ?? 0, "message.additionalLocations"),
      ...(message.suggestion == null
        ? {}
        : { suggestion: string(message.suggestion, "message.suggestion") }),
    };
  });
  return {
    checkerVersion: string(checker.checkerVersion, "checker.checkerVersion"),
    totals,
    messages,
  };
}

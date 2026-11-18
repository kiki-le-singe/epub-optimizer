#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startLocalUi } from "./ui/server.js";
import { isEntryPoint } from "./scripts/utils.js";
import { reportError, reportInfo } from "./utils/diagnostics.js";

export async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8787" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    reportInfo(
      "Usage: epub-optimizer-ui [--host 127.0.0.1|0.0.0.0] [--port 8787]\nLocal interface, one EPUB at a time. Java and EPUBCheck are required outside Docker."
    );
    return;
  }
  if (!/^\d+$/.test(values.port!) || Number(values.port) < 1024 || Number(values.port) > 65535)
    throw new Error("The port must be between 1024 and 65535.");
  if (values.host !== "127.0.0.1" && values.host !== "0.0.0.0")
    throw new Error("Unsupported host address.");
  const app = await startLocalUi({ host: values.host, port: Number(values.port) });
  reportInfo(
    `EPUB Optimizer · Local interface: ${app.url}\nOne book at a time. Results are temporary. Press Ctrl+C to stop.`
  );
  const stop = () => {
    void app.close().catch((error: unknown) => {
      reportError(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (isEntryPoint(import.meta.url))
  void main().catch((error: unknown) => {
    reportError(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

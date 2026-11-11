import { AsyncLocalStorage } from "node:async_hooks";

export interface Diagnostic {
  readonly severity: "warning" | "error";
  readonly message: string;
}

interface DiagnosticScope {
  active: boolean;
  consume: (diagnostic: Diagnostic) => void;
  parent?: DiagnosticScope;
}

const scopes = new AsyncLocalStorage<DiagnosticScope>();

/** Collect explicit diagnostics in this async operation, without changing console. */
export async function collectDiagnostics<T>(
  operation: () => Promise<T> | T,
  consume: (diagnostic: Diagnostic) => void
): Promise<T> {
  const scope: DiagnosticScope = { active: true, consume, parent: scopes.getStore() };
  try {
    return await scopes.run(scope, operation);
  } finally {
    // Detached callbacks may outlive the step; completed reports stay immutable.
    scope.active = false;
  }
}

function emit(severity: Diagnostic["severity"], args: unknown[]): void {
  const diagnostic = Object.freeze({ severity, message: args.map(String).join(" ") });
  // Nested steps also belong to their enclosing operation; concurrent operations
  // have separate async-local scope chains and cannot collect each other's logs.
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.active) scope.consume(diagnostic);
  }
}

export function reportInfo(...args: unknown[]): void {
  console.log(...args);
}

export function reportWarning(...args: unknown[]): void {
  emit("warning", args);
  console.warn(...args);
}

/** Preserve the stdout channel of existing warning-labelled CLI messages. */
export function reportWarningToStdout(...args: unknown[]): void {
  emit("warning", args);
  console.log(...args);
}

export function reportError(...args: unknown[]): void {
  emit("error", args);
  console.error(...args);
}

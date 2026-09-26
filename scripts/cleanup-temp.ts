// @ts-expect-error Native TypeScript execution requires the source extension.
import { removeTempDir } from "../src/utils/temp-dir.ts";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: pnpm cleanup <temporary-directory printed by the optimizer>");
}
await removeTempDir(target);
console.log(`Removed temporary directory: ${target}`);

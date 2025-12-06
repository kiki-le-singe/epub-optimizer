import { runCommand, handleError } from "../utils.js";

// Get CLI arguments to forward to child scripts
const args = process.argv.slice(2).join(" ");

try {
  runCommand(`node dist/src/scripts/fix/fix-span-tags.js ${args}`);
  runCommand(`node dist/src/scripts/fix/fix-xml.js ${args}`);
  console.log("All general fixes applied.");
} catch (error) {
  handleError(error);
}

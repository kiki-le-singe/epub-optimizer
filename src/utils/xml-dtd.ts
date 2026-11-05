import { createReadStream } from "node:fs";
import fs from "fs-extra";
import path from "node:path";
import { collectFiles, forEachFileLimited } from "./files.js";

/** Scan only the XML prolog; never interpret or expand a DTD. */
function prologScanner(): (text: string) => boolean | undefined {
  let buffer = "";
  let state: "prolog" | "comment" | "pi" | "doctype" = "prolog";
  let quote: string | undefined;
  return (text) => {
    buffer += text;
    for (;;) {
      if (state === "comment" || state === "pi") {
        const terminator = state === "comment" ? "-->" : "?>";
        const end = buffer.indexOf(terminator);
        if (end === -1) {
          // Retain only a possible terminator split across stream chunks.
          buffer = buffer.slice(-(terminator.length - 1));
          return undefined;
        }
        buffer = buffer.slice(end + terminator.length);
        state = "prolog";
      } else if (state === "doctype") {
        let ended = false;
        for (let i = 0; i < buffer.length; i++) {
          const char = buffer[i];
          if (quote) {
            if (char === quote) quote = undefined;
          } else if (char === '"' || char === "'") {
            quote = char;
          } else if (char === "[") {
            return true;
          } else if (char === ">") {
            buffer = buffer.slice(i + 1);
            state = "prolog";
            ended = true;
            break;
          }
        }
        if (!ended) {
          buffer = "";
          return undefined;
        }
      } else {
        buffer = buffer.trimStart();
        if (!buffer) return undefined;
        if (buffer.startsWith("<!--")) {
          buffer = buffer.slice(4);
          state = "comment";
        } else if (buffer.startsWith("<?")) {
          buffer = buffer.slice(2);
          state = "pi";
        } else if (/^<!DOCTYPE[\t\n\r ]/i.test(buffer)) {
          buffer = buffer.slice(9);
          state = "doctype";
        } else if (
          ["<!--", "<?", "<!DOCTYPE "].some((token) => token.startsWith(buffer.toUpperCase()))
        ) {
          return undefined;
        } else {
          // A root element or non-XML data ends the prolog. Markup-like
          // strings inside attributes, scripts, styles or CDATA are inert.
          return false;
        }
      }
    }
  };
}

function xmlDecoder(prefix: Buffer): TextDecoder {
  if ((prefix[0] === 0xfe && prefix[1] === 0xff) || (prefix[0] === 0 && prefix[1] === 0x3c))
    return new TextDecoder("utf-16be");
  if ((prefix[0] === 0xff && prefix[1] === 0xfe) || (prefix[0] === 0x3c && prefix[1] === 0))
    return new TextDecoder("utf-16le");
  return new TextDecoder("utf-8");
}

async function hasInternalDtd(file: string): Promise<boolean> {
  const scan = prologScanner();
  let decoder: TextDecoder | undefined;
  let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 16 * 1024 })) {
    let bytes = chunk as Buffer;
    if (!decoder) {
      prefix = Buffer.concat([prefix, bytes]);
      if (prefix.length < 4) continue;
      decoder = xmlDecoder(prefix);
      bytes = prefix;
      prefix = Buffer.alloc(0);
    }
    const result = scan(decoder.decode(bytes, { stream: true }));
    if (result !== undefined) return result;
  }
  return scan(decoder ? decoder.decode() : xmlDecoder(prefix).decode(prefix)) === true;
}

/** Reject unsupported DTD semantics before parsing or changing any EPUB resource. */
export async function assertNoInternalDtdSubsets(epubDir: string): Promise<void> {
  // Inspect regular archive entries regardless of their extension: content
  // documents and even the OPF may have producer-specific filenames.
  const files = await collectFiles(epubDir, () => true);
  await forEachFileLimited(files, async (file) => {
    if (!(await fs.lstat(file)).isFile()) return;
    if (await hasInternalDtd(file)) {
      const relative = path.relative(epubDir, file).split(path.sep).join("/");
      throw new Error(
        `Internal DTD subsets are not supported: ${JSON.stringify(relative)}. ` +
          "Optimization was refused to preserve entity-defined content. " +
          "Replace internal declarations with literal text or numeric character references before retrying."
      );
    }
  });
}

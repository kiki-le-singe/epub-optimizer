// The worker has no EPUB paths or publication responsibilities. Only font bytes cross IPC.
process.once("message", async (message: { font: Buffer; characters: string }) => {
  try {
    const engine = await import(
      new URL(
        import.meta.url.endsWith(".ts") ? "./font-engine.ts" : "./font-engine.js",
        import.meta.url
      ).href
    );
    const result = await engine.subsetFontBuffer(message.font, message.characters);
    process.send?.(result, () => process.disconnect());
  } catch (error) {
    process.send?.(
      { error: error instanceof Error ? error.message.slice(0, 240) : "Font subsetting failed" },
      () => process.disconnect()
    );
  }
});
export {};

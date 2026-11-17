import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    minify: true,
    outDir: fileURLToPath(new URL("../dist/ui-assets", import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL("./main.tsx", import.meta.url)),
      formats: ["es"],
      fileName: () => "app.js",
      cssFileName: "app",
    },
  },
});

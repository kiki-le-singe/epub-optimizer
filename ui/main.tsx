import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, initialTheme } from "./lib/preferences.js";
import "./styles.css";

applyTheme(initialTheme(), window.matchMedia("(prefers-color-scheme: dark)").matches);
const token = document.querySelector<HTMLMetaElement>('meta[name="epub-token"]')!.content;
const maxUpload = Number(
  document.querySelector<HTMLMetaElement>('meta[name="upload-limit"]')!.content
);
createRoot(document.getElementById("root")!).render(<App token={token} maxUpload={maxUpload} />);

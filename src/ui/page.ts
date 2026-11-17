/** Session-specific bootstrap. React and Tailwind assets are built locally by Vite. */
export function uiHtml(token: string, maxUpload: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="epub-token" content="${token}"><meta name="upload-limit" content="${maxUpload}"><title>EPUB Optimizer</title><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>JavaScript is required to use EPUB Optimizer. / JavaScript est nécessaire pour utiliser EPUB Optimizer.</noscript></body></html>`;
}

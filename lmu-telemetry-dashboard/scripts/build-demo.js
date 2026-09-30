'use strict';

/**
 * Builds a single self-contained HTML file of the engineer view running the
 * in-browser race simulator (public/demo-sim.js). Open it on any device,
 * no server needed. Output: demo/pit-wall-demo.html
 *
 *   node scripts/build-demo.js
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'public/engineer.html'), 'utf8');
const sim = fs.readFileSync(path.join(root, 'public/demo-sim.js'), 'utf8');

// Inline the simulator and switch it on
html = html.replace(
  '<script src="demo-sim.js"></script>',
  () => `<script>window.LMU_DEMO = true;</script>\n<script>\n${sim}\n</script>`,
);
// Standalone page: the host supplies the document skeleton and the tab icon
html = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '')
  .replace(/<\/html>\s*$/i, '')
  .replace(/<head>\s*/i, '')
  .replace(/<\/head>\s*/i, '')
  .replace(/<body[^>]*>\s*/i, '')
  .replace(/<\/body>\s*/i, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<link rel="icon"[^>]*>\s*/i, '')
  .replace('<title>LMU Pit Wall</title>', '<title>LMU Pit Wall Demo</title>');
// Deliberately dark-only; fit inside the host's safe-area padding with a 16 px gutter
html = html.replace(
  '</style>',
  `  /* standalone demo */
  :root { color-scheme: dark; background: var(--bg); }
  html, body { height: 100%; }
  body { height: 100%; padding: 8px 16px; }
  @media (max-width: 1100px) { html, body { height: auto; } }
</style>`,
);

const out = path.join(root, 'demo/pit-wall-demo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);

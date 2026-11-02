// Converts the design canvas artboards (design/*.dc.html) into app screen markup
// (src/screens/markup/*.html). Re-run after pulling a new version of the design.
//
// What it changes, and nothing else:
//  - keeps only the artboard body (between </helmet> and </x-dc>)
//  - links between artboards  "Home.dc.html"  ->  "#/home"
//  - uploaded logo blob       "/_blob/…"      ->  "./logo.svg"
//  - the root's fixed artboard height (min-height: 844px…) -> var(--screen-min-h)
// Template holes ({{…}}), <sc-for>, <sc-if> and on* handlers are kept as-is and
// rendered by src/dc.ts.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'design');
const out = join(root, 'src/screens/markup');
mkdirSync(out, { recursive: true });

export const routeOf = (file) => file.replace(/\.dc\.html$/, '').toLowerCase();

const files = readdirSync(src).filter((f) => f.endsWith('.dc.html'));
for (const file of files) {
  const html = readFileSync(join(src, file), 'utf8');
  const start = html.indexOf('</helmet>');
  const end = html.lastIndexOf('</x-dc>');
  if (start < 0 || end < 0) throw new Error(`${file}: no <x-dc> body`);
  let body = html.slice(start + '</helmet>'.length, end).trim();

  body = body
    .replace(/href="([A-Za-z0-9_-]+)\.dc\.html"/g, (_, name) => `href="#/${name.toLowerCase()}"`)
    .replace(/\/_blob\/[a-f0-9]{32}/g, './logo.svg')
    .replace(/min-height: \d+px/, 'min-height: var(--screen-min-h)');

  writeFileSync(join(out, file.replace(/\.dc\.html$/, '.html')), body + '\n');
}
console.log(`design: imported ${files.length} screens`);

// Copies the admin dashboard artboards (design/admin/*.dc.html) into admin/src/markup/*.html.
// Like the app's importer, the result is then data-bound by hand, so by default this writes to
// design/imported-admin/ for diffing; --overwrite replaces the dashboard markup.
//  - links between artboards  "Admin-Workers.dc.html" -> "#workers"
//  - uploaded logo blob       "/_blob/…"             -> "../logo.svg"
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'design/admin');
const out = process.argv.includes('--overwrite') ? join(root, 'admin/src/markup') : join(root, 'design/imported-admin');
mkdirSync(out, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.dc.html'));
for (const file of files) {
  const html = readFileSync(join(src, file), 'utf8');
  const start = html.indexOf('</helmet>');
  const end = html.lastIndexOf('</x-dc>');
  if (start < 0 || end < 0) throw new Error(`${file}: no <x-dc> body`);
  const body = html
    .slice(start + '</helmet>'.length, end)
    .trim()
    .replace(/href="Admin-([A-Za-z0-9_-]+)\.dc\.html"/g, (_, name) => `href="#${name.toLowerCase()}"`)
    .replace(/\/_blob\/[a-f0-9]{32}/g, '../logo.svg');
  writeFileSync(join(out, file.replace(/^Admin-/, '').replace(/\.dc\.html$/, '.html')), body + '\n');
}
console.log(`admin design: imported ${files.length} screens → ${out}`);

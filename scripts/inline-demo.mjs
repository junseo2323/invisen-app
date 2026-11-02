// Turns dist-demo/ into one self-contained page (dist-demo/invisen-demo.html) for sharing:
// JS, CSS and the logo are inlined. The page is written without <html>/<head>/<body>
// because the artifact host wraps it in its own document skeleton.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist-demo');
const assets = readdirSync(join(dist, 'assets'));
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));
if (js.length !== 1) throw new Error(`expected one JS chunk, got ${js.join(', ')}`);

const dataUri = (file) => `data:image/svg+xml;base64,${readFileSync(join(root, 'public', file)).toString('base64')}`;
let code = readFileSync(join(dist, 'assets', js[0]), 'utf8')
  .replaceAll('./logo-light.svg', dataUri('logo-light.svg'))
  .replaceAll('./logo.svg', dataUri('logo.svg'))
  .replaceAll('</script', '<\\/script');
const styles = css.map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n').replaceAll('</style', '<\\/style');

const page = `<title>invisen 작업자 앱</title>
<meta name="theme-color" content="#0b0e12">
<style>
${styles}
</style>
<div id="app"></div>
<script type="module">
${code}
</script>
`;
writeFileSync(join(dist, 'invisen-demo.html'), page);
console.log(`demo: dist-demo/invisen-demo.html (${Math.round(page.length / 1024)} KB)`);

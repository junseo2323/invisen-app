import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// base './' so the same build works served from our server and bundled in the iOS app.
// The server build also carries the admin dashboard (admin/ → dist/admin/); the iOS bundle
// (INVISEN_APP_ONLY=1, see ios:sync / ios-release) and the demo leave it out.
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // demo build (npm run build:demo → dist-demo/): fake API, simulated sensor, Google Fonts
  resolve:
    mode === 'demo'
      ? { alias: [{ find: /^\.\/fonts$/, replacement: fileURLToPath(new URL('./src/fonts-google.ts', import.meta.url)) }] }
      : {},
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    target: 'safari15',
    // the demo is inlined into one HTML file (scripts/inline-demo.mjs), so keep it to one JS chunk
    rollupOptions:
      mode === 'demo'
        ? { output: { inlineDynamicImports: true } }
        : process.env.INVISEN_APP_ONLY === '1'
          ? {}
          : { input: { main: page('./index.html'), admin: page('./admin/index.html') } },
  },
  server: {
    // `npm run dev` + `npm --prefix server run dev` → API on :3000
    proxy: { '/api': 'http://localhost:3000' },
  },
}));

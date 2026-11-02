import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// base './' so the same build works served from our server and bundled in the iOS app.
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
    rollupOptions: mode === 'demo' ? { output: { inlineDynamicImports: true } } : {},
  },
  server: {
    // `npm run dev` + `npm --prefix server run dev` → API on :3000
    proxy: { '/api': 'http://localhost:3000' },
  },
}));

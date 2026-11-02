import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// base './' so the same build works served from our server and bundled in the iOS app.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: 'dist', target: 'safari15' },
  server: {
    // `npm run dev` + `npm --prefix server run dev` → API on :3000
    proxy: { '/api': 'http://localhost:3000' },
  },
});

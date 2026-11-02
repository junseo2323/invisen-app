import { defineConfig } from 'vite';

// base './' so the same build works served from https://eney.cloud/ and bundled in the iOS app.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'safari15' },
});

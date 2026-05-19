import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    // Multi-entry: ship the production `index.html` for the
    // companion / glasses-host bundle AND `preview.html` for the
    // browser-only screens gallery. The preview is dead code in a
    // pack (`npm run pack`) but available during `npm run dev` at
    // /preview.html and lands as a sibling artifact in `dist/`.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
      },
    },
  },
});

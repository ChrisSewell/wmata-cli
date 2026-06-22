/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    // The production build (→ dist → packed .ehpk) ships ONLY index.html.
    // `glasses-preview.html` is a DEV-ONLY harness: `vite dev` still serves it
    // on demand, but it is deliberately NOT a build input because it reads
    // `import.meta.env.VITE_WMATA_KEY` (live-test key) — which Vite would
    // statically inline into the bundle, leaking the key into the shipped
    // artifact. Keeping it out of the build keeps the .ehpk key-free.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  test: {
    // Pure data/ui/screen logic runs in node; DOM-touching companion/storage
    // tests opt into jsdom per-file via `// @vitest-environment jsdom`.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});

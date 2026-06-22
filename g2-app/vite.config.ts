/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    // Two entries: the production `index.html` (companion + glasses host)
    // and `glasses-preview.html` (the real-container verification harness
    // that boots the host against fixture data for simulator review).
    // The preview is dead code in a packed `.ehpk` but available during
    // `npm run dev` and lands as a sibling artifact in `dist/`.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'glasses-preview.html'),
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

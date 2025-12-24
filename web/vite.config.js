import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  // With config in /web, make root explicit to this directory.
  root: path.resolve(__dirname, '.'),
  publicDir: 'public',
  // Use relative base so assets and worker chunks load from GitHub Pages subpaths.
  base: './',
  build: {
    // Emit static build to repo-root docs/ for GitHub Pages.
    outDir: '../docs',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        optimize: path.resolve(__dirname, 'texture-optimizer.html'),
        merge: path.resolve(__dirname, 'mesh-merger.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});


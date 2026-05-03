import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

/** @type {import('vite').Plugin} */
function electronFileProtocol() {
  return {
    name: 'electron-file-protocol',
    closeBundle() {
      const htmlPath = resolve(__dirname, 'dist/renderer/index.html');
      let html = readFileSync(htmlPath, 'utf-8');
      // Replace type="module" with defer — module breaks file:// in Electron,
      // but defer is needed so the script waits for DOM before executing
      html = html.replace(/ type="module"/g, ' defer');
      html = html.replace(/ crossorigin/g, '');
      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [electronFileProtocol()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html'),
      output: {
        format: 'iife',
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});

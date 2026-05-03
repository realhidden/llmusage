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
      // Remove type="module" and crossorigin — they break file:// loading in Electron
      html = html.replace(/ type="module"/g, '');
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

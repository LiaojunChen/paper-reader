import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'client'),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true, target: 'es2022' },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
});

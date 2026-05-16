import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4242',
      '/ws': { target: 'ws://127.0.0.1:4242', ws: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'web-dist'),
    emptyOutDir: true,
  },
});

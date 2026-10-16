import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.AGENTIX_URL || `http://127.0.0.1:${process.env.AGENTIX_PORT || 4317}`;

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: api, changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// v0.8.2 — Vite dev server proxies /api/* → http://localhost:3000 (Hono server).
// In production, the browser hits the same origin (server.ts serves web/dist/),
// so the empty BASE in lib/api.ts works in both modes.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})

import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Panel del SUPERADMIN (Fase 3 de ARQUITECTURA.md).
// Se sirve desde Express en /app-admin; /admin es un alias compatible.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), tailwindcss()],
  base: '/app-admin/',
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
})

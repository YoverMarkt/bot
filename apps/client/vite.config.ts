import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Panel del cliente (Fase 2 de ARQUITECTURA.md).
// - base '/app/': el build se sirve desde Express en /app; /client es alias.
// - proxy: en desarrollo, las llamadas /api van al server Express local.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), tailwindcss()],
  base: '/app/',
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})

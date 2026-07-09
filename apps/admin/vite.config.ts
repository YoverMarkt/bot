import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Panel del SUPERADMIN (Fase 3 de ARQUITECTURA.md).
// Se sirve desde Express en /app-admin; el admin viejo sigue en /admin
// hasta migrar todas las secciones (patrón estrangulador).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app-admin/',
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
})

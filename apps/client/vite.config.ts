import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Panel del cliente (Fase 2 de ARQUITECTURA.md).
// - base '/app/': el build se sirve desde Express en /app (el panel viejo
//   sigue en /client hasta que cada sección migre — patrón estrangulador).
// - proxy: en desarrollo, las llamadas /api van al server Express local.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app/',
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})

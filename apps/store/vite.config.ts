import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Mini app del negocio (la tienda que abre el cliente desde WhatsApp).
//
// - base '/t/': la URL viaja en un mensaje de WhatsApp, así que es corta. Al
//   ser absoluta, los assets resuelven igual en /t/slug que en /t/otro-slug.
// - Sin router ni cliente de datos: esto se abre con datos móviles y en
//   teléfonos modestos, así que cada kilobyte del bundle se paga en clientes
//   que cierran la app antes de que cargue.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), tailwindcss()],
  base: '/t/',
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})

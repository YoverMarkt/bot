import { defineConfig } from 'vitest/config'

// Credenciales sintéticas para que la suite corra hermética: sin depender de
// server/.env (en CI no existe) y sin exponer los tests a la base real.
// dotenv no sobreescribe variables ya definidas, así que estos valores mandan.
export default defineConfig({
  test: {
    env: {
      SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_KEY: 'clave-sintetica-solo-para-tests',
      JWT_SECRET: 'secreto-sintetico-solo-para-tests-de-vitest',
    },
  },
})

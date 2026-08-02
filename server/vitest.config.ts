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
    coverage: {
      provider: 'v8',
      // Se mide `dist/`, no `src/`, porque es lo que las pruebas cargan de
      // verdad. Es el JavaScript compilado del mismo TypeScript, así que dice
      // igual de bien qué módulos nadie ejecuta nunca; solo cambia que los
      // nombres acaban en .js.
      include: ['dist/**/*.js'],
      exclude: [
        // Solo declaraciones de tipos: no hay nada que ejecutar.
        'dist/types/**',
        'dist/db/types.js',
      ],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // Un poco por debajo de lo medido hoy (71/61/66/74), no por encima: el
      // umbral está para que la cobertura no RETROCEDA, no para exigir una
      // cifra bonita. Un margen de uno o dos puntos evita que un refactor
      // inocente rompa el CI sin haber empeorado nada.
      //
      // ⚠️ Ojo con leerlo como nota del proyecto: los repositorios son
      // envoltorios finos de Supabase y salen bajos a propósito —probarlos
      // sería probar el cliente de Supabase—; lo que de verdad los verifica es
      // `verify:schema`, que EJECUTA sus funciones contra PostgreSQL real.
      thresholds: {
        statements: 70,
        branches: 59,
        functions: 65,
        lines: 73,
      },
    },
  },
})

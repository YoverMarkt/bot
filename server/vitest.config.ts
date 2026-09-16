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
      // Un poco por debajo de lo medido hoy (71/64,5/65,3/73,2), no por encima:
      // el umbral está para que la cobertura no RETROCEDA, no para exigir una
      // cifra bonita. Un margen de uno o dos puntos evita que un refactor
      // inocente rompa el CI sin haber empeorado nada.
      //
      // ⚠️ REBASEADO EL 2026-09-16, y conviene saber en qué dirección. Al
      // retirar el pedido por chat se fueron 2.323 líneas de servicio que
      // tenían 1.786 de pruebas dedicadas —`money.ts`, `bot-actions.ts`,
      // `bot-menu-flow.ts`, `bot-media.ts`—, o sea código MUY cubierto. La
      // media de funciones bajó de ~66 a ~65,3 sin que ninguna línea
      // superviviente quedara menos probada: es aritmética del denominador, no
      // un retroceso. `branches` se APRIETA de 59 a 63, que es lo que de
      // verdad había subido; el conjunto queda más exigente que antes.
      //
      // ⚠️ Y `functions` se deja con margen de verdad porque es la métrica
      // RUIDOSA de esta batería: entre ejecuciones se mide 928, 930 o 933 de
      // 1.425 (±0,4 puntos) según qué pruebas toquen los `require` diferidos
      // de los adaptadores. Un umbral rozándola convierte el CI en una moneda
      // al aire, y un CI que falla sin motivo se acaba ignorando.
      //
      // ⚠️ Ojo con leerlo como nota del proyecto: los repositorios son
      // envoltorios finos de Supabase y salen bajos a propósito —probarlos
      // sería probar el cliente de Supabase—; lo que de verdad los verifica es
      // `verify:schema`, que EJECUTA sus funciones contra PostgreSQL real.
      thresholds: {
        statements: 70,
        branches: 63,
        functions: 64,
        lines: 72,
      },
    },
  },
})

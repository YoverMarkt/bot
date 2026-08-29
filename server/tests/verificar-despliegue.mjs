#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ¿ESTÁ CORRIENDO DE VERDAD LO QUE ACABO DE FUSIONAR?
// ═══════════════════════════════════════════════════════════════════════════
//
// Por qué existe: el 2026-08-29, cuatro despliegues seguidos se quedaron
// colgados en Railway. Producción siguió sirviendo el código de la mañana
// durante horas mientras se daba por bueno que estaba al día — incluido un
// arreglo de DINERO, que el cliente veía mal en la pantalla de pago.
//
// El engaño fue sutil: la API de GitHub listaba los despliegues, así que
// `deployments --jq '.[0].sha'` devolvía el commit correcto. Pero eso solo
// dice que alguien PIDIÓ desplegar ese commit; su `state` seguía en
// `in_progress` y el contenedor viejo nunca fue reemplazado.
//
// ⚠️ La lección, que vale para todo este proyecto: comprobar que EXISTE un
// despliegue no es comprobar que su código CORRE. Lo único que lo demuestra es
// preguntárselo al servidor que está atendiendo.
//
//   npm run verify:deploy -w @botpanel/server -- https://tu-dominio.com
//
// Sin argumento usa SMOKE_URL. Compara con el HEAD local, así que se corre
// después de `git pull` en la rama que se acaba de fusionar.
import { execSync } from 'node:child_process'

const BASE = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/+$/, '')
if (!BASE) {
  console.error('❌ Falta la dirección de producción.')
  console.error('   npm run verify:deploy -w @botpanel/server -- https://tu-dominio.com')
  process.exit(1)
}

const esperado = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim()

const salir = (codigo, ...lineas) => {
  for (const l of lineas) console.log(l)
  process.exit(codigo)
}

let salud
try {
  const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) })
  salud = await r.json()
} catch (error) {
  salir(1, `❌ ${BASE} no respondió: ${error instanceof Error ? error.message : error}`)
}

const corriendo = String(salud?.version || '')

console.log(`\n🚀 Despliegue de ${BASE}\n`)
console.log(`   esperado (HEAD local) : ${esperado}`)
console.log(`   corriendo en el server: ${corriendo || '(no lo dice)'}`)
console.log('')

if (!corriendo) {
  salir(1,
    '❌ El servidor no informa de su versión.',
    '',
    '   O es anterior a esta comprobación, o `RAILWAY_GIT_COMMIT_SHA` no llega',
    '   al contenedor. Hasta que la informe, NO se puede afirmar que un cambio',
    '   esté desplegado: hay que comprobarlo mirando la app.')
}

if (corriendo === 'local') {
  salir(1, '❌ Ese servidor corre fuera de Railway (`local`), así que no hay commit que comparar.')
}

if (corriendo !== esperado) {
  salir(1,
    '❌ PRODUCCIÓN NO ESTÁ AL DÍA.',
    '',
    `   Está corriendo ${corriendo} y lo fusionado es ${esperado}.`,
    '',
    '   Esto es exactamente lo que pasó el 2026-08-29: el despliegue existía en',
    '   GitHub pero se quedó `in_progress` y nunca reemplazó al contenedor viejo.',
    '   Mira el panel de Railway antes de dar nada por desplegado.')
}

salir(0, '✅ Producción corre exactamente el commit fusionado.')

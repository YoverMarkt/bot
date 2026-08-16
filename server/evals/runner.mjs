// RUNNER DE EVALS
//
// Corre las conversaciones doradas contra la IA de VERDAD, con el prompt real
// que usa el bot. Es la única capa que ve bugs de comportamiento: el CI puede
// estar entero en verde mientras la IA inventa un precio o promete algo que no
// existe.
//
//   npm run evals -w @botpanel/server              todos los casos
//   npm run evals -w @botpanel/server -- hostal    solo los que contengan "hostal"
//
// ⚠️ GASTA DINERO: cada caso es una llamada real a la API de IA. Son céntimos
// por corrida, pero se paga de la cuenta configurada. Por eso NO corre en el CI:
// se lanza a mano antes de una demo, o al cambiar el prompt o el modelo.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import dotenv from 'dotenv'
import { CASOS } from './casos.mjs'

const require = createRequire(import.meta.url)
const serverDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
dotenv.config({ path: path.join(serverDir, '.env') })

const ai = require(path.join(serverDir, 'dist/services/ai'))
const prompt = require(path.join(serverDir, 'dist/services/prompt'))
const tags = require(path.join(serverDir, 'dist/services/bot-tags'))
const { checkQuotedPrices } = require(path.join(serverDir, 'dist/services/price-guard'))

const PROVEEDOR = process.env.EVAL_AI_PROVIDER || null
const filtro = process.argv[2] || ''

const color = {
  ok: texto => `\x1b[32m${texto}\x1b[0m`,
  fallo: texto => `\x1b[31m${texto}\x1b[0m`,
  tenue: texto => `\x1b[90m${texto}\x1b[0m`,
  titulo: texto => `\x1b[1m${texto}\x1b[0m`,
}

// ── Comprobaciones ──────────────────────────────────────────────────────────
// Cada una devuelve null si pasa, o el motivo del fallo.

const ETIQUETAS = {
  pedido: salida => Boolean(salida.orderPayload) || salida.hasSale,
  handoff: salida => salida.hasHandoffTag,
}

function comprobar(caso, respuesta, salida) {
  const espera = caso.espera || {}
  const fallos = []
  const texto = String(respuesta || '')
  const textoBajo = texto.toLowerCase()

  if (espera.sinPreciosInventados) {
    const revision = checkQuotedPrices({
      text: texto,
      allowedAmounts: caso.negocio.products.flatMap(p => [p.price, p.price_sale]),
    })
    if (!revision.ok) {
      fallos.push(`citó precios que no existen: ${revision.invented.join(', ')}`)
    }
  }

  for (const etiqueta of espera.debeEmitir || []) {
    if (!ETIQUETAS[etiqueta]?.(salida)) fallos.push(`no emitió la etiqueta ${etiqueta}`)
  }

  for (const etiqueta of espera.noDebeEmitir || []) {
    if (ETIQUETAS[etiqueta]?.(salida)) fallos.push(`emitió ${etiqueta} sin deberlo`)
  }

  if (espera.debeDerivar && !salida.hasHandoffTag && !salida.isUncertain) {
    fallos.push('no derivó a una persona')
  }

  for (const prohibido of espera.noDebeContener || []) {
    const patron = new RegExp(prohibido, 'i')
    if (patron.test(textoBajo)) fallos.push(`dijo algo prohibido: "${prohibido}"`)
  }

  if (espera.debeMencionar?.length) {
    const alguno = espera.debeMencionar.some(m => textoBajo.includes(m.toLowerCase()))
    if (!alguno) fallos.push(`no mencionó ninguno de: ${espera.debeMencionar.join(' / ')}`)
  }

  return fallos
}

// ── Ejecución ───────────────────────────────────────────────────────────────

async function correrCaso(caso) {
  const systemPrompt = prompt.buildPrompt(
    caso.negocio,
    caso.negocio.products,
    caso.politicas || {},
    caso.mensaje,
    caso.schedule || null,
  )
  // `historial` permite probar lo que de verdad hace un cliente: llegar al
  // pedido tras un par de mensajes, no soltarlo todo de golpe.
  const historial = (caso.historial || []).map(mensaje => ({
    role: mensaje.de === 'bot' ? 'assistant' : 'user',
    content: mensaje.texto,
  }))
  const respuesta = await ai.callAI(systemPrompt, historial, caso.mensaje, PROVEEDOR)
  const salida = tags.parseBotOutput(respuesta || '')
  return { respuesta: respuesta || '', salida, fallos: comprobar(caso, respuesta, salida) }
}

async function main() {
  const casos = filtro
    ? CASOS.filter(c => c.id.includes(filtro) || c.negocio.type.includes(filtro))
    : CASOS

  if (!casos.length) {
    console.error(`No hay casos que coincidan con "${filtro}"`)
    process.exit(1)
  }

  console.log(color.titulo(`\n🧪 EVALS DEL BOT — ${casos.length} caso(s)`))
  console.log(color.tenue(`   proveedor: ${PROVEEDOR || 'el configurado por defecto'}`))
  console.log(color.tenue('   ⚠️  cada caso es una llamada real a la IA y consume saldo\n'))

  let pasados = 0
  const fallidos = []

  for (const caso of casos) {
    process.stdout.write(`  ${caso.id.padEnd(38)}`)
    try {
      const { respuesta, fallos } = await correrCaso(caso)
      if (fallos.length) {
        console.log(color.fallo('FALLA'))
        fallidos.push({ caso, fallos, respuesta })
      } else {
        console.log(color.ok('pasa'))
        pasados += 1
      }
    } catch (error) {
      console.log(color.fallo('ERROR'))
      fallidos.push({ caso, fallos: [`no se pudo ejecutar: ${error.message}`], respuesta: '' })
    }
  }

  if (fallidos.length) {
    console.log(color.titulo('\n── FALLOS ──────────────────────────────────────────\n'))
    for (const { caso, fallos, respuesta } of fallidos) {
      console.log(color.fallo(`  ✗ ${caso.id}`))
      console.log(color.tenue(`    por qué importa: ${caso.porque}`))
      console.log(color.tenue(`    el cliente dijo: "${caso.mensaje}"`))
      for (const fallo of fallos) console.log(`    → ${fallo}`)
      console.log(color.tenue(`    respondió: ${respuesta.replace(/\n/g, ' ').slice(0, 220)}`))
      console.log()
    }
  }

  const total = pasados + fallidos.length
  console.log(color.titulo(`\n${pasados}/${total} casos pasaron\n`))
  // Se sale con error para poder encadenarlo antes de una demo.
  process.exit(fallidos.length ? 1 : 0)
}

main().catch((error) => {
  console.error('❌ Los evals no pudieron arrancar:', error.message)
  process.exit(1)
})

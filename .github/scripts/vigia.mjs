#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EL VIGÍA DE PRODUCCIÓN — el único que puede avisar de que el bot murió
// ═══════════════════════════════════════════════════════════════════════════
//
// Dentro del servidor hay cuatro detectores y todos son buenos: el canario
// recorre el camino del cliente, `credential-monitor` revisa saldo y webhooks,
// `channel-health` mira si entran mensajes y `error-log` deja el rastro. Pero
// los cuatro comparten un punto ciego que ninguno puede cubrir por definición:
// **si el proceso muere, no hay quien avise**. La cola de webhooks vive dentro
// de ese mismo proceso, así que entran mensajes y nadie los atiende.
//
// Por eso este vigía corre FUERA, en GitHub Actions, y pregunta desde la calle.
//
// ── CÓMO AVISA ──────────────────────────────────────────────────────────────
//
// No manda correos ni mensajes: **termina en rojo**, y de eso ya se encarga
// GitHub, que notifica por email y por su app móvil. Cero cuentas, cero
// credenciales de envío, cero código que mantener.
//
// El precio de esa simpleza es que hay que ser cuidadoso con CUÁNDO fallar:
// corriendo cada 15 minutos, fallar siempre que algo va mal son 96 correos al
// día, y una alarma que suena 96 veces se silencia el primer día. Así que el
// vigía se acuerda de lo que pasó antes —mirando la conclusión de su propia
// ejecución anterior, sin guardar estado en ningún sitio— y solo falla cuando
// la noticia es nueva:
//
//   · se rompió algo que estaba bien     → falla (el aviso)
//   · sigue roto, hace menos de 4 h      → pasa en verde y lo dice en el resumen
//   · sigue roto, hace 4 h o más         → falla (el recordatorio)
//   · se recuperó                        → pasa en verde y lo dice en el resumen
//
// ⚠️ La recuperación NO genera correo, solo deja el run en verde y el resumen
// escrito. Es una limitación asumida: lo que no se puede perder es enterarse de
// la caída, no de la vuelta.
//
// ⚠️ GitHub desactiva los workflows programados tras 60 días sin actividad en
// el repositorio. Mientras haya commits no pasa; si el proyecto se queda quieto
// dos meses, hay que reactivarlo a mano desde la pestaña Actions.

/**
 * Horas sin un solo mensaje entrante antes de dar el canal por mudo.
 *
 * ⚠️ Tiene que valer lo MISMO que `DEFAULT_SILENCE_HOURS` en
 * `server/src/services/channel-health.ts`, y ese 24 está elegido con cuidado:
 * un local de comida cierra de noche y del último pedido al primero del día
 * siguiente pasan 13 h normales, un domingo flojo más de 20. Bajarlo aquí
 * volvería a lo de antes — una alarma que grita cada madrugada y que se acaba
 * ignorando justo el día que dice la verdad.
 *
 * `vigia.test.js` comprueba que los dos números siguen siendo el
 * mismo, así que no se pueden desincronizar en silencio.
 */
export const HORAS_DE_SILENCIO = 24

/**
 * Cada cuánto se repite el aviso mientras el problema siga ahí.
 *
 * Dos ritmos, porque son dos urgencias distintas: si el bot está CAÍDO cada
 * hora cuenta, pero un saldo bajo puede llevar semanas ahí —y de hecho lleva—,
 * así que recordarlo cada 4 h sería el spam que este vigía existe para evitar.
 */
export const RECORDATORIO_MS = 4 * 60 * 60 * 1000
export const RECORDATORIO_ATENCION_MS = 24 * 60 * 60 * 1000

/** Cuánto se espera a que producción conteste antes de darla por caída. */
const ESPERA_MS = 20_000

/**
 * ¿Está sana la producción? Función pura: recibe lo que contestaron los dos
 * endpoints y devuelve el veredicto con sus motivos en español.
 *
 * `salud` a null significa que no contestó nada — que es el caso grave.
 * `detalle` a null significa que no se pudo consultar el detalle (sin token, o
 * el endpoint no está desplegado todavía): NO se considera un fallo, porque el
 * detalle es información de más y su ausencia no dice nada del bot.
 */
export function evaluarSalud({ salud, detalle, horasDeSilencio = HORAS_DE_SILENCIO }) {
  const motivos = []
  // ⚠️ `caida` NO es lo mismo que «hay un problema», y confundirlos arruina la
  // alarma. El primer aviso de verdad que mandó esto decía «🔴 Producción ha
  // caído» porque al número le quedaban 0,50 USD — con el bot vivo y vendiendo.
  // Un título que exagera se deja de leer, y el día que de verdad se caiga
  // parecerá uno más.
  let caida = false

  if (!salud) {
    return {
      sano: false,
      caida: true,
      motivos: ['Producción no contesta: el proceso puede estar caído.'],
    }
  }

  // ⚠️ Contestar no es contestar TÚ. Con el servicio caído, el borde de Railway
  // responde su propio JSON de error, y sin esta comprobación el vigía lo leía
  // como «el proceso dice que no puede trabajar» — que manda a buscar el fallo
  // dentro del servidor cuando el servidor ni siquiera está arrancado.
  if (typeof salud !== 'object' || !('webhook_inbox' in salud)) {
    return {
      sano: false,
      caida: true,
      motivos: [
        'Contestó algo que no es nuestro `/api/health`: lo normal es que sea el '
        + 'proxy de Railway con el servicio caído, o una URL equivocada.',
      ],
    }
  }

  if (salud.ok !== true) {
    caida = true
    motivos.push('`/api/health` responde que el proceso NO puede trabajar (`ok: false`).')
  }

  const cola = salud.webhook_inbox || {}
  if (cola.running === false) {
    caida = true
    motivos.push('La cola de webhooks no está corriendo.')
  } else if (cola.ready === false) {
    caida = true
    motivos.push('La cola de webhooks no llega a la base.')
  }

  // El canario recorre el camino real del cliente cada 12 h. Si encontró algo,
  // significa que hoy NO se puede comprar, aunque el proceso esté vivo.
  const canario = salud.canario
  if (canario && Number(canario.fallos) > 0) {
    motivos.push(
      `El canario encontró ${canario.fallos} fallo(s) recorriendo el camino del cliente `
      + `(${canario.revisados ?? '?'} local(es) revisados el ${canario.at}).`,
    )
  }

  const canal = salud.inbound_channel || {}
  if (Number(canal.recent_failures) > 0) {
    const ultimo = canal.last_failure
    motivos.push(
      `${canal.recent_failures} entrega(s) del webhook rechazadas`
      + (ultimo ? ` — la última: ${ultimo.provider} ${ultimo.status} (${ultimo.reason}).` : '.'),
    )
  }

  const horas = canal.hours_since_last_inbound
  if (typeof horas === 'number' && horas >= horasDeSilencio) {
    motivos.push(
      `Canal en silencio: ${horas} h sin un solo mensaje entrante `
      + `(el límite son ${horasDeSilencio} h).`,
    )
  }

  // El detalle solo añade lo que no se puede publicar sin token: saldo y
  // credenciales. Que no esté no es un problema; que traiga problemas, sí.
  if (detalle && Array.isArray(detalle.problemas) && detalle.problemas.length) {
    for (const problema of detalle.problemas) {
      motivos.push(
        `Registro [${problema.categoria}] ${problema.codigo || 'sin código'}: `
        + `${problema.veces} vez(ces), la última el ${problema.ultima_vez}.`,
      )
    }
  }

  return { sano: motivos.length === 0, caida, motivos }
}

/**
 * ¿Toca avisar? Aquí vive la regla que evita los 96 correos al día.
 *
 * `anteriorFueFallo` y `ultimoFalloHaceMs` salen de la propia historia de
 * ejecuciones de este workflow: no se guarda estado en ningún sitio.
 */
export function decidirAviso({ sano, caida = true, anteriorFueFallo, ultimoFalloHaceMs }) {
  if (sano) {
    return anteriorFueFallo
      ? { avisar: false, tipo: 'recuperado', caida }
      : { avisar: false, tipo: 'sigue-bien', caida }
  }
  if (!anteriorFueFallo) return { avisar: true, tipo: 'se-rompio', caida }
  const espera = caida ? RECORDATORIO_MS : RECORDATORIO_ATENCION_MS
  if (ultimoFalloHaceMs === null || ultimoFalloHaceMs >= espera) {
    return { avisar: true, tipo: 'recordatorio', caida }
  }
  return { avisar: false, tipo: 'sigue-roto', caida }
}

const TITULOS = {
  caida: {
    'se-rompio': '🔴 Producción ha caído',
    recordatorio: '🔴 Producción SIGUE caída',
    'sigue-roto': '🟠 Producción sigue caída (aviso ya enviado)',
    recuperado: '🟢 Producción se ha recuperado',
    'sigue-bien': '🟢 Producción en orden',
  },
  atencion: {
    'se-rompio': '🟠 Producción necesita atención',
    recordatorio: '🟠 Producción SIGUE necesitando atención',
    'sigue-roto': '🟡 Pendiente de atender (aviso ya enviado)',
    recuperado: '🟢 Resuelto',
    'sigue-bien': '🟢 Producción en orden',
  },
}

export const tituloDe = (tipo, caida) => TITULOS[caida ? 'caida' : 'atencion'][tipo]

/** El resumen que se lee en GitHub al abrir el run. */
export function redactarResumen({ tipo, motivos, salud, caida = true }) {
  const lineas = [`## ${tituloDe(tipo, caida)}`, '']

  if (motivos.length) {
    lineas.push('### Qué se encontró', '')
    for (const motivo of motivos) lineas.push(`- ${motivo}`)
    lineas.push('')
  }

  if (salud) {
    const canal = salud.inbound_channel || {}
    lineas.push(
      '### Estado',
      '',
      `- Commit vivo: \`${salud.version || '?'}\``,
      `- Último mensaje entrante: ${canal.last_inbound_at || 'nunca'}`
      + (typeof canal.hours_since_last_inbound === 'number'
        ? ` (hace ${canal.hours_since_last_inbound} h)`
        : ''),
      `- Cola de webhooks: ${salud.webhook_inbox?.ready ? 'lista' : 'NO lista'}`,
      `- Última vuelta del canario: ${salud.canario?.at || 'todavía ninguna'}`,
      '',
    )
  }

  if (tipo === 'sigue-roto') {
    lineas.push(
      '> El aviso ya se envió cuando esto empezó. Se repetirá pasadas '
      + `${caida ? '4 h' : '24 h'} si el problema sigue ahí.`,
    )
  }

  return lineas.join('\n')
}

// ── De aquí abajo, el mundo real ────────────────────────────────────────────

async function pedirJson(url, cabeceras = {}) {
  try {
    const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(ESPERA_MS) })
    // ⚠️ El cuerpo se lee PASE LO QUE PASE con el código: `/api/health` contesta
    // 503 justamente cuando el proceso no puede trabajar, y ahí es donde viene
    // el motivo. Descartarlo por no ser un 200 dejaba al vigía diciendo «no
    // contesta» sobre un servidor que estaba explicándose.
    let cuerpo = null
    try { cuerpo = await respuesta.json() } catch { cuerpo = null }
    return { ok: respuesta.ok, status: respuesta.status, cuerpo }
  } catch (error) {
    return { ok: false, status: 0, cuerpo: null, error: error.message }
  }
}

/**
 * La conclusión de la ejecución ANTERIOR de este mismo workflow, que es toda la
 * memoria que necesita el vigía. Si no se puede consultar, se asume que la
 * anterior fue bien: más vale un aviso de más que un silencio.
 */
async function historiaPrevia({ repo, workflow, token, runActual }) {
  if (!token) return { anteriorFueFallo: false, ultimoFalloHaceMs: null }
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs`
    + '?status=completed&per_page=20'
  const { ok, cuerpo } = await pedirJson(url, {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
  })
  if (!ok || !cuerpo?.workflow_runs) return { anteriorFueFallo: false, ultimoFalloHaceMs: null }

  const previos = cuerpo.workflow_runs.filter(run => String(run.id) !== String(runActual))
  const anterior = previos[0]
  const ultimoFallo = previos.find(run => run.conclusion === 'failure')
  return {
    anteriorFueFallo: anterior?.conclusion === 'failure',
    ultimoFalloHaceMs: ultimoFallo
      ? Date.now() - new Date(ultimoFallo.created_at).getTime()
      : null,
  }
}

async function main() {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '')
  if (!base) {
    console.error('❌ Falta BASE_URL: el vigía no sabe a quién preguntar.')
    process.exit(1)
  }

  const salud = await pedirJson(`${base}/api/health`)
  const token = (process.env.HEALTH_DETAIL_TOKEN || '').trim()
  const detalle = token
    ? await pedirJson(`${base}/api/health/detalle`, { authorization: `Bearer ${token}` })
    : { ok: false, cuerpo: null }

  const cuerpoSalud = salud.cuerpo
  // Un detalle que contestó 404 (sin token o sin desplegar) no es un problema:
  // se descarta y se sigue con lo que sí dijo `/api/health`.
  const { sano, caida, motivos } = evaluarSalud({
    salud: cuerpoSalud,
    detalle: detalle.ok ? detalle.cuerpo : null,
  })

  if (token && !detalle.ok) {
    console.log(`⚠️  El detalle no contestó (${detalle.status}). Se sigue solo con /api/health.`)
  }

  const previa = await historiaPrevia({
    repo: process.env.GITHUB_REPOSITORY,
    workflow: process.env.VIGIA_WORKFLOW || 'vigia.yml',
    token: process.env.GITHUB_TOKEN,
    runActual: process.env.GITHUB_RUN_ID,
  })

  const { avisar, tipo } = decidirAviso({ sano, caida, ...previa })
  const resumen = redactarResumen({ tipo, motivos, salud: cuerpoSalud, caida })

  console.log(resumen)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${resumen}\n`)
  }

  if (avisar) {
    console.error(`\n❌ ${tituloDe(tipo, caida)} — se avisa.`)
    process.exit(1)
  }
  console.log(`\n✅ Sin aviso nuevo (${tipo}).`)
}

// Solo corre cuando se ejecuta como programa: importado desde las pruebas, no.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

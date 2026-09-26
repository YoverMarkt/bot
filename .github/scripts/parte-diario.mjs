#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EL PARTE DIARIO — el único que dice «todo va bien»
// ═══════════════════════════════════════════════════════════════════════════
//
// Los dos vigías avisan FALLANDO, y GitHub solo manda correo cuando un run
// termina en rojo. Eso tiene una consecuencia que se vio al usarlo: cuando
// todo va bien no llega nada, y «nada» no se distingue de «el workflow dejó
// de ejecutarse». El dueño lo dijo con estas palabras: «me llegan muchas
// notificaciones, pero todas de errores y ninguna de OK».
//
// Este workflow es la otra mitad: una vez al día escribe el estado en un
// ISSUE de GitHub. Un comentario nuevo en un issue al que estás suscrito sí
// notifica, así que el OK llega por el mismo canal que las alarmas — sin
// cuentas nuevas, sin credenciales de envío y sin Telegram, que el dueño no
// usa.
//
// ⚠️ Este script NO decide si algo está mal: eso lo hace `evaluarSalud`, que
// vive en `vigia.mjs` y está probada. Aquí solo se redacta y se publica, y
// **nunca falla por lo que encuentre**: si el parte hiciera rojo, volvería a
// ser una alarma más y el correo diario dejaría de leerse. Solo termina en
// rojo si no pudo publicar el parte.

import { pathToFileURL } from 'node:url'
import { evaluarSalud } from './vigia.mjs'

/** El issue donde se acumulan los partes. Se busca por esta etiqueta. */
export const ETIQUETA = 'parte-diario'
const TITULO_ISSUE = 'Parte diario de producción'
const ESPERA_MS = 20_000

/**
 * El semáforo del día. Se mira `caida` además de `sano` porque un saldo bajo y
 * un bot muerto no son la misma noticia, y el parte se lee de un vistazo por
 * el emoji del título.
 */
export function semaforo({ sano, caida }) {
  if (sano) return { emoji: '🟢', texto: 'Todo en orden' }
  return caida
    ? { emoji: '🔴', texto: 'Producción caída' }
    : { emoji: '🟠', texto: 'Hay algo que atender' }
}

/**
 * El parte de un día, en markdown. Función pura: recibe lo que contestó
 * producción y devuelve el texto, para poder comprobarlo sin red.
 */
export function redactarParte({ salud, detalle, sano, caida, motivos, fecha, publico = false }) {
  const { emoji, texto } = semaforo({ sano, caida })
  const dia = fecha.toLocaleDateString('es-EC', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Guayaquil',
  })
  const hora = fecha.toLocaleTimeString('es-EC', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil',
  })

  const lineas = [`## ${emoji} ${texto}`, '', `**${dia}, ${hora}** (hora de Ecuador)`, '']

  // ⚠️ EN UN REPOSITORIO PÚBLICO EL PARTE NO DA DETALLES, y no es prudencia de
  // más: `YoverMarkt/umbani` es público, así que un issue diario contando que al
  // canal le queda saldo para dos mensajes, que lleva 30 h sin un pedido o que
  // producción está caída es un informe operativo del negocio, indexable y
  // permanente, para cualquiera. El semáforo sí se puede decir: sirve para lo
  // que existe este parte —saber que se sigue mirando— y no dice nada que se
  // pueda aprovechar.
  //
  // El detalle sigue estando en la pestaña Actions, donde ya estaba, y en el
  // correo de los vigías, que solo le llega a quien tiene acceso.
  if (publico) {
    lineas.push(
      sano
        ? 'Producción respondió con normalidad.'
        : `Hay ${motivos.length} cosa(s) que atender. **El detalle está en la `
          + 'pestaña Actions**, no aquí: este repositorio es público.',
      '',
      '---',
      '',
      '_Parte diario. Llega aunque no pase nada, para que el silencio de los '
      + 'vigías no se confunda con que dejaron de mirar._',
    )
    return lineas.join('\n')
  }

  if (motivos.length) {
    lineas.push('### Qué hay que mirar', '')
    for (const motivo of motivos) lineas.push(`- ${motivo}`)
    lineas.push('')
  }

  if (salud) {
    const canal = salud.inbound_channel || {}
    const canario = salud.canario
    lineas.push(
      '### Cómo está',
      '',
      `| | |`,
      `|---|---|`,
      `| Bot | ${salud.ok === true ? '✅ respondiendo' : '❌ no puede trabajar'} |`,
      `| Cola de webhooks | ${salud.webhook_inbox?.ready ? '✅ lista' : '❌ NO lista'} |`,
      `| Último mensaje | ${typeof canal.hours_since_last_inbound === 'number'
        ? `hace ${canal.hours_since_last_inbound} h`
        : 'nunca'} |`,
      `| Canario | ${canario
        ? `${Number(canario.fallos) > 0 ? '❌' : '✅'} ${canario.fallos} fallo(s) sobre `
          + `${canario.revisados ?? '?'} local(es)`
        : 'todavía ninguna vuelta'} |`,
      `| Commit vivo | \`${salud.version || '?'}\` |`,
      '',
    )
  } else {
    lineas.push('> Producción no contestó al pedir el parte.', '')
  }

  if (!detalle) {
    lineas.push(
      '> Sin `HEALTH_DETAIL_TOKEN` no se ven el saldo ni las credenciales: '
      + 'este parte cubre solo lo público.',
      '',
    )
  }

  lineas.push(
    '---',
    '',
    sano
      ? '_Nada que hacer. Este parte llega una vez al día para que el silencio '
        + 'de los vigías no se confunda con que dejaron de mirar._'
      : '_Los vigías avisan aparte cuando esto empieza; el parte lo repite una '
        + 'vez al día mientras siga ahí._',
  )

  return lineas.join('\n')
}

// ── De aquí abajo, el mundo real ────────────────────────────────────────────

async function pedirJson(url, cabeceras = {}) {
  try {
    const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(ESPERA_MS) })
    let cuerpo = null
    try { cuerpo = await respuesta.json() } catch { cuerpo = null }
    return { ok: respuesta.ok, status: respuesta.status, cuerpo }
  } catch (error) {
    return { ok: false, status: 0, cuerpo: null, error: error.message }
  }
}

async function github(ruta, { token, metodo = 'GET', cuerpo } = {}) {
  const respuesta = await fetch(`https://api.github.com${ruta}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(ESPERA_MS),
  })
  const datos = await respuesta.json().catch(() => null)
  if (!respuesta.ok) {
    throw new Error(`GitHub ${metodo} ${ruta} → ${respuesta.status}: ${datos?.message || '?'}`)
  }
  return datos
}

/**
 * El issue donde vive el parte. Se busca por etiqueta y, si no existe, se crea
 * asignado al dueño — un asignado queda suscrito, que es lo que hace que el
 * comentario diario le llegue de verdad.
 */
async function issueDelParte({ repo, token, dueno }) {
  const abiertos = await github(
    `/repos/${repo}/issues?state=open&labels=${ETIQUETA}&per_page=1`,
    { token },
  )
  if (Array.isArray(abiertos) && abiertos.length) return abiertos[0].number

  // La etiqueta puede no existir todavía. Crearla dos veces da 422, y eso no
  // es un problema: se ignora.
  await github(`/repos/${repo}/labels`, {
    token,
    metodo: 'POST',
    cuerpo: { name: ETIQUETA, color: '0E8A16', description: 'El parte diario de producción' },
  }).catch(() => null)

  const creado = await github(`/repos/${repo}/issues`, {
    token,
    metodo: 'POST',
    cuerpo: {
      title: TITULO_ISSUE,
      labels: [ETIQUETA],
      assignees: dueno ? [dueno] : [],
      body: 'Aquí se publica una vez al día cómo está producción.\n\n'
        + 'Los vigías (`vigia.yml` y `vigia-atencion.yml`) avisan **fallando** '
        + 'cuando algo se rompe. Este issue es lo contrario: confirma que se '
        + 'sigue mirando aunque no haya nada que decir.\n\n'
        + '> Cerrarlo no rompe nada: al día siguiente se abre uno nuevo.',
    },
  })
  return creado.number
}

async function main() {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '')
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!base || !token || !repo) {
    console.error('❌ Falta BASE_URL, GITHUB_TOKEN o GITHUB_REPOSITORY.')
    process.exit(1)
  }

  const salud = await pedirJson(`${base}/api/health`)
  const tokenDetalle = (process.env.HEALTH_DETAIL_TOKEN || '').trim()
  const detalle = tokenDetalle
    ? await pedirJson(`${base}/api/health/detalle`, { authorization: `Bearer ${tokenDetalle}` })
    : { ok: false, cuerpo: null }

  const { sano, caida, motivos } = evaluarSalud({
    salud: salud.cuerpo,
    detalle: detalle.ok ? detalle.cuerpo : null,
  })

  // Se le pregunta a GitHub en vez de fiarlo a una variable: el día que el
  // repositorio cambie de visibilidad, el parte se ajusta solo. Si no se
  // puede saber, se asume PÚBLICO — equivocarse hacia el silencio no cuesta
  // nada, y hacia el otro lado publica el saldo del canal en internet.
  const info = await github(`/repos/${repo}`, { token }).catch(() => null)
  const publico = info ? info.private !== true : true

  const parte = redactarParte({
    salud: salud.cuerpo,
    detalle: detalle.ok ? detalle.cuerpo : null,
    sano,
    caida,
    motivos,
    fecha: new Date(),
    publico,
  })

  console.log(parte)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${parte}\n`)
  }

  const numero = await issueDelParte({ repo, token, dueno: process.env.PARTE_DUENO })
  await github(`/repos/${repo}/issues/${numero}/comments`, {
    token,
    metodo: 'POST',
    cuerpo: { body: parte },
  })
  console.log(`✅ Parte publicado en el issue #${numero}.`)
}

// Solo corre cuando se ejecuta directo: importarlo desde las pruebas no debe
// llamar a GitHub.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ No se pudo publicar el parte: ${error.message}`)
    process.exit(1)
  })
}

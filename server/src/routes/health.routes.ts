// ── DETALLE DE SALUD PARA EL VIGÍA EXTERNO ──────────────────────────────────
//
// `/api/health` (en `src/index.ts`) es público y cuenta lo que se le puede
// contar a cualquiera: si el proceso vive, qué commit corre, cuándo entró el
// último mensaje. Con eso, un vigía de fuera ya detecta que el bot se cayó —
// que es el único fallo que un vigía de DENTRO nunca podrá avisar.
//
// Lo que no se puede publicar ahí es justo lo que más avisa de un apagón
// inminente: que al número le quedan 0,50 USD de saldo, o que el webhook dejó
// de apuntar aquí. Eso ya lo detecta `services/credential-monitor` cada 6 h y
// lo deja en el registro de errores… donde solo lo ve quien abre el panel del
// superadmin. Abrir el panel es exactamente lo que nadie hace de madrugada, y
// por eso el canal estuvo mudo cinco días en julio de 2026.
//
// Este endpoint es el puente: el mismo registro, resumido y detrás de un token
// dedicado, para que el vigía lo lea cada pocos minutos.
//
// ── TRES DECISIONES DE SEGURIDAD, y ninguna sobra ───────────────────────────
//
//  1. **Sin token configurado la ruta NO EXISTE** (404). Un despliegue que se
//     olvide la variable deja una pared, no una puerta abierta.
//  2. **Un token que no cuadra da 404 también**, nunca 401. Un 401 confirma que
//     aquí hay algo que vale la pena forzar; un 404 no dice nada.
//  3. **No devuelve mensajes, ni contexto, ni el negocio.** Solo categoría,
//     código y cuántas veces. Con eso se decide si sonar la alarma, y ni un
//     dato de un cliente viaja hasta un runner de GitHub.
//
// ⚠️ NO pregunta a los proveedores en vivo: lee lo que `credential-monitor` ya
// dejó escrito. Si consultara a YCloud en cada petición, este endpoint sería la
// forma más cómoda de gastarle a alguien su cuota desde fuera.
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { createRouter } from '../middleware/async'

interface FilaDeErrores {
  category: string
  code: string | null
  occurrences: number
  last_seen_at: string
}
interface ModuloDb {
  getPlatformErrorSummary(options?: { sinceHours?: number }): Promise<{
    sinceHours: number
    rows: FilaDeErrores[]
  }>
}
const db: ModuloDb = require('../db') as typeof import('../db')

// Sin `export`: el router se expone con `export =`, que no admite mezclar.
/** Variable de entorno con el token. Vacía o ausente = la ruta no existe. */
const TOKEN_ENV = 'HEALTH_DETAIL_TOKEN'

interface ProblemaResumido {
  categoria: string
  codigo: string | null
  /**
   * ⚠️ Es el total histórico de esa huella, no el de la ventana: la fila agrupa
   * desde `first_seen_at` y solo se filtra por `last_seen_at`. Sirve para
   * decidir si algo sigue vivo, no para contar con precisión.
   */
  veces: number
  ultima_vez: string
}

const router = createRouter()

function tokenConfigurado(): string {
  return (process.env[TOKEN_ENV] || '').trim()
}

/**
 * Comparación en tiempo constante sobre el sha256 de cada valor.
 *
 * Se comparan los HASHES y no los textos porque `timingSafeEqual` revienta si
 * los búferes miden distinto — y esa excepción, al llegar antes para un token
 * de largo equivocado, filtraría la longitud del bueno. El hash iguala el
 * tamaño siempre.
 */
function tokenCoincide(presentado: string, esperado: string): boolean {
  const huella = (valor: string) => crypto.createHash('sha256').update(valor).digest()
  return crypto.timingSafeEqual(huella(presentado), huella(esperado))
}

/** El token viaja en `Authorization: Bearer <token>`, nunca en la URL: una query string acaba en los logs de cualquier proxy por el que pase. */
function tokenPresentado(req: Request): string {
  const cabecera = req.headers.authorization
  if (typeof cabecera !== 'string') return ''
  const [esquema, valor] = cabecera.split(' ')
  if (!valor || esquema.toLowerCase() !== 'bearer') return ''
  return valor.trim()
}

/** Agrupa por categoría + código. Lo demás ya viene descartado de la base. */
function resumirProblemas(filas: FilaDeErrores[]): ProblemaResumido[] {
  const porClave = new Map<string, ProblemaResumido>()
  for (const fila of filas) {
    const clave = `${fila.category}|${fila.code || ''}`
    const previo = porClave.get(clave)
    if (!previo) {
      porClave.set(clave, {
        categoria: fila.category,
        codigo: fila.code,
        veces: fila.occurrences,
        ultima_vez: fila.last_seen_at,
      })
      continue
    }
    previo.veces += fila.occurrences
    if (fila.last_seen_at > previo.ultima_vez) previo.ultima_vez = fila.last_seen_at
  }
  return [...porClave.values()].sort((a, b) => b.ultima_vez.localeCompare(a.ultima_vez))
}

router.get('/api/health/detalle', async (req: Request, res: Response) => {
  const esperado = tokenConfigurado()
  // Las dos puertas contestan lo MISMO a propósito: «aquí no hay nada».
  if (!esperado) return res.status(404).json({ error: 'no encontrado' })
  const presentado = tokenPresentado(req)
  if (!presentado || !tokenCoincide(presentado, esperado)) {
    return res.status(404).json({ error: 'no encontrado' })
  }

  const horas = Number((req.query as Record<string, unknown>).horas)
  const resumen = await db.getPlatformErrorSummary({
    sinceHours: Number.isFinite(horas) && horas > 0 ? horas : 24,
  })
  const problemas = resumirProblemas(resumen.rows)

  res.json({
    ok: problemas.length === 0,
    ventana_horas: resumen.sinceHours,
    problemas,
  })
})

export = router

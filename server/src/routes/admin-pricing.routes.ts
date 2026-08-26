import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// REGLAS DE MARGEN — SOLO SUPERADMIN
// ═══════════════════════════════════════════════════════════════════════════
//
// Sin estas rutas el motor de margen está instalado y APAGADO: no había forma
// de crear una regla, así que ningún negocio podía cobrar comisión.
//
// El saneamiento de aquí replica los CHECK de `pricing_rules` a propósito, el
// mismo criterio que sigue `product-options.routes.ts`: así el superadmin lee
// «el porcentaje va entre 0 y 100» en vez de un error de restricción de
// PostgreSQL. La base sigue siendo la que manda.

/** Una regla ya comprobada, con la forma exacta que guarda la base. */
interface ReglaSaneada {
  scope: string
  strategy: string
  markup_mode: string
  business_id: string | null
  target_name: string | null
  percentage: number | null
  fixed_amount: number | null
  tiers: Array<{ up_to: number | null, amount: number }> | null
  min_amount: number | null
  max_amount: number | null
  notes: string | null
}

interface RespuestaDb {
  data?: unknown
  error?: { message?: string } | null
}

interface ModuloDb {
  listPricingRules(): Promise<unknown[]>
  listBusinessFamilies(): Promise<unknown[]>
  createPricingRule(rule: ReglaSaneada): Promise<RespuestaDb>
  replacePricingRule(id: string, rule: ReglaSaneada): Promise<RespuestaDb>
  archivePricingRule(id: string): Promise<RespuestaDb>
  getPlatformMarkupSummary(from: string, to: string, businessId?: string | null): Promise<unknown[]>
}
const db: ModuloDb = require('../db') as typeof import('../db')

interface ModuloAuth {
  authAdmin: RequestHandler
}
const { authAdmin }: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

// `family` agrupa los 30 tipos clasificados en dos: una regla para «comida»
// cubre 24. Antes había que crear 24 reglas iguales y una más por cada tipo.
const SCOPES = new Set(['global', 'family', 'business_type', 'business'])
const STRATEGIES = new Set(['percentage', 'fixed', 'tiered'])
// Los dos modos, desde el 2026-08-25. `on_top` estuvo cerrado hasta que el
// catálogo, el carrito y el resumen pintaron el precio con margen — que era la
// condición escrita en el CHECK de la base—; ahora existen y el freno se
// levantó en `migration-2026-08-29-margen-sobre-el-precio.sql`.
//
// ⚠️ `absorbed` NO se retira: los pedidos ya sellados con él deben poder
// seguir liquidándose como se cobraron.
const MODES = new Set(['absorbed', 'on_top'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (v: unknown): v is Record<string, unknown> => (
  typeof v === 'object' && v !== null && !Array.isArray(v)
)

/** Un importe opcional. Devuelve `undefined` si es inválido, `null` si no vino. */
const importe = (valor: unknown): number | null | undefined => {
  if (valor === undefined || valor === null || valor === '') return null
  const n = Number(valor)
  if (!Number.isFinite(n) || n < 0 || n > 9999) return undefined
  return Math.round(n * 100) / 100
}

/**
 * Comprueba y normaliza una regla.
 *
 * Devuelve el mensaje de error en español, o la regla lista para guardar.
 */
const sanearRegla = (body: unknown): { error: string } | { rule: ReglaSaneada } => {
  if (!isRecord(body)) return { error: 'Falta el cuerpo de la regla.' }

  const scope = String(body.scope || '').trim()
  if (!SCOPES.has(scope)) {
    return { error: 'El ámbito tiene que ser global, family, business_type o business.' }
  }

  const strategy = String(body.strategy || '').trim()
  if (!STRATEGIES.has(strategy)) {
    return { error: 'La estrategia tiene que ser percentage, fixed o tiered.' }
  }

  // El modelo del negocio es `on_top`: el comercio cobra su precio entero y el
  // margen se suma al del cliente. Se mantiene como valor por defecto.
  const markupMode = String(body.markup_mode || 'on_top').trim()
  if (!MODES.has(markupMode)) {
    return { error: 'El margen se suma al precio (on_top) o sale del precio del comercio (absorbed).' }
  }

  // Cada ámbito exige exactamente sus datos. Sin esto, una regla «de negocio»
  // sin negocio se guardaría como global y afectaría a TODO el SaaS.
  const businessId = typeof body.business_id === 'string' ? body.business_id.trim() : ''
  const targetName = typeof body.target_name === 'string' ? body.target_name.trim() : ''

  if (scope === 'business' && !UUID.test(businessId)) {
    return { error: 'Una regla de negocio necesita a qué negocio se aplica.' }
  }
  if (scope === 'business_type' && !targetName) {
    return { error: 'Una regla por tipo necesita el nombre del tipo de negocio.' }
  }
  // Sin familia, una regla de familia se aplicaría a TODA la plataforma.
  if (scope === 'family' && !targetName) {
    return { error: 'Una regla por familia necesita a qué familia se aplica.' }
  }

  const regla: ReglaSaneada = {
    scope,
    strategy,
    markup_mode: markupMode,
    business_id: scope === 'business' ? businessId : null,
    target_name: scope === 'business_type' || scope === 'family' ? targetName.slice(0, 80) : null,
    percentage: null,
    fixed_amount: null,
    tiers: null,
    min_amount: null,
    max_amount: null,
    notes: typeof body.notes === 'string' ? body.notes.trim().slice(0, 300) || null : null,
  }

  if (strategy === 'percentage') {
    const pct = Number(body.percentage)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { error: 'El porcentaje va entre 0 y 100.' }
    }
    regla.percentage = Math.round(pct * 10000) / 10000
  } else if (strategy === 'fixed') {
    const monto = importe(body.fixed_amount)
    if (monto === undefined || monto === null) {
      return { error: 'Un margen fijo necesita su monto, entre 0 y 9999.' }
    }
    regla.fixed_amount = monto
  } else {
    if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
      return { error: 'Los tramos tienen que ser una lista con al menos uno.' }
    }
    const tramos: Array<{ up_to: number | null, amount: number }> = []
    for (const bruto of body.tiers) {
      if (!isRecord(bruto)) return { error: 'Cada tramo tiene que ser un objeto.' }
      const monto = importe(bruto.amount)
      if (monto === undefined || monto === null) {
        return { error: 'Cada tramo necesita su monto, entre 0 y 9999.' }
      }
      const techo = bruto.up_to === undefined || bruto.up_to === null || bruto.up_to === ''
        ? null
        : Number(bruto.up_to)
      if (techo !== null && (!Number.isFinite(techo) || techo <= 0)) {
        return { error: 'El techo de un tramo tiene que ser mayor que cero.' }
      }
      tramos.push({ up_to: techo, amount: monto })
    }
    // Como mucho un tramo sin techo: dos harían impredecible cuál se aplica.
    if (tramos.filter(t => t.up_to === null).length > 1) {
      return { error: 'Solo puede haber un tramo sin techo.' }
    }
    regla.tiers = tramos
  }

  const piso = importe(body.min_amount)
  const techo = importe(body.max_amount)
  if (piso === undefined) return { error: 'El mínimo va entre 0 y 9999.' }
  if (techo === undefined) return { error: 'El máximo va entre 0 y 9999.' }
  if (piso !== null && techo !== null && piso > techo) {
    return { error: 'El mínimo no puede ser mayor que el máximo.' }
  }
  regla.min_amount = piso
  regla.max_amount = techo

  return { rule: regla }
}

/**
 * El primer día del mes EN ECUADOR, en texto ISO.
 *
 * El servidor corre en UTC: a las 00:30 del 1 de septiembre en Londres, en
 * Ecuador siguen siendo las 19:30 del 31 de agosto. Calculando el mes en UTC,
 * el dueño vería su acumulado reiniciarse cinco horas antes de tiempo.
 */
const inicioDeMesEnEcuador = (desplazamiento = 0): string => {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const anio = Number(partes.find(p => p.type === 'year')?.value)
  const mes = Number(partes.find(p => p.type === 'month')?.value)
  const d = new Date(Date.UTC(anio, mes - 1 + desplazamiento, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

const router = createRouter()

// Las familias, para que el panel las ofrezca en vez de escribirlas. Desde el
// 2026-08-20 son dos —comida y retail—: las otras tres se fueron con los tipos
// de hospedaje, servicios y salud que colgaban de ellas.
router.get('/api/admin/business-families', authAdmin, async (_req, res) => {
  res.json(await db.listBusinessFamilies())
})

router.get('/api/admin/pricing-rules', authAdmin, async (_req, res) => {
  res.json(await db.listPricingRules())
})

router.post('/api/admin/pricing-rules', authAdmin, async (req, res) => {
  const saneada = sanearRegla(req.body)
  if ('error' in saneada) return res.status(400).json({ error: saneada.error })

  const { data, error } = await db.createPricingRule(saneada.rule)
  if (error) {
    // El índice único impide dos reglas activas para el mismo destino: sin
    // este mensaje el superadmin leería una violación de índice.
    const duplicada = String(error.message || '').includes('idx_pricing_rules_activa')
    return res.status(duplicada ? 409 : 400).json({
      error: duplicada
        ? 'Ese destino ya tiene una regla activa. Reemplázala en vez de crear otra.'
        : 'No se pudo guardar la regla.',
    })
  }
  res.status(201).json(data)
})

// Reemplazar crea una VERSIÓN nueva y archiva la anterior; no edita en sitio,
// porque los pedidos ya sellados apuntan a la versión que les tocó.
router.put('/api/admin/pricing-rules/:id', authAdmin, async (req, res) => {
  if (!UUID.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Identificador de regla inválido.' })
  }
  const saneada = sanearRegla(req.body)
  if ('error' in saneada) return res.status(400).json({ error: saneada.error })

  const { data, error } = await db.replacePricingRule(String(req.params.id), saneada.rule)
  if (error) return res.status(400).json({ error: 'No se pudo reemplazar la regla.' })
  res.json(data)
})

router.delete('/api/admin/pricing-rules/:id', authAdmin, async (req, res) => {
  if (!UUID.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Identificador de regla inválido.' })
  }
  const { error } = await db.archivePricingRule(String(req.params.id))
  if (error) return res.status(400).json({ error: 'No se pudo archivar la regla.' })
  res.json({ ok: true })
})

/**
 * El simulador (§42): cuánto dejaría una regla ANTES de activarla.
 *
 * Usa el espejo en TypeScript, no la base, porque la regla todavía no existe:
 * el superadmin está escribiéndola. Los dos motores comparten los mismos casos
 * de prueba justo para que lo que se simula sea lo que se cobrará.
 */
router.post('/api/admin/pricing-rules/simulate', authAdmin, async (req, res) => {
  const saneada = sanearRegla(req.body)
  if ('error' in saneada) return res.status(400).json({ error: saneada.error })

  const subtotal = Number(isRecord(req.body) ? req.body.subtotal : NaN)
  if (!Number.isFinite(subtotal) || subtotal < 0 || subtotal > 999999) {
    return res.status(400).json({ error: 'El subtotal a simular va entre 0 y 999999.' })
  }

  const { calculatePlatformMarkup } = require('../services/platform-pricing') as
    typeof import('../services/platform-pricing')
  const r = saneada.rule

  res.json(calculatePlatformMarkup(subtotal, {
    strategy: r.strategy as 'percentage' | 'fixed' | 'tiered',
    percentage: r.percentage,
    fixedAmount: r.fixed_amount,
    tiers: r.tiers?.map(t => ({ upTo: t.up_to, amount: t.amount })) ?? null,
    minAmount: r.min_amount,
    maxAmount: r.max_amount,
    markupMode: r.markup_mode as 'absorbed' | 'on_top',
  }))
})

/** Cuánto lleva acumulado cada comercio. Sin negocio: todos. */
router.get('/api/admin/pricing-summary', authAdmin, async (req, res) => {
  const desde = typeof req.query.from === 'string' && req.query.from
    ? req.query.from
    : inicioDeMesEnEcuador(0)
  const hasta = typeof req.query.to === 'string' && req.query.to
    ? req.query.to
    : inicioDeMesEnEcuador(1)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ error: 'Las fechas van en formato AAAA-MM-DD.' })
  }
  res.json(await db.getPlatformMarkupSummary(desde, hasta, null))
})

export = router

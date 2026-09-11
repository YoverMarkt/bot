import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

// El horario de atención del negocio.
//
// Vivía en `bookings.routes.ts` y se quedó cuando la agenda se retiró: no es
// una función de citas, es lo que decide si la tienda acepta pedidos y si el
// bot atiende o contesta que está cerrado (`services/schedule.ts`). Una
// pizzería sin agenda tiene horario igual, y sin estas rutas el dueño no
// podría cambiarlo.
//
// `slot_duration` sigue en la tabla porque era de la agenda y quitarlo
// obligaría a reescribir filas que nadie lee; el panel ya no lo envía.

interface DatabaseResult {
  error?: { message?: string } | null
}

interface ModuloDb {
  getSchedule(businessId: string): Promise<unknown>
  upsertSchedule(businessId: string, days: unknown): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')

interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const puedeVerHorarios = auth.requirePermission('horarios')

router.get('/api/client/schedule', auth.authClient, puedeVerHorarios, async (req, res) => {
  res.json(await db.getSchedule(getClientBusinessId(req)))
})

router.put('/api/client/schedule', auth.authClient, puedeVerHorarios, async (req, res) => {
  // `req.body.days` llegaba directo a `upsertSchedule`, que hace `.map()` sobre
  // él. Un cuerpo sin `days` reventaba con «Cannot read properties of undefined»
  // y devolvía 500: un fallo del cliente contado como fallo del servidor, que
  // además ensucia el registro de errores y tapa los de verdad.
  const { days } = (req.body ?? {}) as { days?: unknown }
  if (!Array.isArray(days) || days.length === 0) {
    return res.status(400).json({ error: 'Falta el horario' })
  }
  if (days.length > 7 || days.some(dia => !dia || typeof dia !== 'object')) {
    return res.status(400).json({ error: 'El horario no es válido' })
  }
  // ⚠️ Un día ACTIVO que abre y cierra a la misma hora es un tramo de duración
  // CERO: ese día el local queda cerrado entero. Hasta hoy se guardaba sin
  // decir nada, y `00:00 – 00:00` es justo lo que escribe quien quiere poner
  // «de medianoche a medianoche» — el dueño creía haber abierto 24 h y sus
  // clientes veían «Cerrado» todo el día. Se rechaza diciendo dónde está la
  // opción de verdad, porque un error sin salida es lo que acaba en abandono.
  const hora = (valor: unknown) => String(valor ?? '').slice(0, 5)
  const filas = days as Record<string, unknown>[]
  if (filas.some(dia => dia.is_24h !== undefined && typeof dia.is_24h !== 'boolean')) {
    return res.status(400).json({ error: 'El horario no es válido' })
  }
  const vacio = filas.find(dia => (
    dia.is_active === true
    && dia.is_24h !== true
    && hora(dia.open_time) === hora(dia.close_time)
  ))
  if (vacio) {
    return res.status(400).json({
      error: 'Un día no puede abrir y cerrar a la misma hora. Si ese día atiendes sin parar, marca «Abierto 24 horas».',
    })
  }
  const { error } = await db.upsertSchedule(getClientBusinessId(req), days as never)
  if (error) {
    console.error('❌ actualizar horarios:', error.message || 'Error desconocido')
    return res.status(500).json({ error: 'No se pudieron actualizar los horarios' })
  }
  res.json({ ok: true })
})

export = router

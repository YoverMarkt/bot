export interface ScheduleRecord {
  day_of_week: number
  open_time: string
  close_time: string
  is_active?: boolean | null
}

const DAY_NAMES = [
  'Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado',
] as const

const activeDays = (schedule: ScheduleRecord[] | null | undefined) => (
  (schedule || []).filter(day => day.is_active)
)

// Convierte la configuración del panel a un texto compacto para el prompt.
function scheduleToText(schedule: ScheduleRecord[] | null | undefined): string | null {
  const active = activeDays(schedule)
  if (!active.length) return null
  const ordered = active.slice().sort((left, right) => (
    ((left.day_of_week + 6) % 7) - ((right.day_of_week + 6) % 7)
  ))
  return ordered.map(day => (
    `${DAY_NAMES[day.day_of_week]} de ${day.open_time.slice(0, 5)} a ${day.close_time.slice(0, 5)}`
  )).join(', ')
}

// Mensaje oficial fuera de horario: se arma solo con datos reales del negocio.
function buildScheduleMessage(
  _business: unknown,
  schedule: ScheduleRecord[] | null | undefined,
): string {
  const active = activeDays(schedule)
  const formatTime = (time: string) => String(time).slice(0, 5)
  const order = [1, 2, 3, 4, 5, 6, 0]
  const lines = order.map(dayOfWeek => {
    const config = active.find(day => day.day_of_week === dayOfWeek)
    return config
      ? `🕐 *${DAY_NAMES[dayOfWeek]}:* ${formatTime(config.open_time)} – ${formatTime(config.close_time)}`
      : `🚫 *${DAY_NAMES[dayOfWeek]}:* cerrado`
  })
  return `¡Gracias por escribirnos! 🙏 En este momento estamos *fuera de nuestro horario de atención* 🌙\n\n📅 *Nuestros horarios de atención:*\n${lines.join('\n')}\n\nDéjenos su mensaje y con gusto le responderemos apenas abramos 😊✨`
}

/** Los minutos desde medianoche de un «HH:MM» del panel. */
const minutosDe = (hora: string): number => {
  const [h, m] = String(hora).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * ¿Está el negocio abierto a esta hora, según la fila de ese día?
 *
 * ⚠️ El horario puede CRUZAR LA MEDIANOCHE. «09:00 a 01:00» significa que la
 * pizzería abre por la mañana y cierra a la una de la madrugada siguiente —es
 * el horario normal de media hostelería—, y comparando `abre <= ahora < cierra`
 * a secas ese negocio salía CERRADO LAS 24 HORAS: la condición no se cumple
 * nunca cuando el cierre es un número menor que la apertura.
 *
 * Se descubrió con un horario real de 09:00–01:00 a las 00:14: la tienda decía
 * estar cerrada y no dejaba pedir a nadie.
 */
const dentroDelTramo = (config: ScheduleRecord, minutos: number): boolean => {
  const abre = minutosDe(config.open_time)
  const cierra = minutosDe(config.close_time)
  // Cierre ANTERIOR a la apertura = el tramo salta al día siguiente.
  //
  // Estrictamente menor, no «menor o igual»: «00:00 a 00:00» es un tramo de
  // duración cero —ese día no se abre—, y tratarlo como cruce lo volvería un
  // negocio abierto 24 horas. Lo cazó una prueba del prompt del bot.
  if (cierra < abre) return minutos >= abre || minutos < cierra
  return minutos >= abre && minutos < cierra
}

// Evalúa la hora local de Ecuador. Sin horario activo no bloquea la atención.
function isOutsideHours(
  schedule: ScheduleRecord[] | null | undefined,
  now = new Date(),
): boolean {
  const active = activeDays(schedule)
  if (!active.length) return false
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
  const minutes = local.getHours() * 60 + local.getMinutes()

  // El tramo de HOY, y también el de AYER si se alargaba pasada la medianoche:
  // a las 00:30 de un jueves, quien sigue abierto es el turno del miércoles.
  const hoy = active.find(day => day.day_of_week === local.getDay())
  if (hoy && dentroDelTramo(hoy, minutes)) return false

  const ayer = active.find(day => day.day_of_week === (local.getDay() + 6) % 7)
  if (ayer && minutosDe(ayer.close_time) < minutosDe(ayer.open_time)
    && minutes < minutosDe(ayer.close_time)) {
    return false
  }
  return true
}

/**
 * El horario VIGENTE, para enseñarlo en la portada de la tienda: «10:00 – 23:00».
 *
 * No es lo mismo que «el tramo de hoy». A las 00:30 de un jueves, con el
 * miércoles configurado de 09:00 a 01:00, quien sigue abierto es el turno del
 * miércoles: enseñar el del jueves diría «abre a las 09:00» junto a una píldora
 * verde de «Abierto», y las dos cosas no pueden ser ciertas a la vez.
 *
 * Devuelve null cuando ese día no se abre, y la portada calla en vez de
 * inventar un horario.
 */
function todaysHours(
  schedule: ScheduleRecord[] | null | undefined,
  now = new Date(),
): { open: string; close: string } | null {
  const active = activeDays(schedule)
  if (!active.length) return null

  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
  const minutos = local.getHours() * 60 + local.getMinutes()

  // Primero la víspera, y solo si de verdad sigue viva: es la que manda en la
  // madrugada. Si no alcanza, el tramo de hoy.
  const vispera = active.find(day => day.day_of_week === (local.getDay() + 6) % 7)
  if (vispera
    && minutosDe(vispera.close_time) < minutosDe(vispera.open_time)
    && minutos < minutosDe(vispera.close_time)) {
    return { open: vispera.open_time.slice(0, 5), close: vispera.close_time.slice(0, 5) }
  }

  const hoy = active.find(day => day.day_of_week === local.getDay())
  return hoy ? { open: hoy.open_time.slice(0, 5), close: hoy.close_time.slice(0, 5) } : null
}

export { scheduleToText, buildScheduleMessage, isOutsideHours, todaysHours }

// ── PEDIDOS PROGRAMADOS ─────────────────────────────────────────────────────
//
// «Quiero mi almuerzo a la 1». Hasta ahora la tienda solo aceptaba pedidos
// inmediatos, así que fuera de horario no se podía pedir nada — y ese es justo
// el momento en que alguien decide qué va a comer.
//
// Las franjas se calculan CONTRA EL HORARIO REAL del negocio, en hora de
// Ecuador. Ofrecer una hora a la que el local está cerrado es peor que no
// ofrecer nada: el cliente programa, espera, y no llega su comida.

/**
 * El reloj del negocio, no el del servidor ni el del teléfono del cliente.
 *
 * Devuelve una fecha cuyos COMPONENTES (día, hora, minuto) son los de Ecuador.
 * Sirve para leerlos; no para convertirla de vuelta a un instante, porque el
 * objeto resultante está en la zona de quien lo ejecuta.
 */
const localEcuador = (date: Date): Date =>
  new Date(date.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))

/**
 * Cuántos minutos hay que sumar a una hora de Ecuador para obtener el instante
 * UTC que le corresponde.
 *
 * Se calcula en vez de fijarlo en 5 horas: si algún día el país cambiara de
 * huso, o el negocio se mudara de zona, el número dejaría de ser cierto y las
 * franjas saldrían desplazadas sin que nada avisara.
 */
const desfaseEcuador = (date: Date): number => {
  const enUtc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  return (enUtc.getTime() - localEcuador(date).getTime()) / 60_000
}

export interface SlotOptions {
  /** Cuánto tarda el negocio en tener el pedido listo. */
  preparationMinutes?: number
  /** Cada cuánto se ofrece una hora. */
  stepMinutes?: number
  /** Cuántos días hacia adelante se puede programar. */
  daysAhead?: number
  /** Tope de franjas devueltas, para no mandar una lista infinita al teléfono. */
  limit?: number
}

/**
 * Las horas a las que este negocio puede tener un pedido listo.
 *
 * Tres reglas que evitan una promesa que no se puede cumplir:
 *
 * · No se ofrece nada antes de `ahora + preparación`. Programar para dentro de
 *   cinco minutos una pizza que tarda treinta es prometer lo imposible.
 * · Solo horas dentro del horario del día, y **no la de cierre exacta**: a las
 *   22:00 en punto el local ya cerró.
 * · Sin horario configurado no se devuelve nada. Es mejor no ofrecer programar
 *   que ofrecer las 24 horas de un negocio que abre seis.
 */
export function scheduleSlots(
  schedule: ScheduleRecord[] | null | undefined,
  options: SlotOptions = {},
  now = new Date(),
): string[] {
  const active = activeDays(schedule)
  if (!active.length) return []

  const preparacion = Math.max(0, options.preparationMinutes ?? 30)
  const paso = Math.max(5, options.stepMinutes ?? 30)
  const dias = Math.min(14, Math.max(1, options.daysAhead ?? 7))
  const tope = Math.min(200, Math.max(1, options.limit ?? 48))

  const local = localEcuador(now)
  // El primer momento posible, en tiempo REAL: `local` solo sirve para leer
  // día y hora de Ecuador, y su `getTime()` no es un instante de verdad.
  // Compararlo con las franjas mezclaba dos relojes distintos.
  const desde = now.getTime() + preparacion * 60_000

  // El desfase se calcula UNA vez: el instante que se devuelve tiene que ser
  // el mismo lo ejecute un servidor en Quito o uno en UTC. Construir la fecha
  // con `setHours` sobre la zona del proceso desplazaba todas las franjas —lo
  // cazó el CI, que corre en UTC, cuando en local pasaba.
  const desfase = desfaseEcuador(now)
  const franjas: string[] = []

  for (let dia = 0; dia < dias && franjas.length < tope; dia += 1) {
    const fecha = new Date(local)
    fecha.setDate(fecha.getDate() + dia)
    const config = active.find(item => item.day_of_week === fecha.getDay())
    if (!config) continue

    const abre = minutosDe(config.open_time)
    const cierraCrudo = minutosDe(config.close_time)
    // Un cierre pasada la medianoche se cuenta como minutos del día siguiente:
    // «09:00 a 01:00» son 540 a 1500, no 540 a 60.
    const cierra = cierraCrudo < abre ? cierraCrudo + 24 * 60 : cierraCrudo
    if (cierra <= abre) continue

    // Se empieza en la apertura, para que las horas salgan en punto y no a
    // las 13:07.
    for (let minuto = abre; minuto < cierra && franjas.length < tope; minuto += paso) {
      const momento = new Date(Date.UTC(
        fecha.getFullYear(), fecha.getMonth(), fecha.getDate(),
        Math.floor(minuto / 60), minuto % 60, 0, 0,
      ) + desfase * 60_000)
      if (momento.getTime() < desde) continue
      franjas.push(momento.toISOString())
    }
  }
  return franjas
}

/**
 * ¿Se puede programar un pedido para este momento?
 *
 * Lo comprueba el SERVIDOR, no la app: la lista de franjas es una comodidad
 * para elegir, y quien manda una hora a mano no puede colarse.
 */
export function isValidSlot(
  schedule: ScheduleRecord[] | null | undefined,
  when: Date,
  options: SlotOptions = {},
  now = new Date(),
): boolean {
  if (Number.isNaN(when.getTime())) return false
  const preparacion = Math.max(0, options.preparationMinutes ?? 30)
  // Un minuto de margen: entre que la app pinta la franja y el cliente
  // confirma pasa tiempo, y rechazar por segundos sería absurdo.
  if (when.getTime() < now.getTime() + (preparacion - 1) * 60_000) return false

  const dias = Math.min(14, Math.max(1, options.daysAhead ?? 7))
  if (when.getTime() > now.getTime() + dias * 24 * 60 * 60_000) return false

  const active = activeDays(schedule)
  if (!active.length) return false

  const local = localEcuador(when)
  const config = active.find(item => item.day_of_week === local.getDay())
  if (!config) return false

  const minutos = local.getHours() * 60 + local.getMinutes()
  if (dentroDelTramo(config, minutos)) return true

  // Y el turno de la víspera, si se alargaba pasada la medianoche.
  const vispera = active.find(item => item.day_of_week === (local.getDay() + 6) % 7)
  return Boolean(vispera)
    && minutosDe(vispera!.close_time) < minutosDe(vispera!.open_time)
    && minutos < minutosDe(vispera!.close_time)
}

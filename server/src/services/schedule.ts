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

/**
 * El turno que está corriendo AHORA MISMO, o `null` si no hay ninguno.
 *
 * ⚠️ UNA SOLA función decide esto, y esa es la corrección de fondo
 * (2026-09-02). `isOutsideHours` miraba HOY primero y `todaysHours` miraba la
 * VÍSPERA primero, así que las dos podían responder sobre turnos distintos: la
 * portada decía «Abierto» con el horario de otro día al lado. Lo vivió el
 * dueño con Monster Pizza —martes 09:00–01:00, miércoles 00:00–03:00— a las
 * 00:08 de un miércoles: estado «Abierto», horario «09:00 – 01:00».
 *
 * ⚠️ La regla no es «hoy primero» ni «ayer primero», y por eso no basta con
 * invertir el orden: es **por qué** un tramo está vigente.
 *
 *   · Si el de HOY ya arrancó (`minutos >= abre`), es el de hoy. El miércoles
 *     de 00:00 a 03:00 arranca a las 00:00, así que a las 00:08 manda él.
 *   · Si el de hoy solo parece vivo por la COLA de un cruce —«09:00 a 01:00»
 *     mirado a las 00:30, cuando aún no han dado las 09:00— esa cola no es
 *     suya: pertenece al turno de ayer. Manda la víspera.
 *
 * Sin esa distinción, un negocio con el jueves 09:00–01:00 y el miércoles
 * CERRADO aparecía abierto a las 00:30 del jueves —`dentroDelTramo` solo mira
 * minutos, no días— y aceptaba pedidos nueve horas antes de abrir.
 */
const turnoVigente = (
  active: ScheduleRecord[],
  minutos: number,
  diaDeHoy: number,
): ScheduleRecord | null => {
  const hoy = active.find(day => day.day_of_week === diaDeHoy)
  // El de hoy, solo si ya llegó su hora de apertura.
  if (hoy && minutos >= minutosDe(hoy.open_time) && dentroDelTramo(hoy, minutos)) {
    return hoy
  }
  // Si no, la cola del de ayer, y solo si de verdad cruzaba la medianoche.
  const vispera = active.find(day => day.day_of_week === (diaDeHoy + 6) % 7)
  if (vispera
    && minutosDe(vispera.close_time) < minutosDe(vispera.open_time)
    && minutos < minutosDe(vispera.close_time)) {
    return vispera
  }
  return null
}

/** Los minutos del día en hora de Ecuador, que es la que manda aquí. */
const minutosLocales = (now: Date): { minutos: number; dia: number } => {
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
  return { minutos: local.getHours() * 60 + local.getMinutes(), dia: local.getDay() }
}

// Evalúa la hora local de Ecuador. Sin horario activo no bloquea la atención.
function isOutsideHours(
  schedule: ScheduleRecord[] | null | undefined,
  now = new Date(),
): boolean {
  const active = activeDays(schedule)
  if (!active.length) return false
  const { minutos, dia } = minutosLocales(now)
  return turnoVigente(active, minutos, dia) === null
}

/**
 * El horario VIGENTE, para enseñarlo en la portada de la tienda: «10:00 – 23:00».
 *
 * No es lo mismo que «el tramo de hoy». A las 00:30 de un jueves, con el
 * miércoles configurado de 09:00 a 01:00, quien sigue abierto es el turno del
 * miércoles: enseñar el del jueves diría «abre a las 09:00» junto a una píldora
 * verde de «Abierto», y las dos cosas no pueden ser ciertas a la vez.
 *
 * ⚠️ Pero cuando el de HOY ya arrancó, manda el de hoy aunque el de ayer siga
 * vivo. Es el caso que reportó el dueño: a las 00:08 de un miércoles que abre
 * de 00:00 a 03:00, con el martes vivo hasta la 01:00, se enseñaba el del
 * martes — y el cliente leía que cerraba a la 01:00 cuando quedaban dos horas.
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
  const { minutos, dia } = minutosLocales(now)

  const enCurso = turnoVigente(active, minutos, dia)
  // Sin turno en curso se enseña el de hoy, que es lo que permite decir a qué
  // hora abre. Si hoy no se abre, no hay nada honesto que enseñar.
  const mostrar = enCurso ?? active.find(day => day.day_of_week === dia)
  return mostrar
    ? { open: mostrar.open_time.slice(0, 5), close: mostrar.close_time.slice(0, 5) }
    : null
}

export { scheduleToText, buildScheduleMessage, isOutsideHours, todaysHours }

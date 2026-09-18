export interface ScheduleRecord {
  day_of_week: number
  open_time: string
  close_time: string
  /**
   * Ese día se atiende ENTERO. Manda sobre `open_time`/`close_time`, que se
   * conservan en la fila para poder volver al horario anterior sin escribirlo
   * de nuevo.
   *
   * ⚠️ No sustituye a `is_active`, que sigue siendo quien dice «este día no se
   * abre»: un día inactivo está cerrado aunque lleve la marca, porque
   * `activeDays` lo filtra antes de mirar nada más.
   */
  is_24h?: boolean | null
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
    // «24 horas» se dice con palabras. «de 00:00 a 23:59» obliga a deducir que
    // eso es el día entero, que es justo el truco que se retiró.
    day.is_24h
      ? `${DAY_NAMES[day.day_of_week]} las 24 horas`
      : `${DAY_NAMES[day.day_of_week]} de ${day.open_time.slice(0, 5)} a ${day.close_time.slice(0, 5)}`
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
    if (!config) return `🚫 *${DAY_NAMES[dayOfWeek]}:* cerrado`
    // Un negocio de 24 h no llega nunca a este mensaje, pero uno que abre toda
    // la noche el VIERNES sí lo manda un martes — y esa línea tiene que decir
    // «24 horas», no un rango que el cliente tenga que interpretar.
    if (config.is_24h) return `🕐 *${DAY_NAMES[dayOfWeek]}:* 24 horas`
    return `🕐 *${DAY_NAMES[dayOfWeek]}:* ${formatTime(config.open_time)} – ${formatTime(config.close_time)}`
  })
  return `¡Gracias por escribirnos! 🙏 En este momento estamos *fuera de nuestro horario de atención* 🌙\n\n📅 *Nuestros horarios de atención:*\n${lines.join('\n')}\n\nDéjenos su mensaje y con gusto le responderemos apenas abramos 😊✨`
}

const MINUTOS_DEL_DIA = 24 * 60

/** Los minutos desde medianoche de un «HH:MM» del panel. */
const minutosDe = (hora: string): number => {
  const [h, m] = String(hora).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * El cierre, con «23:59» entendido como el FINAL DEL DÍA.
 *
 * ⚠️ Nace de cómo configura el dueño de verdad (2026-09-02). Su modelo es
 * partir la noche en dos filas —«lunes 08:00–23:59» y «martes 00:00–03:00»—
 * en vez de cruzar la medianoche, y es más claro: no hay que preguntarse a
 * qué día pertenece una madrugada.
 *
 * Pero el tramo se evalúa con el cierre EXCLUIDO (`minutos < cierra`), así que
 * «hasta las 23:59» dejaba la tienda cerrada durante **un minuto entero**
 * justo antes de medianoche — a las 23:59:30 el cliente veía «Cerrado» y se
 * iba, en hora punta.
 *
 * Nadie escribe 23:59 queriendo cerrar sesenta segundos antes de las doce: lo
 * escribe queriendo decir «hasta el final». Se trata como 24:00, que es lo que
 * significa, y con eso las dos filas del dueño encajan sin hueco.
 */
const cierreEfectivo = (hora: string): number => {
  const minutos = minutosDe(hora)
  return minutos === MINUTOS_DEL_DIA - 1 ? MINUTOS_DEL_DIA : minutos
}

/**
 * La apertura y el cierre de un tramo, en minutos del día.
 *
 * ⚠️ Aquí —y SOLO aquí— el «Abierto 24 horas» del panel se convierte en
 * horario. Las cuatro cosas que se deciden sobre un horario (si está abierto,
 * qué turno manda, qué rango se enseña y cuándo vuelve a abrir) pasan por
 * estas dos funciones, así que la marca llega a las cuatro a la vez. Parchear
 * cada una por su cuenta es exactamente cómo se acaba con una que dice
 * «Abierto» y otra que anuncia una apertura — el fallo del 2026-09-02.
 *
 * Con la marca puesta el tramo es el día entero, de 00:00 a 24:00.
 *
 * ⚠️ Antes de esto, «24 horas» se escribía `00:00 – 23:59` y funcionaba por el
 * caso especial de `cierreEfectivo`. Era un truco que nadie deducía, y su
 * lectura natural —`00:00 – 00:00`— es un tramo de duración CERO que dejaba el
 * local cerrado el día entero en silencio.
 */
const aperturaDe = (config: ScheduleRecord): number => (
  config.is_24h ? 0 : minutosDe(config.open_time)
)

const cierreDe = (config: ScheduleRecord): number => (
  config.is_24h ? MINUTOS_DEL_DIA : cierreEfectivo(config.close_time)
)

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
  const abre = aperturaDe(config)
  const cierra = cierreDe(config)
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
  const vivos: { config: ScheduleRecord; faltan: number }[] = []

  // El de hoy, solo si ya llegó su hora de apertura.
  const hoy = active.find(day => day.day_of_week === diaDeHoy)
  if (hoy && minutos >= aperturaDe(hoy) && dentroDelTramo(hoy, minutos)) {
    const abre = aperturaDe(hoy)
    const cierra = cierreDe(hoy)
    // Si cruza, cierra MAÑANA: lo que falta pasa por la medianoche.
    vivos.push({
      config: hoy,
      faltan: cierra < abre ? (MINUTOS_DEL_DIA - minutos) + cierra : cierra - minutos,
    })
  }

  // Y la cola del de ayer, si de verdad cruzaba la medianoche.
  const vispera = active.find(day => day.day_of_week === (diaDeHoy + 6) % 7)
  // ⚠️ Un día de 24 h NO deja cola: su cierre (24:00) no es anterior a su
  // apertura (00:00), así que no cruza. Es lo correcto —el lunes entero no se
  // mete en el martes, que tiene su propia fila— y sale solo de normalizar.
  if (vispera
    && cierreDe(vispera) < aperturaDe(vispera)
    && minutos < cierreDe(vispera)) {
    vivos.push({ config: vispera, faltan: cierreDe(vispera) - minutos })
  }

  if (!vivos.length) return null

  // ⚠️ CON DOS TURNOS VIVOS MANDA EL QUE CIERRA MÁS TARDE (2026-09-02).
  //
  // Es el turno que de verdad decide hasta cuándo se puede pedir, y por eso es
  // el único honesto que enseñar. El dueño puede solapar turnos —«el lunes de
  // 9 de la mañana a 2 de la madrugada» y «el miércoles de 00:00 a 5»— y esa
  // es su decisión: el horario es suyo y aquí solo se respeta.
  //
  // Sin esta regla se enseñaba el más corto de los dos. Con el lunes de
  // 09:00 a 06:00 y el martes de 00:00 a 02:00, a las 00:30 del martes decía
  // «Abierto · cierra a las 02:00» y el local seguía abierto hasta las 06:00:
  // el cliente creía que le quedaba media hora teniendo cuatro y media.
  //
  // Es el MISMO fallo que el del 2026-09-02 —enseñar un turno que no es el que
  // manda— visto desde el otro lado, y por eso se arregla en el mismo sitio.
  return vivos.sort((a, b) => b.faltan - a.faltan)[0].config
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
): { open: string; close: string; allDay?: boolean } | null {
  const active = activeDays(schedule)
  if (!active.length) return null
  const { minutos, dia } = minutosLocales(now)

  const enCurso = turnoVigente(active, minutos, dia)
  // Sin turno en curso se enseña el de hoy, que es lo que permite decir a qué
  // hora abre. Si hoy no se abre, no hay nada honesto que enseñar.
  const mostrar = enCurso ?? active.find(day => day.day_of_week === dia)
  if (!mostrar) return null
  // ⚠️ Con 24 horas la portada lo dice con palabras, y por eso se le manda la
  // marca en vez de dejarle deducirla del par de horas: «12:00 AM – 11:59 PM»
  // es el truco viejo escrito en la cara del cliente.
  //
  // El par se manda IGUAL, y con el 23:59 de siempre, por una sola razón: una
  // app ya abierta en el teléfono de alguien no conoce `allDay` y seguiría
  // pintando el rango. Con esto enseña lo mismo que enseñaba ayer en vez de un
  // hueco; la app nueva ni lo mira.
  if (mostrar.is_24h) return { open: '00:00', close: '23:59', allDay: true }
  return { open: mostrar.open_time.slice(0, 5), close: mostrar.close_time.slice(0, 5) }
}


/**
 * Cuándo vuelve a abrir, para el cliente que llega con la tienda cerrada.
 *
 * ⚠️ Nace de un fallo que el dueño vio en su teléfono (2026-09-02): a la 01:10
 * de un miércoles con el miércoles configurado de 08:00 a 02:00, la portada
 * decía «Cerrado · 8:00 AM – 2:00 AM». El estado era CORRECTO —esa madrugada
 * pertenece al martes, que cerraba a las 22:00— pero cualquiera lee «cierra a
 * las 2 AM», mira el reloj y piensa que debería poder pedir. Le pasó a él, que
 * conoce el sistema.
 *
 * El rango del día solo informa cuando está ABIERTO. Cerrado, lo único que
 * importa es a qué hora se puede volver.
 *
 * ⚠️ Devuelve `null` si ya está abierto: no hay ninguna apertura que anunciar,
 * y el llamador enseña el rango vigente.
 *
 * `inDays` es 0 hoy, 1 mañana y hasta 6 para el resto — así el texto puede
 * decir «hoy», «mañana» o «el jueves» sin que la app recalcule el día.
 */
function proximaApertura(
  schedule: ScheduleRecord[] | null | undefined,
  now = new Date(),
): { open: string; inDays: number; dayName: string } | null {
  const active = activeDays(schedule)
  if (!active.length) return null
  const { minutos, dia } = minutosLocales(now)

  // Abierto ahora: no hay nada que anunciar.
  if (turnoVigente(active, minutos, dia)) return null

  // Se recorre la semana desde hoy. Los días sin tramo se saltan, que es lo
  // que permite anunciar «el jueves» a un local que solo abre ese día.
  for (let salto = 0; salto < 7; salto += 1) {
    const cual = (dia + salto) % 7
    const tramo = active.find(day => day.day_of_week === cual)
    if (!tramo) continue
    // ⚠️ HOY solo cuenta si su apertura todavía no ha pasado. Si ya son las
    // 23:00 y el tramo de hoy abría a las 08:00, ese tren se fue: lo que viene
    // es el de mañana. Sin esta comprobación se anunciaría una apertura en
    // pasado, que es peor que no decir nada.
    if (salto === 0 && minutos >= aperturaDe(tramo)) continue
    return {
      open: tramo.is_24h ? '00:00' : tramo.open_time.slice(0, 5),
      inDays: salto,
      dayName: DAY_NAMES[cual],
    }
  }
  return null
}


// ══════════════════════════════════════════════════════════════════════════
// MENÚS CON RELOJ: LA FRANJA DE UN PRODUCTO
// ══════════════════════════════════════════════════════════════════════════
//
// El local no cambia con la hora: cambia su CARTA. Un restaurante que sirve
// desayuno, almuerzo y cena es UN local con tres franjas — es como lo
// resuelven las apps grandes— y por eso la franja vive en el PRODUCTO.
//
// ⚠️ Esto pinta y cotiza. Quien COBRA es `producto_en_horario` dentro de
// `create_storefront_order`: los mismos casos, escritos dos veces a propósito,
// porque la pantalla tiene que decir lo que el servidor va a aceptar.

/** La franja de un producto, tal como llega de la base. */
export interface FranjaDeProducto {
  available_days?: number[] | null
  available_from?: string | null
  available_until?: string | null
}

/** «07:00» o «07:00:00» a minutos del día. Nulo si no hay hora. */
const minutosDeHora = (valor?: string | null): number | null => {
  const partes = String(valor || '').split(':')
  if (partes.length < 2) return null
  const horas = Number(partes[0])
  const minutos = Number(partes[1])
  if (!Number.isFinite(horas) || !Number.isFinite(minutos)) return null
  return horas * 60 + minutos
}

/**
 * ¿Este producto se puede pedir en este momento?
 *
 * Sin franja, siempre — que es como han vivido todos los productos hasta el
 * 2026-09-17 y no puede costarles nada.
 */
export function enHorarioDeProducto(
  franja: FranjaDeProducto,
  now = new Date(),
): boolean {
  const desde = minutosDeHora(franja.available_from)
  const hasta = minutosDeHora(franja.available_until)
  const dias = Array.isArray(franja.available_days) && franja.available_days.length
    ? franja.available_days
    : null
  if (desde === null && hasta === null && !dias) return true

  const { minutos, dia } = minutosLocales(now)
  // ⚠️ La franja que CRUZA MEDIANOCHE pertenece al día que EMPEZÓ: a la 01:00
  // del martes sigue mandando la carta del lunes por la noche. Sin esto, un
  // local que cierra a las 02:00 pierde sus dos últimas horas cada noche.
  const cruza = desde !== null && hasta !== null && desde > hasta
  const enLaHora = desde === null || hasta === null
    ? true
    : cruza
      ? minutos >= desde || minutos <= hasta
      : minutos >= desde && minutos <= hasta
  if (!enLaHora) return false

  if (!dias) return true
  const diaQueManda = cruza && hasta !== null && minutos <= hasta ? (dia + 6) % 7 : dia
  return dias.includes(diaQueManda)
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

/** «07:00:00» → «07:00». La base guarda segundos que nadie necesita leer. */
const horaCorta = (valor?: string | null): string => String(valor || '').slice(0, 5)

/**
 * Cuándo se pide, en una línea para el cliente. Nulo si no tiene franja.
 *
 * ⚠️ Se dice SIEMPRE, también dentro de la franja: «se pide de 07:00 a 11:00»
 * le sirve igual a quien lo está pidiendo a las 10:55.
 */
export function textoDeFranja(franja: FranjaDeProducto): string | null {
  const desde = horaCorta(franja.available_from)
  const hasta = horaCorta(franja.available_until)
  // ⚠️ La semana empieza en LUNES al leerla: con el orden de la base —domingo
  // primero— un fin de semana se leía «domingo y sábado».
  const desdeElLunes = (dia: number) => (dia + 6) % 7
  const dias = Array.isArray(franja.available_days) && franja.available_days.length
    ? [...franja.available_days].sort((a, b) => desdeElLunes(a) - desdeElLunes(b))
    : null
  if (!desde && !hasta && !dias) return null

  const horas = desde && hasta ? `de ${desde} a ${hasta}` : ''
  if (!dias) return horas ? `Se pide ${horas}` : null

  // Un tramo corrido se lee «de lunes a viernes»; lo salteado, enumerado. Con
  // DOS días el tramo no ahorra nada y suena peor: «sábado y domingo».
  const seguidos = dias.length > 2
    && dias.every((dia, i) => i === 0 || desdeElLunes(dia) === desdeElLunes(dias[i - 1]!) + 1)
  const cuando = dias.length === 7
    ? ''
    : dias.length === 1
      ? DIAS[dias[0]!]
      : seguidos
        ? `de ${DIAS[dias[0]!]} a ${DIAS[dias[dias.length - 1]!]}`
        : `${dias.slice(0, -1).map(dia => DIAS[dia]).join(', ')} y ${DIAS[dias[dias.length - 1]!]}`

  if (!cuando) return horas ? `Se pide ${horas}` : null
  return horas ? `Se pide ${cuando}, ${horas}` : `Se pide ${cuando}`
}

export {
  scheduleToText, buildScheduleMessage, isOutsideHours, todaysHours, proximaApertura,
}

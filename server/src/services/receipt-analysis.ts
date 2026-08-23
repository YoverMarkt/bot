// ── COMPARAR EL COMPROBANTE CON EL PEDIDO, Y PUNTUARLO ──────────────────────
//
// Lo que leyó la visión (`receipt-vision.ts`) contra lo que el pedido dice que
// hay que cobrar y contra la cuenta que el negocio publica. De ahí salen las
// señales, y de las señales el riesgo.
//
// ⚠️ Función **pura**: no toca red, ni base, ni reloj propio. Recibe lo leído,
// lo esperado y las reglas, y devuelve señales. Así se puede probar cada caso
// —el monto justo, el de menos, la cuenta ajena, el comprobante de la semana
// pasada— sin levantar nada.
//
// ⚠️ EL SCORE NO SE SUMA AQUÍ. Lo suma `save_receipt_analysis` en PostgreSQL
// sobre TODAS las señales del comprobante, y no es un capricho: la señal de
// duplicado la escribió `register_payment_receipt` ANTES de que el análisis
// existiera —para que un duplicado quede marcado aunque el análisis esté
// apagado— y un total calculado aquí la perdería. Un comprobante reutilizado
// del mismo importe saldría «bajo» justo porque el monto cuadra.
//
// ⚠️ Y NINGUNA señal confirma un pago. Ni todas juntas en verde. Que un
// comprobante se lea perfecto solo dice que la imagen es coherente, no que el
// dinero esté en la cuenta: el dueño mira su banco y decide.

/** Una señal, tal como se guarda en `payment_receipt_risk_flags`. */
export interface SenalDeRiesgo {
  flag_type: string
  severity: 'baja' | 'media' | 'alta' | 'critica'
  description: string
  points: number
}

/** Lo que el pedido y el negocio dicen que DEBERÍA decir el comprobante. */
export interface LoEsperado {
  total: number
  currency?: string | null
  /** Cuándo se hizo el pedido, para detectar comprobantes viejos reciclados. */
  createdAt?: string | null
  cuenta?: {
    bank_name?: string | null
    account_number?: string | null
    holder_name?: string | null
  } | null
}

export interface LoDetectado {
  amount?: string | null
  currency?: string | null
  destination_account?: string | null
  beneficiary_name?: string | null
  bank_name?: string | null
  transaction_date?: string | null
  reference_number?: string | null
}

/**
 * Los puntos de cada señal.
 *
 * ⚠️ Viven en `server_settings` (`receipt_risk_rules`) y no en el código, para
 * poder moverlos sin desplegar: los números buenos se sabrán viendo
 * comprobantes reales, no antes. Esto son solo los valores de arranque.
 *
 * Los negativos son señales que TRANQUILIZAN. Existen porque un score que solo
 * sube acabaría marcando en rojo hasta los pagos impecables, y un panel donde
 * todo está en rojo es un panel que el dueño deja de mirar.
 */
export interface ReglasDeRiesgo {
  monto_coincide: number
  cuenta_coincide: number
  beneficiario_coincide: number
  monto_mayor: number
  monto_menor: number
  cuenta_incorrecta: number
  moneda_distinta: number
  fecha_antigua: number
  fecha_futura: number
  sin_fecha: number
  sin_referencia: number
  sin_banco: number
  referencia_duplicada: number
  patron_debil: number
  ilegible: number
  /** Días de margen antes de considerar viejo un comprobante. */
  dias_de_gracia: number
}

export const REGLAS_POR_DEFECTO: ReglasDeRiesgo = {
  // ── Lo que tranquiliza ──
  monto_coincide: -10,
  cuenta_coincide: -10,
  beneficiario_coincide: -5,
  // ── Lo que preocupa ──
  //
  // ⚠️ Pagar de MENOS pesa mucho más que pagar de más: es el error que le
  // cuesta dinero al negocio, y el más común cuando alguien reenvía el
  // comprobante de otro pedido más barato. De más suele ser una propina, un
  // redondeo o dos pedidos juntos.
  monto_menor: 60,
  monto_mayor: 20,
  // La señal más grave que puede dar la lectura: el dinero se fue a otra
  // cuenta. Si es de verdad, ese pago no va a llegar nunca.
  cuenta_incorrecta: 80,
  moneda_distinta: 30,
  // Un comprobante de hace una semana para un pedido de hoy suele ser una
  // captura vieja reutilizada.
  fecha_antigua: 25,
  // Y una fecha futura no existe: o está mal leída o está retocada.
  fecha_futura: 40,
  sin_fecha: 10,
  sin_referencia: 15,
  sin_banco: 20,
  referencia_duplicada: 60,
  // El modelo dijo que no era un comprobante, pero se vio alguna señal suelta.
  // No se rechaza —eso solo pasa con el vacío absoluto— pero se marca fuerte.
  patron_debil: 45,
  // No se pudo leer: ni acusa ni absuelve, solo pide ojos humanos.
  ilegible: 30,
  dias_de_gracia: 2,
}

/**
 * Mezcla las reglas guardadas con las de por defecto.
 *
 * ⚠️ Nunca lanza y nunca deja el motor sin reglas: un JSON roto en Ajustes no
 * puede dejar los comprobantes sin puntuar. Lo que no sea un número entero en
 * rango se ignora y manda el valor de siempre — la base acota igualmente a
 * ±100, así que un valor absurdo no puede desbordar el score.
 */
export const leerReglas = (crudo: string | null | undefined): ReglasDeRiesgo => {
  const reglas: ReglasDeRiesgo = { ...REGLAS_POR_DEFECTO }
  if (!crudo) return reglas
  let guardadas: unknown
  try {
    guardadas = JSON.parse(crudo)
  } catch {
    return reglas
  }
  if (!guardadas || typeof guardadas !== 'object' || Array.isArray(guardadas)) return reglas

  for (const [clave, valor] of Object.entries(guardadas as Record<string, unknown>)) {
    if (!(clave in reglas)) continue
    if (typeof valor !== 'number' || !Number.isInteger(valor)) continue
    if (clave === 'dias_de_gracia') {
      if (valor < 0 || valor > 365) continue
    } else if (valor < -100 || valor > 100) {
      continue
    }
    reglas[clave as keyof ReglasDeRiesgo] = valor
  }
  return reglas
}

/** Deja un texto comparable: sin tildes, sin dobles espacios, en minúsculas. */
export const normalizarTexto = (valor: unknown): string =>
  String(valor ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * ¿Son la misma cuenta?
 *
 * ⚠️ Los comprobantes ENMASCARAN la cuenta: «****3456», «22•••••56». Comparar
 * las cadenas enteras daría siempre que no coinciden, y entonces la señal más
 * grave del motor —«el dinero se fue a otra cuenta»— saltaría en todos los
 * pagos buenos. Se comparan los últimos cuatro dígitos, que es lo que los
 * bancos dejan ver.
 */
export const mismaCuenta = (
  detectada: string | null | undefined,
  esperada: string | null | undefined,
): boolean | null => {
  const a = String(detectada ?? '').replace(/\D/g, '')
  const b = String(esperada ?? '').replace(/\D/g, '')
  // Sin una de las dos no se puede decir nada. `null` es «no se sabe», que no
  // es lo mismo que «no coinciden»: no se acusa a nadie por falta de datos.
  if (!a || !b) return null
  if (a.length < 4 || b.length < 4) return null
  if (a === b) return true
  return a.slice(-4) === b.slice(-4)
}

/**
 * ¿Es el mismo beneficiario?
 *
 * El nombre del titular llega abreviado, con el orden cambiado o con el nombre
 * comercial en vez del legal («Monster Pizza» contra «Juan Pérez Loor»). Se
 * exige que compartan al menos dos palabras de tres letras o más — una sola
 * («de», «Juan») daría coincidencias por casualidad.
 */
export const mismoBeneficiario = (
  detectado: string | null | undefined,
  esperado: string | null | undefined,
): boolean | null => {
  const a = normalizarTexto(detectado)
  const b = normalizarTexto(esperado)
  if (!a || !b) return null
  if (a === b) return true
  const palabras = (texto: string) => new Set(
    texto.split(' ').filter(palabra => palabra.length >= 3),
  )
  const ay = palabras(a)
  const be = palabras(b)
  if (!ay.size || !be.size) return null
  let comunes = 0
  for (const palabra of ay) if (be.has(palabra)) comunes += 1
  // Con un solo nombre propio en juego, una coincidencia basta.
  if (Math.min(ay.size, be.size) === 1) return comunes >= 1
  return comunes >= 2
}

/** Días enteros entre dos fechas ISO. Negativo si la primera es anterior. */
const diasEntre = (desde: string, hasta: string): number | null => {
  const a = Date.parse(`${desde}T00:00:00Z`)
  const b = Date.parse(`${hasta}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86_400_000)
}

const soloFecha = (valor: string | null | undefined): string | null => {
  const iso = String(valor ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null
}

/**
 * Las señales que salen de comparar el comprobante con el pedido.
 *
 * No decide nada: solo describe lo que cuadra y lo que no. Quien decide es el
 * dueño, con esto delante.
 */
export const compararConElPedido = (
  detectado: LoDetectado,
  esperado: LoEsperado,
  reglas: ReglasDeRiesgo = REGLAS_POR_DEFECTO,
): SenalDeRiesgo[] => {
  const senales: SenalDeRiesgo[] = []
  const anotar = (
    tipo: string,
    severidad: SenalDeRiesgo['severity'],
    descripcion: string,
    puntos: number,
  ) => {
    // Una regla puesta a cero es una regla APAGADA: el dueño puede desactivar
    // una señal desde Ajustes sin que aparezca como ruido en el panel.
    if (puntos === 0) return
    senales.push({ flag_type: tipo, severity: severidad, description: descripcion, points: puntos })
  }
  const dinero = (valor: number) => valor.toFixed(2)

  // ── El monto ──
  const montoDetectado = detectado.amount === null || detectado.amount === undefined
    ? null
    : Number.parseFloat(String(detectado.amount))
  const totalEsperado = Number(esperado.total)
  if (montoDetectado !== null && Number.isFinite(montoDetectado) && Number.isFinite(totalEsperado)) {
    // Un centavo de margen: los bancos redondean al mostrar y no conviene
    // acusar a nadie por un decimal de representación.
    const diferencia = Number((montoDetectado - totalEsperado).toFixed(2))
    if (Math.abs(diferencia) <= 0.01) {
      anotar(
        'monto_coincide', 'baja',
        `El comprobante dice $${dinero(montoDetectado)}, igual que el pedido`,
        reglas.monto_coincide,
      )
    } else if (diferencia < 0) {
      anotar(
        'monto_menor', 'critica',
        `El comprobante dice $${dinero(montoDetectado)} y el pedido son `
        + `$${dinero(totalEsperado)}: faltan $${dinero(Math.abs(diferencia))}`,
        reglas.monto_menor,
      )
    } else {
      anotar(
        'monto_mayor', 'media',
        `El comprobante dice $${dinero(montoDetectado)} y el pedido son `
        + `$${dinero(totalEsperado)}: $${dinero(diferencia)} de más`,
        reglas.monto_mayor,
      )
    }
  }

  // ── La moneda ──
  const monedaDetectada = normalizarTexto(detectado.currency)
  const monedaEsperada = normalizarTexto(esperado.currency || 'usd')
  if (monedaDetectada && monedaEsperada && monedaDetectada !== monedaEsperada) {
    anotar(
      'moneda_distinta', 'alta',
      `El comprobante está en ${String(detectado.currency).toUpperCase()} y el pedido en `
      + `${String(esperado.currency || 'USD').toUpperCase()}`,
      reglas.moneda_distinta,
    )
  }

  // ── La cuenta de destino ──
  const cuenta = mismaCuenta(detectado.destination_account, esperado.cuenta?.account_number)
  if (cuenta === true) {
    anotar('cuenta_coincide', 'baja', 'La cuenta de destino es la del negocio', reglas.cuenta_coincide)
  } else if (cuenta === false) {
    anotar(
      'cuenta_incorrecta', 'critica',
      'La cuenta de destino NO es la del negocio: ese dinero fue a otra parte',
      reglas.cuenta_incorrecta,
    )
  }

  // ── El beneficiario ──
  const titular = mismoBeneficiario(detectado.beneficiary_name, esperado.cuenta?.holder_name)
  if (titular === true) {
    anotar(
      'beneficiario_coincide', 'baja',
      'El beneficiario coincide con el titular de la cuenta',
      reglas.beneficiario_coincide,
    )
  }
  // ⚠️ Que NO coincida no se marca como señal propia: el titular legal y el
  // nombre comercial casi nunca se escriben igual, y marcarlo llenaría de rojo
  // los pagos buenos. La cuenta es el dato que de verdad identifica el destino.

  // ── La fecha ──
  const fecha = soloFecha(detectado.transaction_date)
  const fechaPedido = soloFecha(esperado.createdAt)
  if (!fecha) {
    anotar('sin_fecha', 'media', 'El comprobante no muestra la fecha de la operación', reglas.sin_fecha)
  } else if (fechaPedido) {
    const dias = diasEntre(fecha, fechaPedido)
    if (dias !== null && dias > reglas.dias_de_gracia) {
      anotar(
        'fecha_antigua', 'alta',
        `El comprobante es de hace ${dias} días (${fecha}) y el pedido es de ${fechaPedido}`,
        reglas.fecha_antigua,
      )
    } else if (dias !== null && dias < -1) {
      // Un día de margen por husos horarios; más allá es imposible.
      anotar(
        'fecha_futura', 'alta',
        `El comprobante está fechado el ${fecha}, después del pedido (${fechaPedido})`,
        reglas.fecha_futura,
      )
    }
  }

  // ── Lo que falta ──
  if (!String(detectado.reference_number ?? '').trim()) {
    anotar(
      'sin_referencia', 'media',
      'El comprobante no muestra un número de referencia',
      reglas.sin_referencia,
    )
  }
  if (!String(detectado.bank_name ?? '').trim()) {
    anotar('sin_banco', 'alta', 'No se reconoce el banco que emite el comprobante', reglas.sin_banco)
  }

  return senales
}

/** La banda del score. La misma que deriva PostgreSQL: aquí solo se pinta. */
export const nivelDeRiesgo = (score: number): 'bajo' | 'medio' | 'alto' | 'critico' =>
  score <= 20 ? 'bajo' : score <= 50 ? 'medio' : score <= 75 ? 'alto' : 'critico'

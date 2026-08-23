// ── LEER EL COMPROBANTE ─────────────────────────────────────────────────────
//
// Una sola llamada a un modelo de visión que mira la foto y responde JSON: qué
// banco, cuánto, cuándo, a quién, con qué referencia — y, sobre todo, **si eso
// es siquiera un comprobante**.
//
// ⚠️ EL OBJETIVO PRINCIPAL NO ES EXTRAER DATOS, ES LA PORTERÍA. Lo que pidió
// el dueño: que la foto de un perro, un árbol o una captura de otra cosa no se
// trate como un pago. Los campos son el extra; lo que de verdad cambia el
// comportamiento es `esComprobante`.
//
// ⚠️ Y NADA DE ESTO CONFIRMA UN PAGO. Un comprobante que se lee perfecto sigue
// siendo una imagen: pudo editarse, generarse con una plantilla o reutilizarse
// de otro pedido. Esto solo le da señales al dueño antes de que él decida.
//
// ── Las cuatro reglas que lo hacen seguro ─────────────────────────────────
//
// 1. **Nunca lanza.** Corre dentro del camino de un mensaje entrante. Si
//    OpenAI está caído, sin saldo o devuelve basura, se responde `ok: false` y
//    quien llama sigue como si esto no existiera: falla ABIERTO.
// 2. **Con timeout.** Un modelo colgado no puede dejar a un cliente esperando
//    su respuesta ni retener el lease del worker de webhooks.
// 3. **Todo se sanea contra los CHECK de la tabla.** Un modelo puede devolver
//    un nombre de banco de 300 caracteres o «ayer» por fecha. Lo que no encaje
//    se recorta o se deja nulo; nunca se propaga hacia la base.
// 4. **Se apaga sin desplegar** (`receipt_analysis_enabled`). Nace apagado.

import OpenAI from 'openai'

/** Lo que se busca en la imagen para decidir si es un comprobante. */
export interface SenalesDeComprobante {
  banco: boolean
  monto: boolean
  fecha: boolean
  referencia: boolean
}

/** Los campos leídos, ya saneados y listos para la base. */
export interface DatosDelComprobante {
  bank_name?: string | null
  sender_name?: string | null
  beneficiary_name?: string | null
  destination_account?: string | null
  amount?: string | null
  currency?: string | null
  transaction_date?: string | null
  transaction_time?: string | null
  reference_number?: string | null
  transaction_number?: string | null
  ocr_raw_text?: string | null
}

export type ResultadoVision =
  | {
    ok: true
    /**
     * ⚠️ `false` SOLO cuando no aparece ninguna de las cuatro señales. Ante
     * cualquier duda es `true`: ver `decidirSiEsComprobante`.
     */
    esComprobante: boolean
    senales: SenalesDeComprobante
    datos: DatosDelComprobante
    /** Lo que respondió el modelo, tal cual, para poder revisarlo después. */
    crudo: Record<string, unknown>
  }
  | { ok: false; motivo: string }

export interface VisionDependencias {
  settings: { get(key: 'openai_api_key' | 'receipt_analysis_enabled'): Promise<string | null> }
  /** Inyectable para poder probar sin red. */
  crearCliente?(apiKey: string): {
    chat: {
      completions: {
        create(cuerpo: unknown, opciones?: unknown): Promise<{
          choices: Array<{ message: { content: string | null } }>
        }>
      }
    }
  }
  logger?: { log(...args: unknown[]): void }
  timeoutMs?: number
}

/**
 * ¿Está encendido el análisis?
 *
 * Nace APAGADO: hace falta un valor afirmativo explícito. Un ajuste vacío, sin
 * escribir o ilegible significa apagado, nunca encendido — el error caro es
 * gastar y rechazar pagos que nadie autorizó, no dejar de analizar.
 */
export const analisisEncendido = (valor: string | null | undefined): boolean =>
  ['1', 'true', 'si', 'sí', 'on'].includes(String(valor ?? '').trim().toLowerCase())

const CAPS = {
  bank_name: 120,
  sender_name: 160,
  beneficiary_name: 160,
  destination_account: 60,
  currency: 8,
  reference_number: 80,
  transaction_number: 80,
  ocr_raw_text: 8000,
} as const

/** Recorta y limpia un texto del modelo, o lo deja nulo si no dice nada. */
const texto = (valor: unknown, tope: number): string | null => {
  if (typeof valor !== 'string') return null
  const limpio = valor.trim()
  if (!limpio) return null
  // Los modelos rellenan lo que no saben con estas palabras. Guardarlas sería
  // enseñarle al dueño «Banco: no visible» como si fuera un dato leído.
  if (/^(null|none|n\/a|na|no visible|no se ve|desconocido|no aplica|-{1,3})$/i.test(limpio)) {
    return null
  }
  return limpio.slice(0, tope)
}

/**
 * Normaliza una fecha a ISO.
 *
 * ⚠️ Ecuador escribe `dd/mm/aaaa`, así que «08/09/2026» es 8 de septiembre y no
 * 9 de agosto. Se le pide ISO al modelo, pero cuando devuelve el formato local
 * se interpreta como día primero: al revés, medio año de comprobantes tendría
 * el mes y el día cambiados sin que nada avisara.
 */
export const normalizarFecha = (valor: unknown): string | null => {
  const crudo = texto(valor, 40)
  if (!crudo) return null

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(crudo)
  const local = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(crudo)
  let anio: number, mes: number, dia: number
  if (iso) {
    [, anio, mes, dia] = [0, Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (local) {
    [, dia, mes, anio] = [0, Number(local[1]), Number(local[2]), Number(local[3])]
  } else {
    return null
  }

  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  // Un año fuera de lo posible es un dato mal leído, no un comprobante de 1900.
  if (anio < 2000 || anio > 2100) return null
  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  // Caza el 31 de febrero: el constructor lo desplaza a marzo en silencio.
  if (fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return null
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/** Normaliza una hora a `HH:MM`. Lo que no lo sea se queda nulo. */
export const normalizarHora = (valor: unknown): string | null => {
  const crudo = texto(valor, 20)
  if (!crudo) return null
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(crudo)
  if (!match) return null
  let horas = Number(match[1])
  const minutos = Number(match[2])
  const sufijo = (match[4] || '').toLowerCase()
  if (sufijo === 'pm' && horas < 12) horas += 12
  if (sufijo === 'am' && horas === 12) horas = 0
  if (horas > 23 || minutos > 59) return null
  return `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`
}

/**
 * Normaliza un monto.
 *
 * ⚠️ No se usa `Number(...)` a secas: `Number(null)` es **0**, no NaN, y un
 * monto nulo pasaría como cero — el mismo fallo que ya cazaron `accuracy_m` y
 * la latitud de las ubicaciones. Aquí un cero colado sería peor: parecería un
 * comprobante de $0 que no cuadra con el pedido y dispararía una alarma falsa.
 */
export const normalizarMonto = (valor: unknown): string | null => {
  if (valor === null || valor === undefined) return null
  const crudo = String(valor).trim()
  if (!crudo) return null
  // Se queda con dígitos, puntos y comas: «USD 1.234,56» y «$1,234.56» son la
  // misma cifra escrita a los dos lados del continente.
  const limpio = crudo.replace(/[^\d.,-]/g, '')
  if (!limpio || !/\d/.test(limpio)) return null

  let normalizado = limpio
  const coma = limpio.lastIndexOf(',')
  const punto = limpio.lastIndexOf('.')
  if (coma > -1 && punto > -1) {
    // El último separador es el decimal; el otro son los miles.
    normalizado = coma > punto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, '')
  } else if (coma > -1) {
    // Solo comas: decimal si deja dos dígitos detrás, miles si no.
    normalizado = /,\d{1,2}$/.test(limpio)
      ? limpio.replace(',', '.')
      : limpio.replace(/,/g, '')
  }

  const numero = Number.parseFloat(normalizado)
  if (!Number.isFinite(numero) || numero < 0 || numero > 999999) return null
  return numero.toFixed(2)
}

/**
 * ¿Es esto un comprobante?
 *
 * ⚠️ LA ASIMETRÍA ES EL NÚCLEO DE ESTA FUNCIÓN, y es deliberada: solo se
 * rechaza cuando **no aparece ninguna** de las cuatro señales. Los dos errores
 * no cuestan lo mismo:
 *
 *   · Un falso negativo le dice «manda el comprobante correcto» a alguien que
 *     acaba de pagar de verdad. Ese cliente se queda atascado, enfadado, y
 *     puede que sin pedir nunca más.
 *   · Un falso positivo deja al dueño viendo la foto de un perro en su panel,
 *     con el pedido en `pago_en_revision` — que es **exactamente lo que pasa
 *     hoy** sin ningún análisis.
 *
 * Por eso no basta con que el modelo diga «no es un comprobante»: si ve un
 * banco, o un monto, o una fecha, o una referencia, se trata como comprobante
 * y decide una persona. Solo el vacío absoluto se rechaza.
 */
export const decidirSiEsComprobante = (
  dijoElModelo: unknown,
  senales: SenalesDeComprobante,
): boolean => {
  const algunaSenal = senales.banco || senales.monto || senales.fecha || senales.referencia
  if (algunaSenal) return true
  // Sin ninguna señal, se cree al modelo. `!== false` y no `=== true`: si el
  // campo viene ausente o raro, se prefiere tratarlo como comprobante.
  return dijoElModelo !== false
}

const INSTRUCCIONES = [
  'Eres un lector de comprobantes de transferencia bancaria de Ecuador.',
  'Mira la imagen y responde SOLO con un objeto JSON, sin texto alrededor.',
  '',
  'Campos:',
  '{',
  '  "es_comprobante": true|false,',
  '  "senales": { "banco": true|false, "monto": true|false,',
  '               "fecha": true|false, "referencia": true|false },',
  '  "bank_name": string|null,            // banco que emite',
  '  "sender_name": string|null,          // quien ordena la transferencia',
  '  "beneficiary_name": string|null,     // a quien va dirigida',
  '  "destination_account": string|null,  // cuenta de destino',
  '  "amount": string|null,               // solo el número, ej "20.50"',
  '  "currency": string|null,             // ej "USD"',
  '  "transaction_date": string|null,     // formato AAAA-MM-DD',
  '  "transaction_time": string|null,     // formato HH:MM 24h',
  '  "reference_number": string|null,',
  '  "transaction_number": string|null,',
  '  "ocr_raw_text": string|null          // todo el texto legible de la imagen',
  '}',
  '',
  'REGLAS:',
  '- "senales" describe lo que VES en la imagen, no lo que supones.',
  '- "es_comprobante" es false SOLO si la imagen no tiene nada que ver con un',
  '  pago: una foto de una persona, un animal, un paisaje, un producto, un',
  '  meme. Si hay cualquier rastro de una operación bancaria, es true.',
  '- NUNCA inventes un dato que no se lea. Lo que no veas, null.',
  '- No expliques nada. Solo el JSON.',
].join('\n')

export const crearLectorDeComprobantes = (dependencias: VisionDependencias) =>
  /**
   * Lee la imagen. **Nunca lanza**: devuelve `ok: false` y quien llama sigue
   * como si el análisis no existiera.
   */
  async function analizarComprobante(
    imagen: Buffer,
    mimeType?: string | null,
  ): Promise<ResultadoVision> {
    try {
      if (!analisisEncendido(await dependencias.settings.get('receipt_analysis_enabled'))) {
        return { ok: false, motivo: 'apagado' }
      }
      const apiKey = await dependencias.settings.get('openai_api_key')
      if (!apiKey) return { ok: false, motivo: 'sin_credencial' }

      const tipo = String(mimeType || 'image/jpeg')
      const dataUrl = `data:${tipo};base64,${imagen.toString('base64')}`
      const crearCliente = dependencias.crearCliente
        || ((clave: string) => new OpenAI({ apiKey: clave }))
      const cliente = crearCliente(apiKey)

      const respuesta = await cliente.chat.completions.create(
        {
          model: 'gpt-4o-mini',
          max_tokens: 700,
          // Sin creatividad: se está leyendo un documento, no redactando.
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: INSTRUCCIONES },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          }],
        },
        // Un modelo colgado no puede dejar sin respuesta a quien acaba de
        // pagar, ni retener el lease del worker de webhooks.
        { timeout: dependencias.timeoutMs ?? 20_000 },
      )

      const contenido = respuesta.choices?.[0]?.message?.content
      if (!contenido) return { ok: false, motivo: 'respuesta_vacia' }

      let crudo: Record<string, unknown>
      try {
        crudo = JSON.parse(contenido) as Record<string, unknown>
      } catch {
        return { ok: false, motivo: 'json_invalido' }
      }
      if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) {
        return { ok: false, motivo: 'json_invalido' }
      }

      const senalesCrudas = (crudo.senales || {}) as Record<string, unknown>
      const senales: SenalesDeComprobante = {
        banco: senalesCrudas.banco === true,
        monto: senalesCrudas.monto === true,
        fecha: senalesCrudas.fecha === true,
        referencia: senalesCrudas.referencia === true,
      }

      return {
        ok: true,
        esComprobante: decidirSiEsComprobante(crudo.es_comprobante, senales),
        senales,
        crudo,
        datos: {
          bank_name: texto(crudo.bank_name, CAPS.bank_name),
          sender_name: texto(crudo.sender_name, CAPS.sender_name),
          beneficiary_name: texto(crudo.beneficiary_name, CAPS.beneficiary_name),
          destination_account: texto(crudo.destination_account, CAPS.destination_account),
          amount: normalizarMonto(crudo.amount),
          currency: texto(crudo.currency, CAPS.currency),
          transaction_date: normalizarFecha(crudo.transaction_date),
          transaction_time: normalizarHora(crudo.transaction_time),
          reference_number: texto(crudo.reference_number, CAPS.reference_number),
          transaction_number: texto(crudo.transaction_number, CAPS.transaction_number),
          ocr_raw_text: texto(crudo.ocr_raw_text, CAPS.ocr_raw_text),
        },
      }
    } catch (error) {
      dependencias.logger?.log(
        `⚠️  [comprobante] no se pudo leer la imagen: ${
          error instanceof Error ? error.message : 'desconocido'
        }`,
      )
      return { ok: false, motivo: 'fallo_del_modelo' }
    }
  }

const settings = require('./settings') as typeof import('./settings')

export const analizarComprobante = crearLectorDeComprobantes({
  settings: settings as VisionDependencias['settings'],
  logger: console,
})

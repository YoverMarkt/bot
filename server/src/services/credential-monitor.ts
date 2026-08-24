// Vigilancia proactiva de las credenciales del canal de entrada.
//
// El panel ya permite verificar credenciales A MANO (`/api/admin/clients/:id/verify`),
// pero eso solo sirve si alguien hace clic. En julio de 2026 el canal se cayó y
// nadie lo supo durante cinco días: la comprobación existía, simplemente nadie
// la ejecutó.
//
// Este módulo hace las mismas preguntas SOLO, cada pocas horas, y añade dos que
// la verificación manual no cubre y que son las que más avisan de un apagón
// inminente: ¿queda saldo? ¿el webhook sigue apuntando a donde debe?
//
// ⚠️ VIGILA DOS COSAS DISTINTAS, y hasta el 2026-08-23 solo veía una:
//
//   · El canal PROPIO de un negocio (`ycloud`, `meta`, `telegram`), con sus
//     credenciales en la ficha del negocio.
//   · El NÚMERO DE LA PLATAFORMA, con las suyas en `server_settings`.
//
// Faltaba el segundo, y eso dejó la vigilancia CIEGA en cuanto los locales
// pasaron al marketplace: `checkBusinessCredentials` ramifica por
// `whatsapp_provider`, y `'marketplace'` no caía en `ycloud`, ni en `telegram`,
// ni en «sin proveedor» —es un valor, no un vacío—, así que devolvía «todo en
// orden» sin hacer una sola llamada a YCloud. El servidor imprimía cada seis
// horas «🔐 Credenciales: todos los negocios en orden» mientras nadie miraba el
// único canal que da servicio a toda la plataforma.
//
// Lo que se perdió por eso no es teórico: el aviso `saldo_bajo` («0.5 USD»)
// venía sonando 209 veces y se apagó el mismo día que el local dejó de tener
// número propio. Con el saldo agotado el número no puede ENVIAR, y nada lo
// habría dicho.
//
// Todo es lectura contra los proveedores. No modifica nada, ni en la base ni en
// las cuentas externas.

export type IssueSeverity = 'error' | 'aviso'

export interface CredentialIssue {
  businessId: string | null
  businessName: string
  provider: string
  severity: IssueSeverity
  code: string
  message: string
}

export interface MonitorableBusiness {
  id: string
  name?: string | null
  active?: boolean | null
  suspended?: boolean | null
  whatsapp_provider?: string | null
  whatsapp_number?: string | null
  ycloud_number?: string | null
  ycloud_api_key?: string | null
  ycloud_webhook_endpoint_id?: string | null
  telegram_bot_token?: string | null
}

export interface YCloudPhoneNumber {
  phoneNumber?: string
  status?: string
  qualityRating?: string
}

export interface YCloudWebhookEndpoint {
  id?: string
  url?: string
  status?: string
  enabledEvents?: string[]
}

/** Cliente inyectable: en pruebas se sustituye por respuestas fijas. */
export interface ProviderClient {
  listPhoneNumbers(apiKey: string): Promise<YCloudPhoneNumber[]>
  listWebhooks(apiKey: string): Promise<YCloudWebhookEndpoint[]>
  getBalance(apiKey: string): Promise<{ amount: number; currency: string } | null>
  getTelegramBotName(token: string): Promise<string | null>
}

/** Por debajo de esto, WhatsApp puede dejar de entregar en cualquier momento. */
export const SALDO_MINIMO_USD = 2

const normalizePhone = (value: unknown): string => String(value ?? '').replace(/\D/g, '')

/**
 * De quién es el canal que se está revisando.
 *
 * Existe para que las comprobaciones de YCloud —que son las mismas— no se
 * escriban dos veces: una para el negocio con número propio y otra para el
 * número de la plataforma. `businessId` es nulo cuando el canal es de la
 * plataforma, y así llega al registro de errores, que ya sabe pintar eso como
 * «plataforma».
 *
 * `sujeto` es el sustantivo con el que empieza cada mensaje: leer «El negocio
 * no tiene API Key» sobre el número de Umbani mandaría a revisar la ficha de un
 * local que no tiene ninguna.
 */
interface CanalRevisado {
  businessId: string | null
  businessName: string
  sujeto: string
}

const problema = (
  canal: CanalRevisado,
  provider: string,
  severity: IssueSeverity,
  code: string,
  message: string,
): CredentialIssue => ({
  businessId: canal.businessId,
  businessName: canal.businessName,
  provider,
  severity,
  code,
  message,
})

const canalDelNegocio = (business: MonitorableBusiness): CanalRevisado => ({
  businessId: business.id,
  businessName: String(business.name || '(sin nombre)'),
  sujeto: 'El negocio',
})

const issue = (
  business: MonitorableBusiness,
  provider: string,
  severity: IssueSeverity,
  code: string,
  message: string,
): CredentialIssue => problema(canalDelNegocio(business), provider, severity, code, message)

/**
 * Las comprobaciones de un canal de YCloud, vengan sus credenciales de donde
 * vengan: de la ficha de un negocio o de `server_settings`.
 *
 * Se extrajo tal cual del cuerpo de `checkBusinessCredentials` —mismas
 * preguntas, mismos códigos, mismo orden— para que el número de la plataforma
 * reciba EXACTAMENTE la misma vigilancia y no una versión recortada que se
 * quede corta justo el día que haga falta.
 */
async function revisarCanalYCloud(
  canal: CanalRevisado,
  credenciales: { apiKey: string; numero: string },
  client: ProviderClient,
  options: { baseUrl?: string } = {},
): Promise<CredentialIssue[]> {
  const problemas: CredentialIssue[] = []
  const apiKey = credenciales.apiKey.trim()
  if (!apiKey) {
    problemas.push(problema(canal, 'ycloud', 'error', 'sin_api_key',
      `${canal.sujeto} no tiene API Key de YCloud: no puede enviar ni recibir`))
    return problemas
  }

  let numeros: YCloudPhoneNumber[]
  try {
    numeros = await client.listPhoneNumbers(apiKey)
  } catch (error) {
    problemas.push(problema(canal, 'ycloud', 'error', 'api_key_rechazada',
      `YCloud rechazó la API Key: ${error instanceof Error ? error.message : 'sin detalle'}`))
    return problemas
  }

  const propio = normalizePhone(credenciales.numero)
  const encontrado = numeros.find(n => normalizePhone(n.phoneNumber) === propio)
  if (!propio) {
    problemas.push(problema(canal, 'ycloud', 'error', 'sin_numero',
      `${canal.sujeto} no tiene número de WhatsApp configurado`))
  } else if (!encontrado) {
    problemas.push(problema(canal, 'ycloud', 'error', 'numero_ajeno',
      'El número configurado no aparece en la cuenta de YCloud'))
  } else if (encontrado.status && encontrado.status !== 'CONNECTED') {
    problemas.push(problema(canal, 'ycloud', 'error', 'numero_desconectado',
      `El número está en estado ${encontrado.status}, no CONNECTED`))
  }

  // El webhook es el eslabón que se rompió en julio: seguía marcado activo
  // pero ya no entregaba, y su URL puede quedar apuntando a un dominio viejo.
  try {
    const webhooks = await client.listWebhooks(apiKey)
    const activos = webhooks.filter(w => w.status === 'active')
    if (!activos.length) {
      problemas.push(problema(canal, 'ycloud', 'error', 'sin_webhook',
        'No hay ningún webhook activo en YCloud: los mensajes no llegarán'))
    } else {
      const esperado = String(options.baseUrl || '').trim().replace(/\/$/, '')
      if (esperado && !activos.some(w => String(w.url || '').startsWith(esperado))) {
        problemas.push(problema(canal, 'ycloud', 'error', 'webhook_desviado',
          `El webhook de YCloud no apunta a ${esperado}`))
      }
      if (!activos.some(w => (w.enabledEvents || [])
        .includes('whatsapp.inbound_message.received'))) {
        problemas.push(problema(canal, 'ycloud', 'error', 'webhook_sin_evento',
          'El webhook no está suscrito a los mensajes entrantes'))
      }
    }
  } catch (error) {
    problemas.push(problema(canal, 'ycloud', 'aviso', 'webhook_no_verificable',
      `No se pudo leer la configuración del webhook: ${error instanceof Error ? error.message : 'sin detalle'}`))
  }

  // Saldo: avisa ANTES de quedarse sin servicio, no después.
  try {
    const saldo = await client.getBalance(apiKey)
    if (saldo && saldo.amount < SALDO_MINIMO_USD) {
      problemas.push(problema(canal, 'ycloud', 'aviso', 'saldo_bajo',
        `Saldo de YCloud bajo: ${saldo.amount} ${saldo.currency}`))
    }
  } catch {
    // El saldo es informativo: no poder leerlo no es un problema del canal.
  }
  return problemas
}

/**
 * Revisa las credenciales de UN negocio. Devuelve la lista de problemas: vacía
 * significa que el canal está en condiciones de recibir y responder.
 */
export async function checkBusinessCredentials(
  business: MonitorableBusiness,
  client: ProviderClient,
  options: { baseUrl?: string } = {},
): Promise<CredentialIssue[]> {
  const problemas: CredentialIssue[] = []
  const provider = String(business.whatsapp_provider || '').trim()

  // ⚠️ EXPLÍCITO, y no por gusto. Un negocio del marketplace no tiene canal
  // propio: sus clientes escriben al número de la plataforma, que se revisa
  // aparte en `checkPlatformCredentials`. Devolver «sin problemas» es correcto
  // —no hay credenciales suyas que puedan estar mal—, pero hasta el 2026-08-23
  // se llegaba aquí por CAÍDA: `'marketplace'` no casaba con ninguna rama y
  // salía por el final sin que nadie lo hubiera decidido. Nombrarlo convierte
  // el silencio en una decisión, y deja el hueco a la vista si mañana aparece
  // un proveedor nuevo.
  if (provider === 'marketplace') return problemas

  if (provider === 'ycloud') {
    return revisarCanalYCloud(
      canalDelNegocio(business),
      {
        apiKey: String(business.ycloud_api_key || ''),
        numero: String(business.ycloud_number || business.whatsapp_number || ''),
      },
      client,
      options,
    )
  }

  if (provider === 'telegram' || String(business.telegram_bot_token || '').trim()) {
    const token = String(business.telegram_bot_token || '').trim()
    if (!token) {
      problemas.push(issue(business, 'telegram', 'error', 'sin_token',
        'El negocio usa Telegram pero no tiene token de bot'))
      return problemas
    }
    try {
      const nombre = await client.getTelegramBotName(token)
      if (!nombre) {
        problemas.push(issue(business, 'telegram', 'error', 'token_invalido',
          'Telegram no reconoce el token del bot'))
      }
    } catch (error) {
      problemas.push(issue(business, 'telegram', 'error', 'token_invalido',
        `Telegram rechazó el token: ${error instanceof Error ? error.message : 'sin detalle'}`))
    }
    return problemas
  }

  if (!provider) {
    problemas.push(issue(business, 'ninguno', 'aviso', 'sin_proveedor',
      'El negocio no tiene canal de WhatsApp configurado todavía'))
  }
  return problemas
}

/** Lo que hace falta saber del canal de la plataforma para revisarlo. */
export interface MonitorablePlatformChannel {
  apiKey: string
  number: string
  webhookSecret: string | null
  endpointId: string | null
}

/** El nombre con el que sale el canal de la plataforma en el registro. */
export const NOMBRE_CANAL_PLATAFORMA = 'Número del marketplace'

/**
 * Revisa el NÚMERO DE LA PLATAFORMA: el único canal de entrada que tiene hoy
 * todo el marketplace.
 *
 * ⚠️ Es la revisión que más pesa de las dos, y es la que faltaba. Un negocio
 * con el canal caído deja mudo a un local; este número caído deja muda a la
 * plataforma ENTERA, y con ella a todos los locales que dependen de él.
 *
 * ⚠️ `businessId: null` a propósito: el número no pertenece a ningún local, y
 * cargarle sus problemas a uno elegido a dedo sería la misma confusión que
 * `businesses_marketplace_sin_canal_check` existe para impedir. En el panel de
 * Errores sale como «plataforma».
 *
 * ⚠️ El webhook se comprueba EN DOS SITIOS y no es redundancia: YCloud dice si
 * el endpoint existe y a dónde apunta, pero no sabe nada de nuestro Signing
 * Secret ni de nuestro Endpoint ID. Sin ellos el webhook responde 503 en
 * producción y el número queda mudo con la cuenta perfectamente sana — que es
 * justo el fallo que no se ve desde fuera.
 */
export async function checkPlatformCredentials(
  channel: MonitorablePlatformChannel | null,
  client: ProviderClient,
  options: { baseUrl?: string } = {},
): Promise<CredentialIssue[]> {
  const canal: CanalRevisado = {
    businessId: null,
    businessName: NOMBRE_CANAL_PLATAFORMA,
    sujeto: 'El número del marketplace',
  }

  // Sin configurar no es un fallo del canal: es una plataforma que todavía no
  // tiene número. Se avisa, porque con locales de marketplace dados de alta
  // significa que ninguno puede recibir un solo mensaje.
  if (!channel) {
    return [problema(canal, 'ycloud', 'error', 'plataforma_sin_canal',
      'El número del marketplace no está configurado: ningún local puede recibir mensajes. Ajustes del servidor → Número del marketplace')]
  }

  const problemas = await revisarCanalYCloud(
    canal,
    { apiKey: channel.apiKey, numero: channel.number },
    client,
    options,
  )

  if (!channel.webhookSecret) {
    problemas.push(problema(canal, 'ycloud', 'error', 'plataforma_sin_secreto',
      'Falta el Signing Secret del webhook: en producción las entregas se rechazan con 503 y el número queda mudo'))
  }
  if (!channel.endpointId) {
    problemas.push(problema(canal, 'ycloud', 'error', 'plataforma_sin_endpoint',
      'Falta el Endpoint ID del webhook: no se puede comprobar la firma de las entregas'))
  }
  return problemas
}

/**
 * Revisa todos los negocios activos. Los suspendidos se omiten: sus credenciales
 * pueden estar caducadas a propósito y avisar por ellos sería ruido.
 */
export async function checkAllCredentials(
  businesses: MonitorableBusiness[],
  client: ProviderClient,
  options: { baseUrl?: string } = {},
): Promise<CredentialIssue[]> {
  const activos = businesses.filter(
    business => business.active !== false && business.suspended !== true,
  )
  const porNegocio = await Promise.all(activos.map(async (business) => {
    try {
      return await checkBusinessCredentials(business, client, options)
    } catch (error) {
      // Un negocio que falle no puede impedir revisar los demás.
      return [issue(business, 'desconocido', 'aviso', 'revision_fallida',
        `No se pudo revisar: ${error instanceof Error ? error.message : 'sin detalle'}`)]
    }
  }))
  return porNegocio.flat()
}

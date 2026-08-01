// Vigilancia proactiva de las credenciales de cada negocio.
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

const issue = (
  business: MonitorableBusiness,
  provider: string,
  severity: IssueSeverity,
  code: string,
  message: string,
): CredentialIssue => ({
  businessId: business.id,
  businessName: String(business.name || '(sin nombre)'),
  provider,
  severity,
  code,
  message,
})

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

  if (provider === 'ycloud') {
    const apiKey = String(business.ycloud_api_key || '').trim()
    if (!apiKey) {
      problemas.push(issue(business, 'ycloud', 'error', 'sin_api_key',
        'El negocio no tiene API Key de YCloud: no puede enviar ni recibir'))
      return problemas
    }

    let numeros: YCloudPhoneNumber[]
    try {
      numeros = await client.listPhoneNumbers(apiKey)
    } catch (error) {
      problemas.push(issue(business, 'ycloud', 'error', 'api_key_rechazada',
        `YCloud rechazó la API Key: ${error instanceof Error ? error.message : 'sin detalle'}`))
      return problemas
    }

    const propio = normalizePhone(business.ycloud_number || business.whatsapp_number)
    const encontrado = numeros.find(n => normalizePhone(n.phoneNumber) === propio)
    if (!propio) {
      problemas.push(issue(business, 'ycloud', 'error', 'sin_numero',
        'El negocio no tiene número de WhatsApp configurado'))
    } else if (!encontrado) {
      problemas.push(issue(business, 'ycloud', 'error', 'numero_ajeno',
        'El número configurado no aparece en la cuenta de YCloud'))
    } else if (encontrado.status && encontrado.status !== 'CONNECTED') {
      problemas.push(issue(business, 'ycloud', 'error', 'numero_desconectado',
        `El número está en estado ${encontrado.status}, no CONNECTED`))
    }

    // El webhook es el eslabón que se rompió en julio: seguía marcado activo
    // pero ya no entregaba, y su URL puede quedar apuntando a un dominio viejo.
    try {
      const webhooks = await client.listWebhooks(apiKey)
      const activos = webhooks.filter(w => w.status === 'active')
      if (!activos.length) {
        problemas.push(issue(business, 'ycloud', 'error', 'sin_webhook',
          'No hay ningún webhook activo en YCloud: los mensajes no llegarán'))
      } else {
        const esperado = String(options.baseUrl || '').trim().replace(/\/$/, '')
        if (esperado && !activos.some(w => String(w.url || '').startsWith(esperado))) {
          problemas.push(issue(business, 'ycloud', 'error', 'webhook_desviado',
            `El webhook de YCloud no apunta a ${esperado}`))
        }
        if (!activos.some(w => (w.enabledEvents || [])
          .includes('whatsapp.inbound_message.received'))) {
          problemas.push(issue(business, 'ycloud', 'error', 'webhook_sin_evento',
            'El webhook no está suscrito a los mensajes entrantes'))
        }
      }
    } catch (error) {
      problemas.push(issue(business, 'ycloud', 'aviso', 'webhook_no_verificable',
        `No se pudo leer la configuración del webhook: ${error instanceof Error ? error.message : 'sin detalle'}`))
    }

    // Saldo: avisa ANTES de quedarse sin servicio, no después.
    try {
      const saldo = await client.getBalance(apiKey)
      if (saldo && saldo.amount < SALDO_MINIMO_USD) {
        problemas.push(issue(business, 'ycloud', 'aviso', 'saldo_bajo',
          `Saldo de YCloud bajo: ${saldo.amount} ${saldo.currency}`))
      }
    } catch {
      // El saldo es informativo: no poder leerlo no es un problema del canal.
    }
    return problemas
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

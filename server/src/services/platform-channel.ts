import { normalizeChannelIdentifier } from '../types/channels'
import type { WhatsAppChannelAddress } from '../types/channels'

/**
 * El canal del marketplace: UN número de WhatsApp para toda la plataforma.
 *
 * Hasta el 2026-08-20 el número ERA la llave de enrutado: cada negocio tenía
 * el suyo y `getBusinessByChannel` respondía «este mensaje es de tal local».
 * Con un número único esa pregunta ya no tiene respuesta en el número, así
 * que estas credenciales no pueden vivir en `businesses` — no son de ningún
 * local. Viven en `server_settings`, que es la tabla de la plataforma.
 *
 * Vive aparte para que el webhook, el envío y el enrutado no se inventen
 * cada uno su versión de «¿este número es el nuestro?», que es exactamente
 * como se acaba con dos respuestas distintas a la misma pregunta.
 */

interface ModuloSettings {
  get(key: string): Promise<string | null>
}
const settings: ModuloSettings = require('./settings') as typeof import('./settings')

export interface PlatformChannel {
  apiKey: string
  number: string
  webhookSecret: string | null
  endpointId: string | null
}

/**
 * Las credenciales del número de la plataforma, o `null` si no está
 * configurado.
 *
 * ⚠️ Exige API key Y número juntos: con solo uno de los dos el canal no
 * puede ni enviar ni reconocerse a sí mismo, y media configuración que
 * parece válida es peor que ninguna — fallaría más tarde y más lejos.
 */
export const getPlatformChannel = async (): Promise<PlatformChannel | null> => {
  // Un fallo leyendo `server_settings` devuelve «no configurado», que es el
  // comportamiento de antes de que la plataforma existiera: el mensaje se
  // descarta. Dejar que lance tumbaría el webhook ENTERO —incluidos los
  // negocios con número propio, que no tienen nada que ver con esto— y ese
  // es exactamente el fallo que dejó el canal mudo cinco días en julio.
  const leidas = await Promise.all([
    settings.get('platform_ycloud_api_key'),
    settings.get('platform_ycloud_number'),
    settings.get('platform_webhook_secret'),
    settings.get('platform_webhook_endpoint_id'),
  ]).catch(() => null)
  if (!leidas) return null
  const [apiKey, rawNumber, webhookSecret, endpointId] = leidas
  const number = normalizeChannelIdentifier('phone', rawNumber)
  if (!apiKey?.trim() || !number) return null
  return {
    apiKey: apiKey.trim(),
    number,
    webhookSecret: webhookSecret?.trim() || null,
    endpointId: endpointId?.trim() || null,
  }
}

/**
 * ¿Alguna de estas direcciones es el número de la plataforma?
 *
 * Se compara SIEMPRE normalizado: el mismo número llega como `+593…` desde
 * un proveedor y como `593…` desde otro, y comparar en crudo daría «no» a
 * dos escrituras del mismo teléfono. Es el mismo motivo por el que
 * `getLastOrderForContact` busca por variantes.
 *
 * Solo mira direcciones de tipo `phone`: un `account_id` de Meta no es un
 * número y compararlo con uno daría siempre falso, pero por accidente.
 */
export const esNumeroDePlataforma = (
  addresses: WhatsAppChannelAddress[],
  platformNumber: string,
): boolean => addresses.some(address => (
  address.identifierType === 'phone'
  && normalizeChannelIdentifier('phone', address.identifier) === platformNumber
))

interface CanalDeSalida {
  sendText(business: unknown, to: string, text: string): Promise<void>
  sendInteractive(
    business: unknown,
    to: string,
    body: string,
    options: { id: string; title: string; description?: string }[],
    listButtonText?: string,
  ): Promise<boolean>
}

/**
 * Manda un mensaje por el número de la plataforma.
 *
 * El «negocio» que se pasa es solo el marcador `marketplace`:
 * `conCanalDePlataforma` (integrations/whatsapp.ts) lo cambia por las
 * credenciales reales. Así el envío del marketplace no duplica la lógica de
 * envío ni conoce las claves.
 *
 * ⚠️ `id: null` a propósito: un mensaje de antes de elegir local no se le
 * cobra a ningún negocio. `recordOutboundUsage` con negocio nulo no escribe
 * nada, que es exactamente lo que debe pasar — el consumo es de la
 * plataforma, y cargárselo a un local elegido después sería inventarle gasto.
 *
 * ⚠️ Si la lista interactiva falla se cae a TEXTO con las opciones numeradas.
 * Quedarse sin respuesta es peor que responder sin botones, y `elegir()` del
 * menú acepta que el cliente escriba la opción.
 */
export const enviarPorLaPlataforma = async (
  to: string,
  reply: string,
  options: string[] = [],
): Promise<void> => {
  // `require` diferido: `integrations/whatsapp` importa este módulo, así que
  // un import arriba cerraría el ciclo al arrancar.
  const whatsapp = require('../integrations/whatsapp') as CanalDeSalida
  const negocio = { id: null, whatsapp_provider: 'marketplace' }

  if (options.length) {
    const enviada = await whatsapp.sendInteractive(
      negocio,
      to,
      reply,
      options.map((title, indice) => ({ id: `opt_${indice}`, title })),
      'Ver opciones',
    )
    if (enviada) return
    const listado = options.map((opcion, i) => `${i + 1}. ${opcion}`).join('\n')
    await whatsapp.sendText(negocio, to, `${reply}\n\n${listado}`)
    return
  }
  await whatsapp.sendText(negocio, to, reply)
}

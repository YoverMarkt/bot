// El enlace de la tienda que el bot le manda al cliente.
//
// Es la pieza que une el chat con la mini app. Tres decisiones que no son
// obvias y conviene tener presentes:
//
//  1. **El enlace lo arma el CÓDIGO, nunca la IA.** Un modelo que "recuerda"
//     una URL acabaría inventando tokens y mandando a la gente a una pantalla
//     de error. Aquí no hay margen: la URL se construye con el slug real y un
//     token recién creado.
//  2. **Cada enlace es nuevo, y ninguno caduca.** El token solo se guarda
//     hasheado, así que un enlace ya enviado no se puede reconstruir. Pedirlo
//     otra vez genera otro y el anterior sigue vivo: no se revoca a propósito,
//     para no romperle el pedido a quien lo tenga abierto. Lo que impide que
//     un enlace reenviado sirva no es el reloj, es tener que confirmar el
//     número de WhatsApp al que se emitió.
//  3. **Con cooldown.** Sin él, cada "hola" crearía una sesión y llenaría la
//     tabla; y el cliente vería el mismo enlace repetido, que parece un bot roto.

import { createSessionToken } from './storefront-session'

export interface LinkBusiness {
  id: string
  name?: string | null
  slug?: string | null
  storefront_enabled?: boolean | null
  takes_orders?: boolean | null
  lodging_enabled?: boolean | null
}

interface LinkDatabase {
  resolveCustomer(input: {
    businessId: string
    phone: string
    name?: string | null
  }): Promise<{ id: string }>
  createStorefrontSession(input: {
    businessId: string
    customerId: string
    tokenHash: string
    contactPhone: string
    /** Nulo = el enlace no caduca. */
    expiresAt: string | null
  }): Promise<unknown>
}

/** No se manda el mismo enlace en cada mensaje: molesta y llena la tabla. */
export const RESEND_COOLDOWN_MS = 10 * 60 * 1000

/**
 * ¿Este negocio puede ofrecer tienda?
 *
 * Mismas reglas que la tienda misma: sin catálogo ni hospedaje no hay nada que
 * mostrar, y mandar a alguien a una app vacía es peor que no mandarlo.
 */
export function storefrontAvailable(business: LinkBusiness | null): boolean {
  if (!business?.id || !business.slug) return false
  if (business.storefront_enabled !== true) return false
  return business.takes_orders === true || business.lodging_enabled === true
}

/**
 * Arma la URL. Devuelve null si falta algo, en vez de un enlace roto.
 *
 * Es deliberadamente CORTA: solo `/s/<token>`. El slug no viaja porque el
 * token ya identifica al negocio, y en un mensaje de WhatsApp cada carácter
 * cuenta — un enlace largo se lee como spam y la gente no lo toca. El servidor
 * lo resuelve y redirige a la tienda real.
 */
export function buildStorefrontUrl(input: {
  baseUrl?: string | null
  slug?: string | null
  token: string
}): string | null {
  const base = String(input.baseUrl || '').trim().replace(/\/+$/, '')
  // El slug se sigue exigiendo aunque no salga en la URL: sin él la redirección
  // no tendría destino.
  const slug = String(input.slug || '').trim()
  if (!base || !slug || !input.token) return null
  if (!/^https?:\/\//i.test(base)) return null
  return `${base}/s/${encodeURIComponent(input.token)}`
}

/**
 * El texto que acompaña al enlace. Dice lo que el cliente necesita saber sin
 * prometer nada: que es suyo, y que caduca.
 */
/** ¿Este negocio vende noches o vende productos? Decide cómo se invita. */
const esAlojamiento = (business: LinkBusiness): boolean => (
  business.lodging_enabled === true && business.takes_orders !== true
)

/** La coletilla, en los dos formatos. Dice que el enlace es SUYO. */
const PIE_DEL_ENLACE = 'Tu enlace personal · guárdalo, no vence'

/**
 * El enlace como BOTÓN nativo de WhatsApp (`cta_url`), que es como se manda
 * desde el 2026-08-12.
 *
 * Una URL cruda en el chat ocupa tres líneas, se parte en pantallas estrechas
 * y se lee como publicidad: el propio texto de abajo pedía disculpas por ello
 * («un bloque de texto con un enlace dentro se lee como publicidad»). El botón
 * dice lo mismo con una línea y un toque.
 *
 * ⚠️ La etiqueta va SIN EMOJI y corta: WhatsApp la limita a 20 BYTES, y un
 * emoji gasta cuatro. El adorno se queda en el cuerpo, que admite 1024.
 *
 * ⚠️ El texto plano (`storefrontInvite`) NO se retira: es el respaldo cuando
 * el canal no admite botones —Telegram, Meta directo— o cuando YCloud rechaza
 * el envío, y es además lo que se guarda en el historial para que el dueño vea
 * en su panel qué enlace se mandó.
 */
export function storefrontInviteButton(business: LinkBusiness, url: string): {
  body: string
  url: string
  label: string
  footer: string
} {
  const alojamiento = esAlojamiento(business)
  return {
    body: alojamiento
      ? '🛏️ Mira las habitaciones y reserva desde aquí 👇'
      : '🛍️ Mira la carta y pide desde aquí 👇',
    url,
    label: alojamiento ? 'Ver habitaciones' : 'Ver la carta',
    footer: PIE_DEL_ENLACE,
  }
}

export function storefrontInvite(business: LinkBusiness, url: string): string {
  const compra = esAlojamiento(business)
    ? '🛏️ Mira las habitaciones y reserva aquí:'
    : '🛍️ Mira la carta y pide aquí:'
  // Tres líneas y ni una más. En un chat, un bloque de texto con un enlace
  // dentro se lee como publicidad y el cliente lo pasa de largo.
  // Ya no se anuncia caducidad porque no la hay. Sí se avisa de que es
  // personal: es lo que evita que el cliente lo reenvíe pensando que hace un
  // favor y acabe mandando a su amigo a una pantalla de "pide el tuyo".
  return `${compra}\n${url}\n_${PIE_DEL_ENLACE}_`
}

export function createStorefrontLinkService(dependencies: {
  database: LinkDatabase
  baseUrl?: () => string | null
  now?: () => number
}) {
  const { database } = dependencies
  const now = dependencies.now || (() => Date.now())
  const readBaseUrl = dependencies.baseUrl || (() => process.env.BASE_URL || null)

  // Última vez que se le mandó el enlace a cada contacto de cada negocio.
  const lastSent = new Map<string, number>()

  /** ¿Toca mandarlo, o se mandó hace nada? */
  function shouldSend(businessId: string, phone: string): boolean {
    const previous = lastSent.get(`${businessId}::${phone}`) || 0
    return now() - previous > RESEND_COOLDOWN_MS
  }

  function markSent(businessId: string, phone: string): void {
    // La memoria no puede crecer sin freno en un proceso que vive semanas.
    if (lastSent.size > 5000) lastSent.clear()
    lastSent.set(`${businessId}::${phone}`, now())
  }

  /**
   * Crea la sesión y devuelve el enlace listo para mandar.
   * Devuelve null si el negocio no tiene tienda, si falta `BASE_URL` o si el
   * enlace ya se mandó hace poco. Nunca lanza: quedarse sin enlace no puede
   * tumbar la conversación.
   */
  async function issueLink(input: {
    business: LinkBusiness
    phone: string
    name?: string | null
    /** true para saltarse el cooldown (el cliente lo pidió expresamente). */
    force?: boolean
  }): Promise<string | null> {
    const { business, phone } = input
    if (!storefrontAvailable(business) || !phone) return null
    if (!input.force && !shouldSend(business.id, phone)) return null

    try {
      const customer = await database.resolveCustomer({
        businessId: business.id,
        phone,
        name: input.name || null,
      })
      const { token, tokenHash } = createSessionToken()
      await database.createStorefrontSession({
        businessId: business.id,
        customerId: customer.id,
        tokenHash,
        contactPhone: phone,
        // Sin caducidad: lo que protege el enlace es el teléfono, no el reloj.
        expiresAt: null,
      })
      const url = buildStorefrontUrl({
        baseUrl: readBaseUrl(),
        slug: business.slug,
        token,
      })
      if (url) markSent(business.id, phone)
      return url
    } catch {
      // Sin enlace se sigue atendiendo por chat, como siempre.
      return null
    }
  }

  return { issueLink, shouldSend }
}

const database: LinkDatabase = require('../db') as typeof import('../db')
const service = createStorefrontLinkService({ database })

export const issueStorefrontLink = service.issueLink

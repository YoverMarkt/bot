// El enlace de la tienda que el bot le manda al cliente.
//
// Es la pieza que une el chat con la mini app. Tres decisiones que no son
// obvias y conviene tener presentes:
//
//  1. **El enlace lo arma el CÓDIGO, nunca la IA.** Un modelo que "recuerda"
//     una URL acabaría inventando tokens y mandando a la gente a una pantalla
//     de error. Aquí no hay margen: la URL se construye con el slug real y un
//     token recién creado.
//  2. **UNO VIVO A LA VEZ, y ninguno caduca.** El token solo se guarda
//     hasheado, así que un enlace ya enviado no se puede reconstruir. Ninguno
//     vence por reloj: lo que impide que un enlace reenviado sirva es tener
//     que confirmar el número de WhatsApp al que se emitió.
//
//     ⚠️ Pero emitir uno nuevo REVOCA los de los demás locales (2026-09-03).
//     Hasta esa fecha no se revocaba nada —`revoked_at` existía, lo miraba
//     `checkSession`, y nadie lo escribía jamás—, así que quien había pedido
//     en cinco locales tenía cinco enlaces vivos en su chat y podía subir tres
//     mensajes y volver a cualquiera con la conversación puesta en otro sitio.
//     El candado del chat no se enteraba, porque el enlace no pasa por el chat.
//
//     ⚠️ NO se revoca el del propio local (vaciaría el carrito que la persona
//     tiene abierto) ni el de un local donde queda un pedido en
//     `esperando_pago` (los datos bancarios viven detrás de la sesión). Las
//     dos excepciones las decide la RPC.
//  3. **Con cooldown.** Sin él, cada "hola" crearía una sesión y llenaría la
//     tabla; y el cliente vería el mismo enlace repetido, que parece un bot roto.

import { createSessionToken } from './storefront-session'

export interface LinkBusiness {
  id: string
  name?: string | null
  slug?: string | null
  storefront_enabled?: boolean | null
  takes_orders?: boolean | null
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
  }): Promise<{ id?: string } | null>
  /**
   * Revoca los demás enlaces vivos de esta persona.
   *
   * Opcional a propósito: es una MEJORA sobre el comportamiento anterior, y un
   * servicio construido sin ella (los tests que solo miran la URL) tiene que
   * seguir emitiendo enlaces igual.
   */
  revokeOtherStorefrontSessions?(
    customerId: string,
    keepSessionId: string,
  ): Promise<number>
}

/** No se manda el mismo enlace en cada mensaje: molesta y llena la tabla. */
export const RESEND_COOLDOWN_MS = 10 * 60 * 1000

/**
 * ¿Este negocio puede ofrecer tienda?
 *
 * Mismas reglas que la tienda misma: sin catálogo no hay nada que mostrar, y
 * mandar a alguien a una app vacía es peor que no mandarlo.
 */
export function storefrontAvailable(business: LinkBusiness | null): boolean {
  if (!business?.id || !business.slug) return false
  if (business.storefront_enabled !== true) return false
  return business.takes_orders === true
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
/** Los matices del mensaje. Ninguno cambia si el enlace se manda: solo cómo. */
export interface OpcionesDeInvitacion {
  /**
   * `true` cuando a este cliente ya se le mandó el enlace hace poco.
   *
   * ⚠️ Cambia el TEXTO, nunca el hecho de mandarlo. Hasta el 2026-08-12 este
   * caso no recibía enlace: se le contestaba «usa el enlace que te envié», y
   * quien había borrado el chat se quedaba sin poder pedir — pasó en
   * producción, con un cliente pegando la URL de la tienda en el chat dos
   * veces para intentar entrar. Ver `runMiniappMode`.
   */
  repetido?: boolean
  /**
   * A quién llamar, a partir de la quinta respuesta en una hora.
   *
   * Quien va por el quinto mensaje o no encuentra lo que busca, o no quiere
   * usar la app. Ofrecerle el teléfono **no cuesta un mensaje más** —es el
   * mismo, con una línea— y es lo único que de verdad puede desatascarlo.
   */
  telefonoDeAyuda?: string | null
}

/** «¿Necesitas ayuda? Llama al local: 099…», o nada si no hay teléfono. */
const lineaDeAyuda = (telefono?: string | null): string => {
  const limpio = String(telefono || '').trim()
  return limpio ? `\n\n¿Necesitas ayuda? Llama al local: ${limpio}` : ''
}

export function storefrontInviteButton(
  business: LinkBusiness,
  url: string,
  opciones: OpcionesDeInvitacion = {},
): {
  body: string
  url: string
  label: string
  footer: string
} {
  const primeraVez = '🛍️ Mira la carta y pide desde aquí 👇'
  // Se nombra que es «otra vez» para que no parezca que el bot se repite sin
  // enterarse: reconocerlo es lo que lo hace sonar atento en vez de roto.
  const cuerpo = opciones.repetido ? '🛍️ Aquí tienes tu enlace otra vez 👇' : primeraVez
  return {
    body: `${cuerpo}${lineaDeAyuda(opciones.telefonoDeAyuda)}`,
    url,
    label: 'Ver la carta',
    footer: PIE_DEL_ENLACE,
  }
}

export function storefrontInvite(
  business: LinkBusiness,
  url: string,
  /** Los mismos matices que el botón: cambian el texto, no el envío. */
  opciones: OpcionesDeInvitacion = {},
): string {
  const primeraVez = '🛍️ Mira la carta y pide aquí:'
  const compra = opciones.repetido ? '🛍️ Aquí tienes tu enlace otra vez:' : primeraVez
  // Tres líneas y ni una más. En un chat, un bloque de texto con un enlace
  // dentro se lee como publicidad y el cliente lo pasa de largo.
  // Ya no se anuncia caducidad porque no la hay. Sí se avisa de que es
  // personal: es lo que evita que el cliente lo reenvíe pensando que hace un
  // favor y acabe mandando a su amigo a una pantalla de "pide el tuyo".
  return `${compra}\n${url}\n_${PIE_DEL_ENLACE}_${lineaDeAyuda(opciones.telefonoDeAyuda)}`
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
      const sesion = await database.createStorefrontSession({
        businessId: business.id,
        customerId: customer.id,
        tokenHash,
        contactPhone: phone,
        // Sin caducidad: lo que protege el enlace es el teléfono, no el reloj.
        expiresAt: null,
      })

      // ⚠️ Después de crear la nueva, nunca antes: la RPC necesita saber cuál
      // conservar, y revocar primero dejaría a la persona un instante sin
      // ningún enlace vivo. Si algo falla aquí NO se pierde el enlace —el
      // `catch` de fuera devolvería null y el cliente se quedaría sin tienda
      // por una limpieza—, así que se traga aparte.
      if (sesion?.id && database.revokeOtherStorefrontSessions) {
        await database
          .revokeOtherStorefrontSessions(customer.id, sesion.id)
          .catch(() => 0)
      }
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

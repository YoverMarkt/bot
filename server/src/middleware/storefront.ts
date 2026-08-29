import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  checkSession,
  deviceFingerprint,
  hashToken,
  rejectionMessage,
  type SessionRejection,
} from '../services/storefront-session'

// Puerta de entrada de la mini app.
//
// Estas rutas NO llevan JWT: el enlace que manda el bot es la credencial. Por
// eso toda la comprobación vive aquí y no en cada endpoint — un endpoint que se
// olvide de validar es una tienda abierta a cualquiera.

interface StorefrontDatabase {
  getStorefrontSessionByHash(tokenHash: string): Promise<StorefrontSessionRow | null>
  claimStorefrontSession(sessionId: string, deviceHash: string): Promise<boolean>
  touchStorefrontSession(sessionId: string): Promise<void>
  getBusinessBySlug(slug: string): Promise<{ id?: string } | null>
  customerBlockState(businessId: string, customerId: string): Promise<EstadoDeBloqueo>
}

/** Lo que hay que saber de un bloqueo para poder explicarlo en pantalla. */
export interface EstadoDeBloqueo {
  blocked: boolean
  permanent: boolean
  until: string | null
}

interface StorefrontSessionRow {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  expires_at: string
  revoked_at: string | null
}

const db: StorefrontDatabase = require('../db') as typeof import('../db')

/** El token viaja en la cabecera; la URL solo lleva el slug del negocio. */
const readToken = (req: Request): string => {
  const header = req.headers['x-storefront-token']
  if (typeof header === 'string' && header.trim()) return header.trim()
  const query = (req.query || {}).session
  return typeof query === 'string' ? query.trim() : ''
}

/**
 * Huella del navegador. El `x-storefront-device` lo genera la app y lo guarda,
 * así que sobrevive a recargas; el resto son señales del propio navegador.
 */
const readDevice = (req: Request): string => deviceFingerprint({
  clientId: typeof req.headers['x-storefront-device'] === 'string'
    ? req.headers['x-storefront-device']
    : '',
  userAgent: req.headers['user-agent'] || '',
  acceptLanguage: req.headers['accept-language'] || '',
})

/**
 * Todo rechazo responde igual: 401 con un texto que no revela nada.
 *
 * ⚠️ Salvo el bloqueo, que va **403 y con el plazo**. Un 401 dice «tu
 * credencial no sirve» y la app manda a pedir otro enlace; aquí el enlace es
 * perfectamente válido y pedir otro no arreglaría nada — lo que pasa es que
 * esta persona no puede comprar en este local ahora mismo. Confundir las dos
 * cosas deja al cliente pidiendo enlaces en bucle.
 */
const reject = (
  res: Response,
  reason: SessionRejection,
  bloqueo?: EstadoDeBloqueo,
): Response => (
  reason === 'bloqueado'
    ? res.status(403).json({
      error: rejectionMessage(reason),
      reason,
      // El plazo solo existe en los temporales. En el permanente va nulo a
      // propósito: prometer una hora que no se cumple es peor que no prometer.
      until: bloqueo?.until ?? null,
      permanent: bloqueo?.permanent === true,
    })
    : res.status(401).json({ error: rejectionMessage(reason), reason })
)

/**
 * El trabajo común: resolver el negocio del slug y, si viene token, la sesión.
 *
 * Devuelve el negocio SIEMPRE que exista, y la sesión solo si es válida para
 * ESE negocio. Quien llama decide si la sesión es obligatoria — así los dos
 * middlewares no pueden divergir en lo que comprueban, que es donde aparecen
 * los agujeros.
 */
const resolveStorefront = async (req: Request): Promise<{
  businessId?: string
  session?: Express.StorefrontSession
  reason?: SessionRejection
  /** Presente solo cuando la sesión identifica a alguien bloqueado. */
  bloqueo?: EstadoDeBloqueo
}> => {
  const slug = String(req.params.slug || '').trim()
  if (!slug) return { reason: 'no_existe' }

  const business = await db.getBusinessBySlug(slug)
  if (!business?.id) return { reason: 'no_existe' }

  const token = readToken(req)
  if (!token) return { businessId: business.id, reason: 'no_existe' }

  const session = await db.getStorefrontSessionByHash(hashToken(token))
  const deviceHash = readDevice(req)
  const verdict = checkSession({
    session,
    deviceHash,
    // Sin esto, una sesión de otro negocio abriría esta tienda.
    expectedBusinessId: business.id,
  })
  if (!verdict.ok || !verdict.session) {
    return { businessId: business.id, reason: verdict.reason || 'no_existe' }
  }

  // La primera apertura se queda con la sesión. Si dos dispositivos abren el
  // mismo enlace a la vez, el UPDATE atómico decide y el otro se queda fuera.
  if (verdict.claims) {
    const claimed = await db.claimStorefrontSession(verdict.session.id, deviceHash)
    if (!claimed) return { businessId: business.id, reason: 'otro_dispositivo' }
  }

  void db.touchStorefrontSession(verdict.session.id).catch(() => {})

  // ── ¿Este local bloqueó a esta persona? ──────────────────────────────────
  //
  // ⚠️ Va AQUÍ, en el resolutor común, y no en cada ruta. Es la misma razón
  // por la que la comprobación de la sesión vive aquí: un endpoint que se
  // olvide es una puerta abierta. El 2026-08-29 el dueño entró bloqueado por
  // un enlace viejo y creó el pedido #74 — la tienda no miraba el bloqueo en
  // NINGÚN sitio, y lo único que había detrás era el disparador de la base,
  // que en ese momento decía lo contrario que el chat.
  //
  // ⚠️ La respuesta la da la base (`storefront_customer_block_state`), la
  // misma que usa `orders_reject_blocked`. Una segunda regla aquí sería
  // reabrir exactamente la grieta que se cerró.
  //
  // ⚠️ Falla ABIERTO: el repositorio devuelve «sin bloqueo» si la consulta
  // revienta. Dejar fuera a un cliente legítimo por un fallo nuestro es peor
  // que dejar mirar a un bloqueado, que de todas formas choca contra el
  // disparador al confirmar.
  const bloqueo = await db
    .customerBlockState(business.id, verdict.session.customer_id)
    .catch(() => ({ blocked: false, permanent: false, until: null }))

  if (bloqueo.blocked) {
    return { businessId: business.id, reason: 'bloqueado', bloqueo }
  }

  return {
    businessId: business.id,
    session: {
      businessId: business.id,
      customerId: verdict.session.customer_id,
      contactPhone: verdict.session.contact_phone,
      sessionId: verdict.session.id,
    },
  }
}

/**
 * Exige una sesión válida para el negocio de la URL. Deja en `req.storefront`
 * el negocio y el cliente ya resueltos, para que las rutas no vuelvan a mirarlo.
 *
 * Lo llevan todas las rutas que ESCRIBEN o que devuelven datos de una persona:
 * el pedido, las direcciones, el perfil.
 */
export const requireStorefrontSession: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Sin token se rechaza ANTES de tocar la base. Resolver el negocio para
    // alguien que no trae credencial es trabajo regalado, y a ritmo de
    // peticiones es una consulta gratis por cada intento.
    if (!readToken(req)) return reject(res, 'no_existe')

    const { session, reason, bloqueo } = await resolveStorefront(req)
    if (!session) return reject(res, reason || 'no_existe', bloqueo)
    req.storefront = session
    return next()
  } catch (error) {
    return next(error)
  }
}

/**
 * Deja pasar con sesión y sin ella. Es la puerta del CATÁLOGO, que es público:
 * el enlace de un negocio se reenvía, se pega en una historia o se busca, y
 * quien llegue tiene que poder ver la carta y los precios — como en cualquier
 * tienda de comida.
 *
 * Dos garantías que hacen que abrirlo no abra nada más:
 *
 *   · `req.storefront` se puebla SOLO con una sesión completa y válida para
 *     este negocio. Nunca a medias. Las rutas que crean pedidos siguen
 *     exigiendo `requireStorefrontSession` y no notan la diferencia.
 *   · Cuando SÍ viene un enlace válido hace lo mismo que antes: refresca
 *     `last_seen_at`, que pasaba por aquí y sin lo cual un cliente que solo
 *     mira la carta parecería inactivo. Confirmar el número sigue siendo cosa
 *     de `/session/verify`, que no se ha tocado.
 *
 * Un token inválido, revocado o de otro negocio no rompe la visita: se ve el
 * catálogo como cualquier visitante, sin sesión. Lo que no ocurre jamás es que
 * ese token acabe identificando a un cliente.
 */
export const readStorefrontSession: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { businessId, session, reason, bloqueo } = await resolveStorefront(req)
    if (!businessId) return res.status(404).json({ error: 'Esta tienda no está disponible' })
    // ⚠️ El catálogo es público, pero NO para quien está bloqueado y se
    // identifica con su enlace. La carta es «la manera de hacer pedidos», y
    // enseñársela a quien no puede pedir es justo lo que hay que evitar: el
    // 2026-08-29 el dueño la recorrió entera y llegó a confirmar. Quien llega
    // SIN enlace sigue viendo la carta como siempre — a ese no se le puede
    // identificar, así que tampoco bloquear.
    if (reason === 'bloqueado') return reject(res, reason, bloqueo)
    req.storeBusinessId = businessId
    if (session) req.storefront = session
    return next()
  } catch (error) {
    return next(error)
  }
}

/**
 * Resuelve el bloqueo SIN rechazar. Solo para la PORTADA.
 *
 * La portada es la única pantalla que un bloqueado debe recibir: lleva el
 * nombre, el logo y el WhatsApp del local, y nada accionable —ni carta, ni
 * precios, ni forma de pedir—. Con eso la app le pinta un aviso que se
 * reconoce como suyo en vez de un error pelado, y sabe que NO tiene que
 * montar la tienda.
 *
 * ⚠️ Nunca falla: sin token, con token inválido o con la consulta rota, sigue
 * adelante sin marcar nada. Es información para pintar, no una defensa — la
 * defensa son los 403 de los otros dos middlewares y el disparador de la base.
 */
export const readStorefrontBlock: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  try {
    const { bloqueo } = await resolveStorefront(req)
    if (bloqueo?.blocked) req.storefrontBlock = bloqueo
  } catch { /* la portada abre igual */ }
  return next()
}

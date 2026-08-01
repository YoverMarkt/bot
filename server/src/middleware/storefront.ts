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

const db = require('../db') as StorefrontDatabase

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

/** Todo rechazo responde igual: 401 con un texto que no revela nada. */
const reject = (res: Response, reason: SessionRejection): Response => res
  .status(401)
  .json({ error: rejectionMessage(reason), reason })

/**
 * Exige una sesión válida para el negocio de la URL. Deja en `req.storefront`
 * el negocio y el cliente ya resueltos, para que las rutas no vuelvan a mirarlo.
 */
export const requireStorefrontSession: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = readToken(req)
    if (!token) return reject(res, 'no_existe')

    const slug = String(req.params.slug || '').trim()
    if (!slug) return reject(res, 'no_existe')

    const business = await db.getBusinessBySlug(slug)
    if (!business?.id) return reject(res, 'no_existe')

    const session = await db.getStorefrontSessionByHash(hashToken(token))
    const deviceHash = readDevice(req)
    const verdict = checkSession({
      session,
      deviceHash,
      // Sin esto, una sesión de otro negocio abriría esta tienda.
      expectedBusinessId: business.id,
    })
    if (!verdict.ok || !verdict.session) {
      return reject(res, verdict.reason || 'no_existe')
    }

    // La primera apertura se queda con la sesión. Si dos dispositivos abren el
    // mismo enlace a la vez, el UPDATE atómico decide y el otro se queda fuera.
    if (verdict.claims) {
      const claimed = await db.claimStorefrontSession(verdict.session.id, deviceHash)
      if (!claimed) return reject(res, 'otro_dispositivo')
    }

    void db.touchStorefrontSession(verdict.session.id).catch(() => {})

    req.storefront = {
      businessId: business.id,
      customerId: verdict.session.customer_id,
      contactPhone: verdict.session.contact_phone,
      sessionId: verdict.session.id,
    }
    return next()
  } catch (error) {
    return next(error)
  }
}

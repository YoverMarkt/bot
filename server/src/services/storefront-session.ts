import crypto from 'node:crypto'

// Sesiones de la mini app del negocio.
//
// La tienda NO tiene registro ni contraseña: el cliente ya se identificó al
// escribir por WhatsApp, y el enlace que le manda el bot ES su sesión.
//
// Tres decisiones que sostienen la seguridad de todo esto:
//
//  1. En la base se guarda el HASH del token, nunca el token. Quien lea la base
//     no puede entrar en la tienda de nadie.
//  2. La sesión se ata al PRIMER dispositivo que la abre. Un enlace reenviado no
//     sirve para comprar: quien lo reciba verá una pantalla que le invita a
//     escribir al negocio para pedir el suyo.
//  3. Caduca en horas, no en días. Un enlace viejo no abre nada.
//
// Todo aquí es cálculo puro. La persistencia vive en el repositorio.

/** Horas de vida del enlace. Suficiente para pedir con calma, inútil mañana. */
export const SESSION_HOURS = 6

/** Bytes del token. 32 bytes = 256 bits: no se adivina. */
const TOKEN_BYTES = 32

export type SessionRejection =
  | 'no_existe'
  | 'caducada'
  | 'revocada'
  | 'otro_dispositivo'

export interface StorefrontSessionRecord {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  expires_at: string
  revoked_at: string | null
}

export interface SessionCheck {
  ok: boolean
  reason?: SessionRejection
  session?: StorefrontSessionRecord
  /** true si esta apertura reclama la sesión para este dispositivo. */
  claims?: boolean
}

const sha256 = (value: string): string => crypto
  .createHash('sha256')
  .update(String(value))
  .digest('hex')

/** Token nuevo: el texto va al enlace, el hash a la base. */
export function createSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, tokenHash: sha256(token) }
}

export const hashToken = (token: string): string => sha256(token)

/**
 * Huella del dispositivo. No pretende ser infalible —un fingerprint nunca lo
 * es— sino distinguir "el móvil del cliente" de "el móvil de su amigo", que es
 * lo único que hace falta para que un enlace reenviado no compre.
 */
export function deviceFingerprint(input: {
  userAgent?: string | null
  acceptLanguage?: string | null
  clientId?: string | null
}): string {
  return sha256([
    String(input.clientId || '').trim(),
    String(input.userAgent || '').trim(),
    String(input.acceptLanguage || '').trim(),
  ].join('|'))
}

/** Momento en que caduca una sesión creada ahora. */
export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000)
}

/**
 * ¿Puede este dispositivo usar esta sesión?
 *
 * La primera apertura la reclama; las siguientes deben venir del mismo sitio.
 */
export function checkSession(input: {
  session: StorefrontSessionRecord | null
  deviceHash: string
  now?: Date
}): SessionCheck {
  const { session, deviceHash } = input
  const now = input.now ?? new Date()

  if (!session) return { ok: false, reason: 'no_existe' }
  if (session.revoked_at) return { ok: false, reason: 'revocada' }
  if (new Date(session.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'caducada' }
  }

  // Nadie la ha reclamado todavía: este dispositivo se queda con ella.
  if (!session.device_hash) return { ok: true, session, claims: true }

  if (session.device_hash !== deviceHash) {
    return { ok: false, reason: 'otro_dispositivo', session }
  }
  return { ok: true, session, claims: false }
}

/** Qué contarle a quien no puede entrar. Nunca revela datos del dueño. */
export function rejectionMessage(reason: SessionRejection): string {
  switch (reason) {
    case 'otro_dispositivo':
      return 'Este enlace es personal y ya lo está usando otra persona. Escríbele al negocio por WhatsApp y te enviará el tuyo.'
    case 'caducada':
      return 'Este enlace ya venció. Escríbele al negocio por WhatsApp y te enviará uno nuevo.'
    case 'revocada':
      return 'Este enlace ya no está disponible. Escríbele al negocio por WhatsApp para continuar.'
    default:
      return 'Este enlace no es válido. Escríbele al negocio por WhatsApp para hacer tu pedido.'
  }
}

import type { RequestHandler } from 'express'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https:",
  // blob: solo en media: el panel genera el WAV de la alarma en memoria
  // (apps/client/src/lib/alarm.ts); sin blob: el navegador lo bloquea con
  // NotSupportedError y la alarma de pendientes queda muda.
  "media-src 'self' data: https: blob:",
  "connect-src 'self'",
].join('; ')

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  // ⚠️ `geolocation=(self)`, no `geolocation=()`.
  //
  // Con la lista VACÍA la ubicación queda prohibida en la página para todo el
  // mundo, y el navegador la deniega sin preguntar nada. Eso convirtió el pin
  // de la mini app en algo imposible de arreglar desde el teléfono: el cliente
  // tenía el permiso concedido en Android, en Chrome y en el sitio, y seguía
  // fallando — porque la propia página lo había prohibido. Costó dos rondas de
  // diagnóstico y un mensaje de error que mandaba al candado del navegador a
  // arreglar algo que el candado no controla.
  //
  // `(self)` lo permite SOLO en nuestro propio origen: un iframe de otro sitio
  // sigue sin poder pedirla, que es lo que esta cabecera protege de verdad.
  //
  // La cámara y el micrófono se quedan cerrados: el comprobante se sube con un
  // `<input type="file">`, que abre la galería del sistema y no necesita
  // permiso de cámara.
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(self), microphone=()')
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}

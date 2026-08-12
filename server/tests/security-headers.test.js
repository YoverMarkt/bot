import { afterEach, describe, expect, it } from 'vitest'
import security from '../dist/middleware/security-headers.js'

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

function run() {
  const headers = new Map()
  const response = { setHeader: (name, value) => headers.set(name, value) }
  let nextCalled = false
  security.securityHeaders({}, response, () => { nextCalled = true })
  return { headers, nextCalled }
}

describe('cabeceras HTTP de seguridad', () => {
  it('bloquea framing, sniffing y fuentes no permitidas', () => {
    const result = run()
    expect(result.nextCalled).toBe(true)
    expect(result.headers.get('X-Frame-Options')).toBe('DENY')
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(result.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('permite blob: solo en media (el WAV de la alarma) sin abrirlo en el resto', () => {
    const csp = run().headers.get('Content-Security-Policy')
    expect(csp).toContain("media-src 'self' data: https: blob:")
    // El resto de directivas siguen cerradas a blob:
    expect(csp.replace("media-src 'self' data: https: blob:", '')).not.toContain('blob:')
  })

  // ⚠️ Con la lista VACÍA —`geolocation=()`— la ubicación queda prohibida en la
  // página para todo el mundo y el navegador la deniega sin preguntar. Eso
  // rompió el pin de la mini app de una forma imposible de diagnosticar desde
  // el teléfono: el cliente tenía el permiso concedido en Android, en Chrome y
  // en el sitio, y seguía fallando porque la propia página lo prohibía.
  it('permite la ubicación en nuestro origen, y solo ahí', () => {
    const politica = run().headers.get('Permissions-Policy')
    expect(politica).toContain('geolocation=(self)')
    // La lista vacía es justo lo que no puede volver: no se distingue de un
    // permiso denegado por el usuario, y nadie lo arregla desde su teléfono.
    expect(politica).not.toContain('geolocation=()')
  })

  // El comprobante se sube con un `<input type="file">`, que abre la galería
  // del sistema: no hace falta cámara ni micrófono, así que siguen cerrados.
  it('la cámara y el micrófono siguen prohibidos', () => {
    const politica = run().headers.get('Permissions-Policy')
    expect(politica).toContain('camera=()')
    expect(politica).toContain('microphone=()')
  })

  it('activa HSTS únicamente en producción', () => {
    process.env.NODE_ENV = 'production'
    expect(run().headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    process.env.NODE_ENV = 'development'
    expect(run().headers.has('Strict-Transport-Security')).toBe(false)
  })
})

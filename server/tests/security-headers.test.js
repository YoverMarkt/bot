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

  it('activa HSTS únicamente en producción', () => {
    process.env.NODE_ENV = 'production'
    expect(run().headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    process.env.NODE_ENV = 'development'
    expect(run().headers.has('Strict-Transport-Security')).toBe(false)
  })
})

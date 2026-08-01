import { beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createErrorLogger,
  errorFingerprint,
  resetErrorLogThrottle,
  sanitizeContext,
  sanitizeErrorText,
} = require('../dist/services/error-log')

describe('registro de errores de plataforma', () => {
  beforeEach(() => resetErrorLogThrottle())

  describe('saneado — el log se descarga y se comparte', () => {
    it('borra teléfonos del cliente', () => {
      const limpio = sanitizeErrorText('Falló el envío a +593990978367 del hostal')
      expect(limpio).not.toContain('593990978367')
      expect(limpio).toContain('[telefono]')
    })

    it('borra correos', () => {
      const limpio = sanitizeErrorText('Rechazado para cliente@ejemplo.com')
      expect(limpio).not.toContain('cliente@ejemplo.com')
      expect(limpio).toContain('[correo]')
    })

    it('borra tokens JWT', () => {
      const limpio = sanitizeErrorText(
        'Authorization eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop',
      )
      expect(limpio).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    })

    it('borra claves con prefijo conocido', () => {
      const limpio = sanitizeErrorText('key sk-abcdefghijklmnopqrstuvwxyz123456 inválida')
      expect(limpio).not.toContain('abcdefghijklmnopqrstuvwxyz123456')
    })

    it('borra cadenas largas que parezcan credenciales', () => {
      const limpio = sanitizeErrorText('token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd')
      expect(limpio).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd')
    })

    it('recorta mensajes enormes', () => {
      expect(sanitizeErrorText('x'.repeat(9000)).length).toBeLessThanOrEqual(2000)
    })

    it('acepta Error, texto y objetos', () => {
      expect(sanitizeErrorText(new Error('fallo puntual'))).toBe('fallo puntual')
      expect(sanitizeErrorText('texto plano')).toBe('texto plano')
      expect(sanitizeErrorText({ a: 1 })).toContain('1')
      expect(sanitizeErrorText(undefined)).toBe('Error sin detalle')
    })

    it('sanea también el contexto y limita su tamaño', () => {
      const contexto = sanitizeContext({
        provider: 'ycloud',
        intentos: 3,
        ok: false,
        contacto: '+593990978367',
      })
      expect(contexto.provider).toBe('ycloud')
      expect(contexto.intentos).toBe(3)
      expect(contexto.ok).toBe(false)
      expect(contexto.contacto).toContain('[telefono]')

      const muchas = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v']),
      )
      expect(Object.keys(sanitizeContext(muchas)).length).toBeLessThanOrEqual(12)
      expect(sanitizeContext(undefined)).toEqual({})
    })
  })

  describe('huella', () => {
    it('agrupa el mismo error aunque cambien los números', () => {
      const a = errorFingerprint({ businessId: 'b1', category: 'canal', code: '503', message: 'falló tras 3 intentos' })
      const b = errorFingerprint({ businessId: 'b1', category: 'canal', code: '503', message: 'falló tras 7 intentos' })
      expect(a).toBe(b)
    })

    it('separa por negocio, categoría y código', () => {
      const base = { businessId: 'b1', category: 'canal', code: '503', message: 'error' }
      expect(errorFingerprint(base)).not.toBe(errorFingerprint({ ...base, businessId: 'b2' }))
      expect(errorFingerprint(base)).not.toBe(errorFingerprint({ ...base, category: 'ia' }))
      expect(errorFingerprint(base)).not.toBe(errorFingerprint({ ...base, code: '401' }))
    })

    it('devuelve un sha256 en hexadecimal', () => {
      const huella = errorFingerprint({ category: 'canal', message: 'x' })
      expect(huella).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('comportamiento del logger', () => {
    it('persiste el error ya saneado', async () => {
      const guardados = []
      const registrar = createErrorLogger({
        recordPlatformError: async input => { guardados.push(input) },
      })
      await registrar({
        businessId: 'biz-1',
        category: 'canal',
        code: 503,
        message: 'No se pudo encolar el mensaje de +593990978367',
        context: { provider: 'ycloud' },
      })
      expect(guardados).toHaveLength(1)
      expect(guardados[0].businessId).toBe('biz-1')
      expect(guardados[0].category).toBe('canal')
      expect(guardados[0].code).toBe('503')
      expect(guardados[0].message).not.toContain('593990978367')
      expect(guardados[0].fingerprint).toMatch(/^[0-9a-f]{64}$/)
    })

    // Un logger que tumba el servidor es peor que no tener logger.
    it('nunca propaga el fallo de la base', async () => {
      const registrar = createErrorLogger({
        recordPlatformError: async () => { throw new Error('base caída') },
      })
      await expect(registrar({ category: 'servidor', message: 'algo' })).resolves.toBeUndefined()
    })

    it('no repite el mismo error una y otra vez seguidas', async () => {
      const guardados = []
      const registrar = createErrorLogger({
        recordPlatformError: async input => { guardados.push(input) },
      })
      for (let i = 0; i < 5; i += 1) {
        await registrar({ category: 'canal', code: 503, message: 'mismo fallo' })
      }
      expect(guardados).toHaveLength(1)
    })

    it('errores distintos sí se registran por separado', async () => {
      const guardados = []
      const registrar = createErrorLogger({
        recordPlatformError: async input => { guardados.push(input) },
      })
      await registrar({ category: 'canal', code: 503, message: 'uno' })
      await registrar({ category: 'ia', code: 500, message: 'otro' })
      expect(guardados).toHaveLength(2)
    })
  })
})

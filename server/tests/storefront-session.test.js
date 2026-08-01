import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SESSION_HOURS,
  checkSession,
  createSessionToken,
  deviceFingerprint,
  hashToken,
  rejectionMessage,
  sessionExpiry,
} = require('../dist/services/storefront-session')

const ahora = new Date('2026-08-01T12:00:00.000Z')
const enHoras = h => new Date(ahora.getTime() + h * 3_600_000).toISOString()

const sesion = (extra = {}) => ({
  id: 'ses-1',
  business_id: 'biz-1',
  customer_id: 'cli-1',
  contact_phone: '593990978367',
  device_hash: null,
  claimed_at: null,
  expires_at: enHoras(6),
  revoked_at: null,
  ...extra,
})

const MOVIL_CLIENTE = deviceFingerprint({ userAgent: 'iPhone', clientId: 'abc' })
const MOVIL_AMIGO = deviceFingerprint({ userAgent: 'Android', clientId: 'xyz' })

describe('sesiones de la mini app', () => {
  describe('el token', () => {
    it('genera tokens distintos e impredecibles', () => {
      const a = createSessionToken()
      const b = createSessionToken()
      expect(a.token).not.toBe(b.token)
      expect(a.token.length).toBeGreaterThan(32)
    })

    // Si alguien lee la base, no puede entrar en la tienda de nadie.
    it('guarda el hash, nunca el token', () => {
      const { token, tokenHash } = createSessionToken()
      expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(tokenHash).not.toContain(token)
      expect(hashToken(token)).toBe(tokenHash)
    })

    it('caduca en 6 horas', () => {
      expect(SESSION_HOURS).toBe(6)
      const vence = sessionExpiry(ahora)
      expect(vence.toISOString()).toBe(enHoras(6))
    })
  })

  describe('huella del dispositivo', () => {
    it('distingue dos teléfonos distintos', () => {
      expect(MOVIL_CLIENTE).not.toBe(MOVIL_AMIGO)
    })

    it('es estable para el mismo dispositivo', () => {
      expect(deviceFingerprint({ userAgent: 'iPhone', clientId: 'abc' })).toBe(MOVIL_CLIENTE)
    })

    it('siempre devuelve un sha256', () => {
      expect(deviceFingerprint({})).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('quién puede comprar', () => {
    it('la primera apertura reclama la sesión', () => {
      const resultado = checkSession({ session: sesion(), deviceHash: MOVIL_CLIENTE, now: ahora })
      expect(resultado.ok).toBe(true)
      expect(resultado.claims).toBe(true)
    })

    it('el mismo dispositivo puede volver a entrar', () => {
      const resultado = checkSession({
        session: sesion({ device_hash: MOVIL_CLIENTE, claimed_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(true)
      expect(resultado.claims).toBe(false)
    })

    // El caso que pidió el usuario: el enlace reenviado NO compra.
    it('otro dispositivo con el mismo enlace queda fuera', () => {
      const resultado = checkSession({
        session: sesion({ device_hash: MOVIL_CLIENTE, claimed_at: ahora.toISOString() }),
        deviceHash: MOVIL_AMIGO,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('otro_dispositivo')
    })

    it('rechaza un enlace vencido', () => {
      const resultado = checkSession({
        session: sesion({ expires_at: enHoras(-1) }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('caducada')
    })

    it('rechaza una sesión revocada aunque no haya vencido', () => {
      const resultado = checkSession({
        session: sesion({ revoked_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('revocada')
    })

    it('rechaza un token que no existe', () => {
      const resultado = checkSession({ session: null, deviceHash: MOVIL_CLIENTE, now: ahora })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('no_existe')
    })

    // Sin esto, una sesión de la pizzería abriría la tienda del hostal con solo
    // cambiar el slug de la URL.
    it('un token de otro negocio no sirve aunque sea válido', () => {
      const resultado = checkSession({
        session: sesion({ business_id: 'biz-pizzeria' }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-hostal',
        now: ahora,
      })
      expect(resultado.ok).toBe(false)
      expect(resultado.reason).toBe('otro_negocio')
    })

    it('el token sí sirve en su propio negocio', () => {
      const resultado = checkSession({
        session: sesion({ business_id: 'biz-1' }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-1',
        now: ahora,
      })
      expect(resultado.ok).toBe(true)
    })

    // El negocio se comprueba ANTES que nada: un token caducado de otro negocio
    // no debe revelar siquiera que caducó.
    it('no distingue entre un token ajeno y uno inexistente', () => {
      const ajeno = checkSession({
        session: sesion({ business_id: 'biz-otro', revoked_at: ahora.toISOString() }),
        deviceHash: MOVIL_CLIENTE,
        expectedBusinessId: 'biz-1',
        now: ahora,
      })
      expect(rejectionMessage(ajeno.reason)).toBe(rejectionMessage('no_existe'))
    })
  })

  describe('qué se le dice a quien no puede entrar', () => {
    it('siempre lo manda a escribir al negocio', () => {
      for (const motivo of ['no_existe', 'caducada', 'revocada', 'otro_dispositivo']) {
        expect(rejectionMessage(motivo)).toMatch(/negocio/i)
      }
    })

    // La pantalla la ve un desconocido: no puede filtrar datos del dueño.
    it('nunca revela el teléfono ni el nombre del dueño de la sesión', () => {
      for (const motivo of ['no_existe', 'caducada', 'revocada', 'otro_dispositivo']) {
        const mensaje = rejectionMessage(motivo)
        expect(mensaje).not.toMatch(/\d{7,}/)
        expect(mensaje).not.toMatch(/593/)
      }
    })
  })
})

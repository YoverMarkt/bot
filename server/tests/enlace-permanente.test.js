import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  checkSession, phoneMatchesSession, rejectionMessage,
} = require('../dist/services/storefront-session')

// ═══════════════════════════════════════════════════════════════════════════
// EL ENLACE NO CADUCA, Y LO PROTEGE EL TELÉFONO
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-08-02 la sesión se ataba al PRIMER dispositivo que la abriera:
//
//     if (!session.device_hash) return { ok: true, claims: true }
//
// El agujero se ve en cuanto alguien reenvía el enlace ANTES de abrirlo: el
// amigo hace clic, se queda la sesión, y el cliente legítimo recibe «ya lo
// está usando otra persona» sobre un enlace suyo. Quedaba fuera de su propia
// tienda por haber sido educado.
//
// Ahora entra quien demuestre el número de WhatsApp al que se emitió.

const sesion = (extra = {}) => ({
  id: 's1', business_id: 'biz-1', customer_id: 'c1',
  contact_phone: '593999111222',
  device_hash: null, claimed_at: null,
  expires_at: null, revoked_at: null, verified_at: null,
  ...extra,
})

describe('el enlace no caduca', () => {
  it('una sesión sin fecha de caducidad sigue viva años después', () => {
    const dentroDeTresAnios = new Date('2029-08-02T12:00:00Z')
    const r = checkSession({
      session: sesion({ device_hash: 'dispositivo-a', claimed_at: '2026-08-02' }),
      deviceHash: 'dispositivo-a',
      now: dentroDeTresAnios,
    })
    expect(r.ok).toBe(true)
  })

  it('las viejas CON fecha siguen caducando hasta que se limpien', () => {
    const r = checkSession({
      session: sesion({
        device_hash: 'dispositivo-a', claimed_at: '2026-01-01',
        expires_at: '2026-01-01T00:00:00Z',
      }),
      deviceHash: 'dispositivo-a',
      now: new Date('2026-08-02T12:00:00Z'),
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('caducada')
  })
})

describe('EL RIESGO: reenviar el enlace antes de abrirlo', () => {
  it('el amigo que lo abre primero YA NO se queda la sesión', () => {
    const r = checkSession({
      session: sesion(),               // nadie la ha abierto todavía
      deviceHash: 'movil-del-amigo',
    })
    // Antes esto era { ok: true, claims: true } y el amigo entraba.
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('necesita_telefono')
  })

  it('el amigo pone SU número y no entra', () => {
    expect(phoneMatchesSession('593999111222', '593888000111')).toBe(false)
  })

  it('el cliente legítimo entra aunque el amigo lo abriera antes', () => {
    // Esta es la propiedad que faltaba: llegar segundo ya no te deja fuera.
    expect(phoneMatchesSession('593999111222', '593999111222')).toBe(true)
  })

  it('el cliente que cambia de teléfono vuelve a entrar con su número', () => {
    const r = checkSession({
      session: sesion({ device_hash: 'movil-viejo', claimed_at: '2026-08-01' }),
      deviceHash: 'movil-nuevo',
    })
    // No es un portazo: es "confirma quién eres".
    expect(r.reason).toBe('necesita_telefono')
    expect(r.session).toBeTruthy()
  })
})

describe('el número se compara como lo escribe la gente', () => {
  const casos = [
    ['593999111222', '593 999 111 222', true, 'con espacios'],
    ['593999111222', '+593-999-111-222', true, 'con guiones y +'],
    ['593999111222', '0999111222', true, 'sin código de país, con 0'],
    ['593999111222', '999111222', true, 'sin código de país ni 0'],
    ['593999111222', '593999111333', false, 'otro número parecido'],
    ['593999111222', '', false, 'vacío'],
    ['593999111222', '222', false, 'solo el final: demasiado corto'],
    ['593999111222', '1', false, 'un dígito no puede coincidir por el final'],
    ['', '593999111222', false, 'sesión sin teléfono'],
  ]
  for (const [sesionTel, escrito, esperado, nombre] of casos) {
    it(`${nombre}: "${escrito}" → ${esperado}`, () => {
      expect(phoneMatchesSession(sesionTel, escrito)).toBe(esperado)
    })
  }
})

describe('lo que ya protegía sigue protegiendo', () => {
  it('una sesión de otro negocio no abre esta tienda', () => {
    const r = checkSession({
      session: sesion({ device_hash: 'd1', claimed_at: 'x' }),
      deviceHash: 'd1',
      expectedBusinessId: 'biz-2',
    })
    expect(r.reason).toBe('otro_negocio')
    // Y el mensaje no delata que el token existe y es de otro sitio.
    expect(rejectionMessage('otro_negocio')).toBe(rejectionMessage('no_existe'))
  })

  it('una sesión revocada no entra ni con el número correcto', () => {
    const r = checkSession({
      session: sesion({ revoked_at: '2026-08-02' }),
      deviceHash: 'd1',
    })
    expect(r.reason).toBe('revocada')
  })

  it('un token que no existe no entra', () => {
    expect(checkSession({ session: null, deviceHash: 'd1' }).reason).toBe('no_existe')
  })
})

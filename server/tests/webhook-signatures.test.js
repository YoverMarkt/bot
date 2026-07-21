import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  YCLOUD_SIGNATURE_TOLERANCE_SECONDS,
  verifyYCloudSignature,
} = require('../dist/services/webhook-signatures')

function signature(body, secret, timestamp) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex')
  return `t=${timestamp},s=${digest}`
}

describe('firmas oficiales de webhooks YCloud', () => {
  const secret = 'whsec_test_signing_secret'
  const now = 1_800_000_000
  const body = Buffer.from('{"id":"evt-a","type":"whatsapp.inbound_message.received"}')

  it('valida el HMAC del timestamp y el cuerpo crudo', () => {
    expect(verifyYCloudSignature(
      body,
      signature(body, secret, now),
      secret,
      now,
    )).toBe(true)
  })

  it('acepta componentes desordenados y una firma válida entre varias', () => {
    const valid = signature(body, secret, now).split('s=')[1]
    expect(verifyYCloudSignature(
      body,
      `s=${'0'.repeat(64)},t=${now},s=${valid}`,
      secret,
      now,
    )).toBe(true)
  })

  it('rechaza cuerpos alterados, headers malformados y secretos incorrectos', () => {
    const header = signature(body, secret, now)
    expect(verifyYCloudSignature(Buffer.from('{}'), header, secret, now)).toBe(false)
    expect(verifyYCloudSignature(body, 't=no,s=1234', secret, now)).toBe(false)
    expect(verifyYCloudSignature(body, header, 'otro-secreto', now)).toBe(false)
    expect(verifyYCloudSignature(undefined, header, secret, now)).toBe(false)
  })

  it('rechaza replays fuera de la tolerancia', () => {
    const old = now - YCLOUD_SIGNATURE_TOLERANCE_SECONDS - 1
    expect(verifyYCloudSignature(
      body,
      signature(body, secret, old),
      secret,
      now,
    )).toBe(false)
  })
})

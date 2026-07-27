import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db/client')
const usage = require('../dist/db/repositories/usage')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repositorio de consumo', () => {
  it('registra un envío aceptado sin guardar el teléfono en claro', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ error: null })
    const insert = vi.fn().mockReturnValue({ abortSignal })
    const from = vi.spyOn(db, 'from').mockReturnValue({ insert })

    await expect(usage.recordOutboundUsage(
      '98a67b29-7a2c-47eb-94cb-f465c391e16f',
      'ycloud',
      '+593991234567',
      'image',
    )).resolves.toBe(true)

    expect(from).toHaveBeenCalledWith('message_usage_events')
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      business_id: '98a67b29-7a2c-47eb-94cb-f465c391e16f',
      provider: 'ycloud',
      direction: 'outbound',
      message_type: 'image',
      source_kind: 'send',
    }))
    const payload = insert.mock.calls[0][0]
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(payload.contact_key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(payload)).not.toContain('+593991234567')
  })

  it('no intenta persistir mensajes sin negocio resuelto', async () => {
    const from = vi.spyOn(db, 'from')
    await expect(usage.recordOutboundUsage(
      null,
      'meta',
      '593991234567',
      'text',
    )).resolves.toBe(false)
    expect(from).not.toHaveBeenCalled()
  })

  it('normaliza los bigint de la RPC para el contrato JSON del panel', async () => {
    vi.spyOn(db, 'rpc').mockResolvedValue({
      data: [{
        business_id: 'business-a',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        active_contacts: '50',
        inbound_messages: '90',
        outbound_messages: '251',
        outbound_text_messages: '200',
        outbound_image_messages: '30',
        outbound_video_messages: '10',
        outbound_interactive_messages: '11',
        contact_limit: 50,
        outbound_message_limit: 250,
        contact_overage: '0',
        outbound_message_overage: '1',
        includes_history_estimate: true,
      }],
      error: null,
    })

    const result = await usage.getAdminMonthlyUsage('2026-07-01')

    expect(result).toEqual([expect.objectContaining({
      active_contacts: 50,
      outbound_messages: 251,
      outbound_message_overage: 1,
      includes_history_estimate: true,
    })])
    expect(db.rpc).toHaveBeenCalledWith('get_admin_monthly_usage', {
      p_month: '2026-07-01',
    })
  })
})

import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createWebhookEventsRepository } = require(
  '../dist/db/repositories/webhook-events',
)

const ok = data => ({ data, error: null })

function fakeClient(results = []) {
  const rpc = vi.fn(async () => results.shift() ?? ok(true))
  return { rpc }
}

const hash = value => crypto.createHash('sha256').update(value).digest('hex')

describe('repositorio del inbox durable de webhooks', () => {
  it('hashea el messageId y la conversación antes de encolar el payload', async () => {
    const client = fakeClient([ok(true)])
    const repository = createWebhookEventsRepository(client)
    const payload = { message: { id: 'wamid-visible' } }

    await expect(repository.enqueueWebhookEvent(
      'business-a',
      'meta',
      'wamid-visible',
      '+593999111222',
      payload,
    )).resolves.toEqual(ok(true))

    expect(client.rpc).toHaveBeenCalledWith('enqueue_webhook_event', {
      p_business_id: 'business-a',
      p_provider: 'meta',
      p_message_id_hash: hash('wamid-visible'),
      p_stream_key_hash: hash('+593999111222'),
      p_payload: payload,
    })
    const rpcParameters = client.rpc.mock.calls[0][1]
    expect(rpcParameters.p_message_id_hash).not.toBe('wamid-visible')
    expect(rpcParameters.p_stream_key_hash).not.toBe('+593999111222')
  })

  it('conserva claim_webhook_event con el identificador hasheado', async () => {
    const client = fakeClient([ok(false)])
    const repository = createWebhookEventsRepository(client)

    await expect(repository.claimWebhookEvent(
      'business-b',
      'ycloud',
      'evt-duplicate',
    )).resolves.toEqual(ok(false))
    expect(client.rpc).toHaveBeenCalledWith('claim_webhook_event', {
      p_business_id: 'business-b',
      p_provider: 'ycloud',
      p_message_id_hash: hash('evt-duplicate'),
    })
  })

  it('mapea lease y heartbeat a los parámetros exactos de PostgreSQL', async () => {
    const leases = [{ id: 'event-a' }]
    const client = fakeClient([ok(leases), ok(true)])
    const repository = createWebhookEventsRepository(client)

    await expect(repository.leaseWebhookEvents('worker-a', 12, 180))
      .resolves.toEqual(ok(leases))
    await expect(repository.renewWebhookEventLease('event-a', 'lease-a', 180))
      .resolves.toEqual(ok(true))

    expect(client.rpc.mock.calls).toEqual([
      ['lease_webhook_events', {
        p_worker_id: 'worker-a',
        p_limit: 12,
        p_lease_seconds: 180,
      }],
      ['renew_webhook_event_lease', {
        p_event_id: 'event-a',
        p_lease_token: 'lease-a',
        p_lease_seconds: 180,
      }],
    ])
  })

  it('mapea complete, fail y cleanup sin perder sus resultados tipados', async () => {
    const client = fakeClient([ok(true), ok('dead'), ok(41)])
    const repository = createWebhookEventsRepository(client)

    await expect(repository.completeWebhookEvent('event-b', 'lease-b'))
      .resolves.toEqual(ok(true))
    await expect(repository.failWebhookEvent(
      'event-b',
      'lease-b',
      'falló el proveedor',
      15,
    )).resolves.toEqual(ok('dead'))
    await expect(repository.cleanupWebhookEvents()).resolves.toEqual(ok(41))

    expect(client.rpc.mock.calls).toEqual([
      ['complete_webhook_event', {
        p_event_id: 'event-b',
        p_lease_token: 'lease-b',
      }],
      ['fail_webhook_event', {
        p_event_id: 'event-b',
        p_lease_token: 'lease-b',
        p_error: 'falló el proveedor',
        p_base_delay_seconds: 15,
      }],
      ['cleanup_webhook_events', undefined],
    ])
  })

  it('devuelve errores RPC al llamador sin convertirlos en éxitos', async () => {
    const failure = {
      data: null,
      error: { message: 'base no disponible', code: '08006' },
    }
    const client = fakeClient([failure])
    const repository = createWebhookEventsRepository(client)

    await expect(repository.cleanupWebhookEvents()).resolves.toEqual(failure)
  })
})

import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createWhatsAppFlowsRepository } = require(
  '../dist/db/repositories/whatsapp-flows',
)
const { createDeliveryDispatchRepository } = require(
  '../dist/db/repositories/delivery-dispatch',
)

const ok = data => ({ data, error: null })
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function fakeClient(results = []) {
  return {
    rpc: vi.fn(async () => results.shift() ?? ok(true)),
  }
}

function fakeCatalogClient(result = ok([])) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    or: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return {
    client: {
      from: vi.fn(() => query),
      rpc: vi.fn(),
    },
    query,
  }
}

describe('persistencia segura de WhatsApp Flows', () => {
  it('trata la RPC de readiness ausente como esquema no preparado', async () => {
    const missing = {
      data: null,
      error: {
        code: 'PGRST202',
        message:
          'Could not find public.whatsapp_flow_capabilities_schema_ready',
      },
    }
    const client = fakeClient([missing, ok(true)])
    const repository = createWhatsAppFlowsRepository(client)

    await expect(repository.isWhatsAppFlowCapabilitiesSchemaReady())
      .resolves.toBe(false)
    await expect(repository.isWhatsAppFlowCapabilitiesSchemaReady())
      .resolves.toBe(true)
    expect(client.rpc).toHaveBeenNthCalledWith(
      1,
      'whatsapp_flow_capabilities_schema_ready',
    )
  })

  it('adquiere, renueva y libera el lease con el mismo owner token', async () => {
    const client = fakeClient([ok(true), ok(true), ok(true)])
    const repository = createWhatsAppFlowsRepository(client)
    const ownerToken = '20000000-0000-4000-8000-000000000002'

    await expect(repository.acquireFlowProvisioningLease({
      businessId: 'business-lease',
      templateKey: 'order_standard',
      ownerToken,
      leaseSeconds: 600,
    })).resolves.toBe(true)
    await expect(repository.renewFlowProvisioningLease({
      businessId: 'business-lease',
      templateKey: 'order_standard',
      ownerToken,
      leaseSeconds: 600,
    })).resolves.toBe(true)
    await expect(repository.releaseFlowProvisioningLease({
      businessId: 'business-lease',
      templateKey: 'order_standard',
      ownerToken,
    })).resolves.toBe(true)

    expect(client.rpc.mock.calls).toEqual([
      ['acquire_whatsapp_flow_provisioning_lease', {
        p_business_id: 'business-lease',
        p_template_key: 'order_standard',
        p_owner_token: ownerToken,
        p_lease_seconds: 600,
      }],
      ['renew_whatsapp_flow_provisioning_lease', {
        p_business_id: 'business-lease',
        p_template_key: 'order_standard',
        p_owner_token: ownerToken,
        p_lease_seconds: 600,
      }],
      ['release_whatsapp_flow_provisioning_lease', {
        p_business_id: 'business-lease',
        p_template_key: 'order_standard',
        p_owner_token: ownerToken,
      }],
    ])
  })

  it('consulta productos del Flow con proyección ligera y fila centinela', async () => {
    const { client, query } = fakeCatalogClient(ok([{ id: 'product-a' }]))
    const repository = createWhatsAppFlowsRepository(client)

    await expect(repository.getFlowCatalogProducts('business-a'))
      .resolves.toEqual([{ id: 'product-a' }])

    expect(client.from).toHaveBeenCalledWith('products')
    expect(query.select).toHaveBeenCalledWith(
      'id, business_id, name, price, price_sale, stock, tags, active',
    )
    expect(query.select.mock.calls[0][0]).not.toContain('*')
    expect(query.select.mock.calls[0][0]).not.toContain('embedding')
    expect(query.eq).toHaveBeenCalledWith('business_id', 'business-a')
    expect(query.eq).toHaveBeenCalledWith('active', true)
    expect(query.or).toHaveBeenCalledWith('stock.is.null,stock.neq.agotado')
    expect(query.limit).toHaveBeenCalledWith(201)
  })

  it('consulta modificadores del Flow sin columnas ajenas y con fila centinela', async () => {
    const { client, query } = fakeCatalogClient(ok([{ id: 'modifier-a' }]))
    const repository = createWhatsAppFlowsRepository(client)

    await expect(repository.getFlowCatalogModifiers('business-a'))
      .resolves.toEqual([{ id: 'modifier-a' }])

    expect(client.from).toHaveBeenCalledWith('menu_modifiers')
    expect(query.select).toHaveBeenCalledWith(
      'id, business_id, category_tag, group_label, name, active',
    )
    expect(query.select.mock.calls[0][0]).not.toContain('*')
    expect(query.eq).toHaveBeenCalledWith('business_id', 'business-a')
    expect(query.eq).toHaveBeenCalledWith('active', true)
    expect(query.limit).toHaveBeenCalledWith(201)
  })

  it('genera el token fuera de la base y persiste únicamente hashes', async () => {
    const session = {
      id: 'session-a',
      business_id: 'business-a',
      provider: 'ycloud',
      flow_version_id: 'version-a',
      status: 'open',
      context: {},
      context_revision: 0,
      expires_at: '2026-07-29T12:00:00.000Z',
    }
    const client = fakeClient([ok(session)])
    const repository = createWhatsAppFlowsRepository(client)

    const result = await repository.createFlowSession({
      businessId: 'business-a',
      provider: 'ycloud',
      flowVersionId: 'version-a',
      contact: '+593991112222',
      expiresAt: session.expires_at,
      context: { cart: [] },
      providerMessageId: 'wamid-visible',
    })

    expect(result.flowToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(result.session).toEqual(session)
    const parameters = client.rpc.mock.calls[0][1]
    expect(client.rpc).toHaveBeenCalledWith(
      'create_whatsapp_flow_session',
      expect.any(Object),
    )
    expect(parameters.p_session_token_hash).toBe(hash(result.flowToken))
    expect(parameters.p_contact_key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(parameters.p_provider_message_id_hash).toBe(hash('wamid-visible'))
    expect(JSON.stringify(parameters)).not.toContain('+593991112222')
    expect(JSON.stringify(parameters)).not.toContain('wamid-visible')
    expect(JSON.stringify(parameters)).not.toContain(result.flowToken)
  })

  it('resuelve y actualiza contexto por CAS sin enviar el token crudo', async () => {
    const resolved = {
      id: 'session-b',
      business_id: 'business-b',
      provider: 'meta',
      flow_version_id: 'version-b',
      status: 'open',
      context: { screen: 'PRODUCTS' },
      context_revision: 3,
      expires_at: '2026-07-29T12:00:00.000Z',
      flow: {
        id: 'flow-b',
        flow_key: 'generic_order',
        capability_key: 'order',
        version: 1,
      },
    }
    const updated = {
      result: 'updated',
      session: { ...resolved, context_revision: 4 },
    }
    const client = fakeClient([ok(resolved), ok(updated)])
    const repository = createWhatsAppFlowsRepository(client)
    const token = 'super-secret-flow-token'

    await expect(repository.getFlowSessionByToken('meta', token))
      .resolves.toEqual(resolved)
    await expect(repository.updateFlowSessionContext(
      'business-b',
      'meta',
      token,
      3,
      { screen: 'SUMMARY' },
    )).resolves.toEqual(updated)

    expect(client.rpc.mock.calls).toEqual([
      ['resolve_whatsapp_flow_session', {
        p_provider: 'meta',
        p_session_token_hash: hash(token),
      }],
      ['update_whatsapp_flow_session_context', {
        p_business_id: 'business-b',
        p_provider: 'meta',
        p_session_token_hash: hash(token),
        p_expected_revision: 3,
        p_context: { screen: 'SUMMARY' },
      }],
    ])
    expect(JSON.stringify(client.rpc.mock.calls)).not.toContain(token)
  })

  it('deduplica submissions usando hashes del token y del evento externo', async () => {
    const persisted = {
      created: false,
      submission: { id: 'submission-original' },
    }
    const client = fakeClient([ok(persisted)])
    const repository = createWhatsAppFlowsRepository(client)

    await expect(repository.recordFlowSubmission({
      businessId: 'business-c',
      provider: 'ycloud',
      flowToken: 'flow-token-c',
      contact: '593991112222',
      submissionKey: 'nfm-reply-c',
      payload: { products: [{ id: 'pizza-1', quantity: 2 }] },
    })).resolves.toEqual(persisted)

    expect(client.rpc).toHaveBeenCalledWith(
      'record_whatsapp_flow_submission',
      {
        p_business_id: 'business-c',
        p_provider: 'ycloud',
        p_session_token_hash: hash('flow-token-c'),
        p_contact_key_hash: hash(
          'ycloud:business-c:593991112222',
        ),
        p_submission_key_hash: hash('nfm-reply-c'),
        p_payload: { products: [{ id: 'pizza-1', quantity: 2 }] },
      },
    )
    expect(JSON.stringify(client.rpc.mock.calls)).not.toContain('flow-token-c')
    expect(JSON.stringify(client.rpc.mock.calls)).not.toContain('nfm-reply-c')
  })

  it('solo envía IDs y cantidades a la RPC autoritativa de pedidos', async () => {
    const result = {
      created: true,
      order: { id: 'order-a', total: 21.5 },
    }
    const client = fakeClient([ok(result)])
    const repository = createWhatsAppFlowsRepository(client)

    await expect(repository.createOrderFromFlowSubmission({
      businessId: 'business-order',
      submissionId: 'submission-order',
      contactPhone: '593991112222',
      items: [{
        productId: 'product-a',
        quantity: 2,
        modifierIds: ['modifier-a'],
        note: 'Sin cebolla',
      }],
      fulfillmentType: 'delivery',
      deliveryAddress: 'Calle 1',
      deliveryFee: 1.5,
    })).resolves.toEqual(result)

    const parameters = client.rpc.mock.calls[0][1]
    expect(client.rpc.mock.calls[0][0])
      .toBe('create_order_from_flow_submission')
    expect(parameters.p_items).toEqual([{
      product_id: 'product-a',
      quantity: 2,
      modifier_ids: ['modifier-a'],
      note: 'Sin cebolla',
    }])
    expect(parameters.p_items[0]).not.toHaveProperty('unit_price')
    expect(parameters.p_items[0]).not.toHaveProperty('product_name')
    expect(parameters).not.toHaveProperty('p_total')
  })
})

describe('persistencia segura del despacho retenido', () => {
  it('muta el outbox solo mediante RPCs acotadas al negocio', async () => {
    const held = {
      id: 'dispatch-a',
      business_id: 'business-a',
      order_id: 'order-a',
      event_type: 'order.confirmed',
      status: 'held',
      payload: { schema_version: 1 },
    }
    const cancelled = {
      ...held,
      status: 'cancelled',
    }
    const results = [
      ok({ result: 'held', dispatch: held }),
      ok(held),
      ok(cancelled),
    ]
    const client = {
      rpc: vi.fn(async () => results.shift()),
      from: vi.fn(),
    }
    const repository = createDeliveryDispatchRepository(client)

    await expect(repository.ensureHeldOrderDispatch('business-a', 'order-a'))
      .resolves.toEqual({ result: 'held', dispatch: held })
    await expect(repository.assignDispatchRecipient(
      'business-a',
      'dispatch-a',
      'recipient-a',
    )).resolves.toEqual(held)
    await expect(repository.cancelHeldDispatch('business-a', 'dispatch-a'))
      .resolves.toEqual(cancelled)

    expect(client.rpc.mock.calls).toEqual([
      ['ensure_order_delivery_dispatch', {
        p_business_id: 'business-a',
        p_order_id: 'order-a',
      }],
      ['assign_delivery_dispatch_recipient', {
        p_business_id: 'business-a',
        p_dispatch_id: 'dispatch-a',
        p_recipient_id: 'recipient-a',
      }],
      ['cancel_held_delivery_dispatch', {
        p_business_id: 'business-a',
        p_dispatch_id: 'dispatch-a',
      }],
    ])
    expect(client.from).not.toHaveBeenCalled()
  })
})

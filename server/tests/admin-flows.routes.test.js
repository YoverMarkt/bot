import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const router = require('../dist/routes/admin-flows.routes')
const db = require('../dist/db')
const axios = require('axios')
const ycloud = require('../dist/integrations/ycloud')

const JWT_SECRET = 'admin-flows-test-secret'
const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const DEFINITION_ID = '10000000-0000-4000-8000-000000000002'
const VERSION_ID = '10000000-0000-4000-8000-000000000003'
const ACTIVE_VERSION_ID = '10000000-0000-4000-8000-000000000004'
const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  BASE_URL: process.env.BASE_URL,
  YCLOUD_API_KEY: process.env.YCLOUD_API_KEY,
}

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, businessId: BUSINESS_ID }, JWT_SECRET)}`
}

async function dispatch(path, method, {
  auth,
  body = {},
  params = {},
} = {}) {
  const layer = router.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta ${method.toUpperCase()} ${path} no encontrada`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = {
    headers: auth ? { authorization: auth } : {},
    body,
    params,
  }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, (error) => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

function business(overrides = {}) {
  return {
    id: BUSINESS_ID,
    name: 'Monster Pizza',
    type: 'pizzeria',
    slug: 'monster-pizza',
    whatsapp_provider: 'ycloud',
    whatsapp_number: '+593999000001',
    ycloud_number: '+593999000001',
    ycloud_api_key: 'ycloud-test-secret',
    takes_orders: true,
    takes_bookings: false,
    lodging_enabled: false,
    ...overrides,
  }
}

function definition(overrides = {}) {
  return {
    id: DEFINITION_ID,
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    waba_id: 'waba-1',
    flow_key: 'order_standard',
    capability_key: 'order',
    display_name: 'Pedido',
    description: 'Pedido estructurado',
    configuration: {},
    enabled: false,
    whatsapp_flow_versions: [{
      id: VERSION_ID,
      flow_id: DEFINITION_ID,
      business_id: BUSINESS_ID,
      provider: 'ycloud',
      waba_id: 'waba-1',
      version: 1,
      provider_flow_id: 'remote-flow-1',
      status: 'draft',
      is_active: false,
      flow_json: {},
      updated_at: '2026-07-28T12:00:00.000Z',
    }],
    ...overrides,
  }
}

function mockProvisioning(currentBusiness = business()) {
  vi.spyOn(db, 'getBusinessById').mockResolvedValue(currentBusiness)
  vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([])
  vi.spyOn(axios, 'get').mockResolvedValue({
    data: {
      items: [{ phoneNumber: '+593999000001', wabaId: 'waba-1' }],
    },
  })
  vi.spyOn(db, 'upsertFlowDefinition').mockResolvedValue(definition())
  vi.spyOn(db, 'createFlowVersion').mockResolvedValue(
    definition().whatsapp_flow_versions[0],
  )
  const update = vi.spyOn(db, 'updateFlowVersionState')
    .mockImplementation(async input => ({
      ...definition().whatsapp_flow_versions[0],
      status: input.status,
      provider_flow_id: input.providerFlowId || null,
      validation_errors: input.validationErrors || [],
    }))
  vi.spyOn(ycloud, 'createFlow').mockResolvedValue({
    id: 'remote-flow-1',
    success: true,
  })
  return { update }
}

function providerNotFound() {
  const error = new Error('not found')
  error.isAxiosError = true
  error.response = { status: 404, data: {} }
  return error
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
  process.env.BASE_URL = 'https://bot.example.com'
  delete process.env.YCLOUD_API_KEY
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('administración de WhatsApp Flows', () => {
  it('protege todos los endpoints para superadmin', async () => {
    expect((await dispatch('/api/admin/flows', 'get')).status).toBe(401)
    expect((await dispatch('/api/admin/flows', 'get', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('expone registro genérico y capacidades persistidas por negocio', async () => {
    vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([{ id: BUSINESS_ID }])
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([definition()])

    const response = await dispatch('/api/admin/flows', 'get', {
      auth: authorization(),
    })

    expect(response.status).toBe(200)
    expect(response.body.templates.map(item => item.capability)).toEqual([
      'order',
      'appointment',
      'lodging',
      'lead',
    ])
    expect(response.body.businesses[0]).toEqual(expect.objectContaining({
      id: BUSINESS_ID,
      provider: 'ycloud',
      wabaId: 'waba-1',
      recommendedCapabilities: ['order'],
    }))
    expect(response.body.businesses[0].definitions[0]).toEqual(
      expect.objectContaining({
        id: DEFINITION_ID,
        templateKey: 'order_standard',
        status: 'draft',
        versionId: VERSION_ID,
        providerFlowId: 'remote-flow-1',
        isActive: false,
        activeVersion: null,
      }),
    )
    expect(JSON.stringify(response.body)).not.toContain('ycloud-test-secret')
  })

  it('distingue en el GET la versión candidata de la versión activa', async () => {
    const current = {
      ...definition().whatsapp_flow_versions[0],
      id: ACTIVE_VERSION_ID,
      provider_flow_id: 'remote-flow-1',
      status: 'published',
      is_active: true,
      version: 1,
    }
    const candidate = {
      ...definition().whatsapp_flow_versions[0],
      id: VERSION_ID,
      provider_flow_id: 'remote-flow-2',
      status: 'published',
      is_active: false,
      version: 2,
    }
    vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([{ id: BUSINESS_ID }])
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([
      definition({
        enabled: true,
        whatsapp_flow_versions: [candidate, current],
      }),
    ])

    const response = await dispatch('/api/admin/flows', 'get', {
      auth: authorization(),
    })

    expect(response.status).toBe(200)
    expect(response.body.businesses[0].definitions[0]).toEqual(
      expect.objectContaining({
        versionId: VERSION_ID,
        providerFlowId: 'remote-flow-2',
        version: 2,
        isActive: false,
        activeVersion: 1,
      }),
    )
  })

  it('crea únicamente un borrador YCloud y nunca lo publica implícitamente', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([])
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{
          phoneNumber: '+593999000001',
          wabaId: 'waba-1',
        }],
      },
    })
    vi.spyOn(db, 'upsertFlowDefinition').mockResolvedValue(definition())
    vi.spyOn(db, 'createFlowVersion').mockResolvedValue(
      definition().whatsapp_flow_versions[0],
    )
    vi.spyOn(db, 'updateFlowVersionState').mockImplementation(async input => ({
      ...definition().whatsapp_flow_versions[0],
      status: input.status,
      provider_flow_id: input.providerFlowId || null,
    }))
    const createFlow = vi.spyOn(ycloud, 'createFlow').mockResolvedValue({
      id: 'remote-flow-1',
      success: true,
    })
    vi.spyOn(ycloud, 'retrieveFlow').mockResolvedValue({
      id: 'remote-flow-1',
      status: 'DRAFT',
      validationErrors: [],
    })
    const publishFlow = vi.spyOn(ycloud, 'publishFlow')

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response).toEqual({
      status: 201,
      body: expect.objectContaining({
        ok: true,
        status: 'draft',
        providerFlowId: 'remote-flow-1',
      }),
    })
    expect(createFlow).toHaveBeenCalledWith(
      'ycloud-test-secret',
      expect.objectContaining({
        wabaId: 'waba-1',
        publish: false,
        endpointUri: 'https://bot.example.com/webhook/ycloud/flows/data-exchange',
      }),
    )
    expect(db.updateFlowVersionState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'provisioning',
        providerFlowId: 'remote-flow-1',
      }),
    )
    expect(publishFlow).not.toHaveBeenCalled()
  })

  it('reintenta un 404 breve y solo acepta el borrador remoto exacto', async () => {
    mockProvisioning()
    const retrieve = vi.spyOn(ycloud, 'retrieveFlow')
      .mockRejectedValueOnce(providerNotFound())
      .mockResolvedValue({
        id: 'remote-flow-1',
        status: 'DRAFT',
        validationErrors: [],
      })

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      ok: true,
      status: 'draft',
      validationErrors: [],
    })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('marca blocked y responde error si YCloud devuelve errores de validación', async () => {
    const { update } = mockProvisioning()
    vi.spyOn(ycloud, 'retrieveFlow').mockResolvedValue({
      id: 'remote-flow-1',
      status: 'DRAFT',
      validationErrors: [{ message: 'Componente inválido' }],
    })

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      error: 'Componente inválido',
      ok: false,
      status: 'blocked',
    })
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'blocked',
      validationErrors: [{ message: 'Componente inválido' }],
    }))
  })

  it.each([
    ['estado publicado', async () => ({
      id: 'remote-flow-1',
      status: 'PUBLISHED',
      validationErrors: [],
    })],
    ['ID remoto distinto', async () => ({
      id: 'remote-flow-other',
      status: 'DRAFT',
      validationErrors: [],
    })],
    ['Flow remoto ausente', async () => {
      throw providerNotFound()
    }],
  ])('marca failed cuando YCloud devuelve %s', async (_case, retrieveResult) => {
    const { update } = mockProvisioning()
    vi.spyOn(ycloud, 'retrieveFlow').mockImplementation(retrieveResult)

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(409)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'failed',
      providerFlowId: 'remote-flow-1',
    }))
  })

  it('rechaza una plantilla si el negocio no tiene esa capacidad', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business({
      type: 'hostal',
      takes_orders: false,
      lodging_enabled: true,
    }))
    const create = vi.spyOn(ycloud, 'createFlow')

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/capacidad requerida/)
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['inactivo', { active: false }],
    ['suspendido', { suspended: true }],
  ])('rechaza un negocio %s antes de tocar YCloud', async (_state, state) => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business(state))
    const create = vi.spyOn(ycloud, 'createFlow')

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(409)
    expect(create).not.toHaveBeenCalled()
  })

  it('publica solo con la acción explícita y activa esa versión', async () => {
    const draft = definition()
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([draft])
    vi.spyOn(ycloud, 'listFlows').mockResolvedValue({
      items: [{ id: 'remote-flow-1', status: 'DRAFT', validationErrors: [] }],
    })
    const publishFlow = vi.spyOn(ycloud, 'publishFlow')
      .mockResolvedValue({ success: true })
    vi.spyOn(db, 'updateFlowVersionState').mockResolvedValue({
      ...draft.whatsapp_flow_versions[0],
      status: 'published',
    })
    const activate = vi.spyOn(db, 'activateFlowVersion').mockResolvedValue({
      ...draft.whatsapp_flow_versions[0],
      status: 'published',
      is_active: true,
    })

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/publish',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
      },
    )

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'published',
        isActive: true,
        activationRequired: false,
      },
    })
    expect(publishFlow).toHaveBeenCalledWith(
      'ycloud-test-secret',
      'remote-flow-1',
    )
    expect(activate).toHaveBeenCalledWith(BUSINESS_ID, VERSION_ID)
  })

  it('publica un reemplazo sin desplazar la versión que ya está activa', async () => {
    const current = {
      ...definition().whatsapp_flow_versions[0],
      id: ACTIVE_VERSION_ID,
      provider_flow_id: 'remote-flow-1',
      status: 'published',
      is_active: true,
      version: 1,
    }
    const candidate = {
      ...definition().whatsapp_flow_versions[0],
      id: VERSION_ID,
      provider_flow_id: 'remote-flow-2',
      status: 'draft',
      is_active: false,
      version: 2,
    }
    const replacement = definition({
      enabled: true,
      whatsapp_flow_versions: [candidate, current],
    })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([replacement])
    vi.spyOn(ycloud, 'listFlows').mockResolvedValue({
      items: [{ id: 'remote-flow-2', status: 'DRAFT', validationErrors: [] }],
    })
    vi.spyOn(ycloud, 'publishFlow').mockResolvedValue({ success: true })
    vi.spyOn(db, 'updateFlowVersionState').mockResolvedValue({
      ...candidate,
      status: 'published',
    })
    const activate = vi.spyOn(db, 'activateFlowVersion')

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/publish',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
      },
    )

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'published',
        isActive: false,
        activationRequired: true,
      },
    })
    expect(activate).not.toHaveBeenCalled()
  })

  it('reconcilia una publicación remota si el guardado local falló antes', async () => {
    const draft = definition()
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([draft])
    vi.spyOn(ycloud, 'listFlows').mockResolvedValue({
      items: [{
        id: 'remote-flow-1',
        status: 'PUBLISHED',
        validationErrors: [],
      }],
    })
    const publishFlow = vi.spyOn(ycloud, 'publishFlow')
    vi.spyOn(db, 'updateFlowVersionState').mockResolvedValue({
      ...draft.whatsapp_flow_versions[0],
      status: 'published',
    })
    vi.spyOn(db, 'activateFlowVersion').mockResolvedValue({
      ...draft.whatsapp_flow_versions[0],
      status: 'published',
      is_active: true,
    })

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/publish',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
      },
    )

    expect(response.status).toBe(200)
    expect(publishFlow).not.toHaveBeenCalled()
    expect(db.updateFlowVersionState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published' }),
    )
  })

  it('reactiva una versión ya publicada cuando el intento anterior quedó incompleto', async () => {
    const published = definition({
      whatsapp_flow_versions: [{
        ...definition().whatsapp_flow_versions[0],
        status: 'published',
        is_active: false,
      }],
    })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([published])
    const activate = vi.spyOn(db, 'activateFlowVersion').mockResolvedValue({
      ...published.whatsapp_flow_versions[0],
      is_active: true,
    })
    const listRemote = vi.spyOn(ycloud, 'listFlows')
    const publishRemote = vi.spyOn(ycloud, 'publishFlow')

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/publish',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
      },
    )

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'published',
        idempotent: true,
        isActive: true,
        activationRequired: false,
      },
    })
    expect(activate).toHaveBeenCalledWith(BUSINESS_ID, VERSION_ID)
    expect(listRemote).not.toHaveBeenCalled()
    expect(publishRemote).not.toHaveBeenCalled()
  })

  it('mantiene idempotente una candidata publicada sin activarla por repetición', async () => {
    const current = {
      ...definition().whatsapp_flow_versions[0],
      id: ACTIVE_VERSION_ID,
      provider_flow_id: 'remote-flow-1',
      status: 'published',
      is_active: true,
      version: 1,
    }
    const candidate = {
      ...definition().whatsapp_flow_versions[0],
      id: VERSION_ID,
      provider_flow_id: 'remote-flow-2',
      status: 'published',
      is_active: false,
      version: 2,
    }
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([
      definition({
        enabled: true,
        whatsapp_flow_versions: [candidate, current],
      }),
    ])
    const activate = vi.spyOn(db, 'activateFlowVersion')
    const listRemote = vi.spyOn(ycloud, 'listFlows')
    const publishRemote = vi.spyOn(ycloud, 'publishFlow')

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/publish',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
      },
    )

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'published',
        idempotent: true,
        isActive: false,
        activationRequired: true,
      },
    })
    expect(activate).not.toHaveBeenCalled()
    expect(listRemote).not.toHaveBeenCalled()
    expect(publishRemote).not.toHaveBeenCalled()
  })

  it('activa explícitamente una versión publicada concreta', async () => {
    const current = {
      ...definition().whatsapp_flow_versions[0],
      id: ACTIVE_VERSION_ID,
      provider_flow_id: 'remote-flow-1',
      status: 'published',
      is_active: true,
      version: 1,
    }
    const candidate = {
      ...definition().whatsapp_flow_versions[0],
      id: VERSION_ID,
      provider_flow_id: 'remote-flow-2',
      status: 'published',
      is_active: false,
      version: 2,
    }
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([
      definition({
        enabled: true,
        whatsapp_flow_versions: [candidate, current],
      }),
    ])
    const activate = vi.spyOn(db, 'activateFlowVersion').mockResolvedValue({
      ...candidate,
      is_active: true,
    })

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/activate',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
        body: { versionId: VERSION_ID },
      },
    )

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        status: 'published',
        isActive: true,
        activeVersion: 2,
      },
    })
    expect(activate).toHaveBeenCalledWith(BUSINESS_ID, VERSION_ID)
  })

  it('no activa un borrador ni una versión ajena a la definición', async () => {
    const draft = definition()
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([draft])
    const activate = vi.spyOn(db, 'activateFlowVersion')

    const draftResponse = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/activate',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
        body: { versionId: VERSION_ID },
      },
    )
    const foreignResponse = await dispatch(
      '/api/admin/flows/:businessId/:definitionId/activate',
      'post',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
        body: { versionId: ACTIVE_VERSION_ID },
      },
    )

    expect(draftResponse.status).toBe(409)
    expect(foreignResponse.status).toBe(404)
    expect(activate).not.toHaveBeenCalled()
  })

  it('no habilita una definición publicada que todavía no esté activa', async () => {
    const publishedButInactive = definition({
      whatsapp_flow_versions: [{
        ...definition().whatsapp_flow_versions[0],
        status: 'published',
        is_active: false,
      }],
    })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([publishedButInactive])
    const upsert = vi.spyOn(db, 'upsertFlowDefinition')

    const response = await dispatch(
      '/api/admin/flows/:businessId/:definitionId',
      'patch',
      {
        auth: authorization(),
        params: {
          businessId: BUSINESS_ID,
          definitionId: DEFINITION_ID,
        },
        body: { enabled: true },
      },
    )

    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/publicada y activa/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('no apaga una versión activa mientras prepara su reemplazo', async () => {
    const current = definition({ enabled: true })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{
          phoneNumber: '+593999000001',
          wabaId: 'waba-1',
        }],
      },
    })
    vi.spyOn(db, 'listFlowDefinitions').mockResolvedValue([current])
    const upsert = vi.spyOn(db, 'upsertFlowDefinition')
      .mockResolvedValue(current)
    vi.spyOn(db, 'createFlowVersion').mockResolvedValue({
      ...current.whatsapp_flow_versions[0],
      id: '10000000-0000-4000-8000-000000000099',
      version: 2,
      provider_flow_id: null,
      status: 'draft',
    })
    vi.spyOn(db, 'updateFlowVersionState').mockImplementation(async input => ({
      ...current.whatsapp_flow_versions[0],
      id: '10000000-0000-4000-8000-000000000099',
      version: 2,
      status: input.status,
      provider_flow_id: input.providerFlowId || null,
    }))
    vi.spyOn(ycloud, 'createFlow').mockResolvedValue({
      id: 'remote-flow-2',
      success: true,
    })
    vi.spyOn(ycloud, 'retrieveFlow').mockResolvedValue({
      id: 'remote-flow-2',
      status: 'DRAFT',
      validationErrors: [],
    })

    await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: DEFINITION_ID,
      enabled: true,
    }))
  })

  it('no filtra la API Key aunque el proveedor la incluya en un error', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(business())
    const error = new Error('Request failed')
    error.isAxiosError = true
    error.response = {
      status: 401,
      data: { message: 'La credencial ycloud-test-secret es inválida' },
    }
    vi.spyOn(axios, 'get').mockRejectedValue(error)

    const response = await dispatch(
      '/api/admin/flows/:businessId/provision',
      'post',
      {
        auth: authorization(),
        params: { businessId: BUSINESS_ID },
        body: { templateKey: 'order_standard' },
      },
    )

    expect(response.status).toBe(409)
    expect(response.body.error).toContain('••••••')
    expect(JSON.stringify(response.body)).not.toContain('ycloud-test-secret')
  })
})

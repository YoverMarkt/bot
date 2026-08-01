import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  createWhatsAppFlowProvisioner,
  listYCloudPhoneNumbersPaginated,
  pingFlowDataExchangeEndpoint,
} = require('../dist/services/whatsapp-flow-provisioner')
const axios = require('axios')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'

function business(overrides = {}) {
  return {
    id: BUSINESS_ID,
    name: 'Monster Pizza',
    slug: 'monster-pizza',
    whatsapp_provider: 'ycloud',
    whatsapp_number: '+593999000001',
    ycloud_number: '+593999000001',
    ycloud_api_key: 'ycloud-private-key',
    ycloud_webhook_secret: 'webhook-private-secret',
    takes_orders: true,
    takes_bookings: false,
    lodging_enabled: false,
    active: true,
    suspended: false,
    ...overrides,
  }
}

function createHarness(options = {}) {
  let currentBusiness = business(options.business)
  let draftValidationErrors = options.draftValidationErrors || []
  let definitionCounter = 0
  let versionCounter = 0
  let remoteCounter = 0
  let leaseOwner = null
  const definitions = []
  const remote = new Map()
  const events = []
  const activationSnapshots = []

  const dependencies = {
    getBusinessById: vi.fn(async () => currentBusiness),
    listFlowDefinitions: vi.fn(async () => definitions.map(definition => ({
      ...definition,
      configuration: { ...definition.configuration },
      whatsapp_flow_versions: definition.whatsapp_flow_versions.map(
        version => ({ ...version }),
      ),
    }))),
    upsertFlowDefinition: vi.fn(async (input) => {
      events.push(`definition:${input.flowKey}:${input.enabled}`)
      let definition = input.id
        ? definitions.find(candidate => candidate.id === input.id)
        : definitions.find(candidate => (
            candidate.business_id === input.businessId
            && candidate.provider === input.provider
            && candidate.waba_id === input.wabaId
            && candidate.flow_key === input.flowKey
          ))
      if (!definition) {
        definitionCounter += 1
        definition = {
          id: `definition-${definitionCounter}`,
          business_id: input.businessId,
          provider: input.provider,
          waba_id: input.wabaId,
          flow_key: input.flowKey,
          capability_key: input.capabilityKey,
          display_name: input.displayName,
          description: input.description,
          configuration: input.configuration || {},
          enabled: input.enabled === true,
          whatsapp_flow_versions: [],
        }
        definitions.push(definition)
      } else {
        definition.capability_key = input.capabilityKey
        definition.display_name = input.displayName
        definition.description = input.description
        definition.configuration = input.configuration || {}
        if (input.enabled !== undefined) definition.enabled = input.enabled
      }
      return { ...definition }
    }),
    createFlowVersion: vi.fn(async (input) => {
      events.push('create_version')
      const definition = definitions.find(candidate => candidate.id === input.flowId)
      if (!definition) throw new Error('definition missing')
      versionCounter += 1
      const version = {
        id: `version-${versionCounter}`,
        flow_id: definition.id,
        business_id: input.businessId,
        provider: definition.provider,
        waba_id: definition.waba_id,
        version: versionCounter,
        provider_flow_id: null,
        status: 'draft',
        is_active: false,
        flow_json: input.flowJson,
        provider_version: input.providerVersion,
        data_api_version: input.dataApiVersion,
        data_exchange_endpoint_path: input.dataExchangeEndpointPath,
        validation_errors: [],
      }
      definition.whatsapp_flow_versions.push(version)
      return { ...version }
    }),
    updateFlowVersionState: vi.fn(async (input) => {
      events.push(`local:${input.status}`)
      const version = definitions
        .flatMap(definition => definition.whatsapp_flow_versions)
        .find(candidate => candidate.id === input.flowVersionId)
      if (!version) throw new Error('version missing')
      version.status = input.status
      if (input.providerFlowId !== undefined) {
        version.provider_flow_id = input.providerFlowId
      }
      if (input.validationErrors !== undefined) {
        version.validation_errors = input.validationErrors
      }
      return { ...version }
    }),
    activateFlowVersion: vi.fn(async (_businessId, flowVersionId) => {
      events.push('activate')
      const definition = definitions.find(candidate => (
        candidate.whatsapp_flow_versions.some(version => (
          version.id === flowVersionId
        ))
      ))
      const version = definition?.whatsapp_flow_versions.find(candidate => (
        candidate.id === flowVersionId
      ))
      if (!definition || !version) throw new Error('version missing')
      activationSnapshots.push(
        definition.whatsapp_flow_versions
          .filter(candidate => candidate.is_active)
          .map(candidate => candidate.id),
      )
      for (const candidate of definition.whatsapp_flow_versions) {
        candidate.is_active = candidate.id === flowVersionId
      }
      return { ...version, is_active: true }
    }),
    isWhatsAppFlowCapabilitiesSchemaReady: vi.fn(
      async () => options.schemaReady !== false,
    ),
    acquireFlowProvisioningLease: vi.fn(async (input) => {
      if (options.leaseBusy || (leaseOwner && leaseOwner !== input.ownerToken)) {
        return false
      }
      leaseOwner = input.ownerToken
      return true
    }),
    renewFlowProvisioningLease: vi.fn(async (input) => (
      leaseOwner === input.ownerToken
    )),
    releaseFlowProvisioningLease: vi.fn(async (input) => {
      if (leaseOwner !== input.ownerToken) return false
      leaseOwner = null
      return true
    }),
    listYCloudPhoneNumbers: vi.fn(async () => [{
      phoneNumber: '+593999000001',
      wabaId: 'waba-1',
    }]),
    createProviderFlow: vi.fn(async (_apiKey, input) => {
      events.push(`remote:create:${input.publish}`)
      remoteCounter += 1
      const id = `remote-${remoteCounter}`
      remote.set(id, {
        id,
        name: input.name,
        status: options.remoteStatusOnCreate || 'DRAFT',
        validationErrors: draftValidationErrors,
      })
      return { id, success: true }
    }),
    listProviderFlows: vi.fn(async () => (
      [...remote.values()].map(flow => ({ ...flow }))
    )),
    pingDataExchangeEndpoint: vi.fn(async () => ({
      data: { status: 'active' },
    })),
    retrieveProviderFlow: vi.fn(async (_apiKey, providerFlowId) => {
      const flow = remote.get(providerFlowId)
      events.push(`remote:get:${flow?.status || 'missing'}`)
      if (!flow) {
        const error = new Error('not found')
        error.status = 404
        throw error
      }
      return { ...flow }
    }),
    publishProviderFlow: vi.fn(async (_apiKey, providerFlowId) => {
      events.push('remote:publish')
      const flow = remote.get(providerFlowId)
      if (!flow) throw new Error('not found')
      if (!options.publishLeavesDraft) flow.status = 'PUBLISHED'
      return { success: true }
    }),
    getBaseUrl: vi.fn(() => 'https://bot.example.com'),
    getFallbackYCloudApiKey: vi.fn(() => undefined),
    isProviderNotFound: error => error?.status === 404,
    wait: vi.fn(async () => {}),
  }

  return {
    provisioner: createWhatsAppFlowProvisioner(dependencies),
    dependencies,
    definitions,
    remote,
    events,
    activationSnapshots,
    setBusiness(value) {
      currentBusiness = business(value)
    },
    setDraftValidationErrors(value) {
      draftValidationErrors = value
    },
  }
}

describe('provisión reusable de WhatsApp Flows', () => {
  it('recorre todas las páginas oficiales de números YCloud', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      phoneNumber: `+59399000${String(index).padStart(4, '0')}`,
      wabaId: `waba-${index}`,
    }))
    const get = vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { items: firstPage } })
      .mockResolvedValueOnce({
        data: {
          items: [{ phoneNumber: '+593999000001', wabaId: 'waba-final' }],
        },
      })
    try {
      const numbers = await listYCloudPhoneNumbersPaginated('api-key')

      expect(numbers).toHaveLength(101)
      expect(numbers.at(-1)).toEqual({
        phoneNumber: '+593999000001',
        wabaId: 'waba-final',
      })
      expect(get).toHaveBeenNthCalledWith(
        1,
        'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
        expect.objectContaining({
          params: { page: 1, limit: 100 },
        }),
      )
      expect(get).toHaveBeenNthCalledWith(
        2,
        'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
        expect.objectContaining({
          params: { page: 2, limit: 100 },
        }),
      )
    } finally {
      get.mockRestore()
    }
  })

  it('comprueba el endpoint real con ping y timeout corto', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { data: { status: 'active' } },
    })
    try {
      await expect(pingFlowDataExchangeEndpoint(
        'https://bot.example.com/webhook/ycloud/flows/data-exchange',
      )).resolves.toEqual({ data: { status: 'active' } })
      expect(post).toHaveBeenCalledWith(
        'https://bot.example.com/webhook/ycloud/flows/data-exchange',
        { action: 'ping' },
        expect.objectContaining({
          timeout: 3_000,
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )
    } finally {
      post.mockRestore()
    }
  })

  it('crea y verifica exclusivamente un borrador remoto', async () => {
    const harness = createHarness()

    const result = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )

    expect(result).toMatchObject({
      ok: true,
      status: 'draft',
      stage: 'draft',
      idempotent: false,
      templateKey: 'order_standard',
      capability: 'order',
      definitionId: 'definition-1',
      versionId: 'version-1',
      providerFlowId: 'remote-1',
      enabled: false,
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledWith(
      'ycloud-private-key',
      expect.objectContaining({
        wabaId: 'waba-1',
        publish: false,
        endpointUri:
          'https://bot.example.com/webhook/ycloud/flows/data-exchange',
        flowJson: expect.any(Object),
      }),
    )
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
    expect(harness.dependencies.pingDataExchangeEndpoint)
      .toHaveBeenCalledWith(
        'https://bot.example.com/webhook/ycloud/flows/data-exchange',
      )
    expect(
      harness.dependencies
        .pingDataExchangeEndpoint.mock.invocationCallOrder[0],
    ).toBeLessThan(
      harness.dependencies.createProviderFlow.mock.invocationCallOrder[0],
    )
  })

  it('publica, vuelve a verificar PUBLISHED, activa y habilita en ese orden', async () => {
    const harness = createHarness()

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: true,
      status: 'ready',
      publishAndEnable: true,
      results: [{
        status: 'published',
        stage: 'complete',
        enabled: true,
      }],
    })
    expect(harness.events).toEqual([
      'definition:order_standard:false',
      'create_version',
      'local:provisioning',
      'remote:create:false',
      'local:provisioning',
      'remote:get:DRAFT',
      'local:draft',
      'remote:get:DRAFT',
      'remote:publish',
      'remote:get:PUBLISHED',
      'local:published',
      'activate',
      'definition:order_standard:true',
    ])
    expect(
      harness.dependencies
        .pingDataExchangeEndpoint.mock.invocationCallOrder[1],
    ).toBeLessThan(
      harness.dependencies.publishProviderFlow.mock.invocationCallOrder[0],
    )
  })

  it('es idempotente al repetir el setup publicado y habilitado', async () => {
    const harness = createHarness()
    await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    const repeated = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(repeated).toMatchObject({
      ok: true,
      status: 'ready',
      results: [{
        status: 'published',
        enabled: true,
        idempotent: true,
      }],
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.publishProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.activateFlowVersion).toHaveBeenCalledTimes(1)
    expect(
      harness.definitions[0].whatsapp_flow_versions[0].provider_version,
    ).toMatch(/^[a-f0-9]{64}$/)
  })

  it('mantiene idempotencia aunque cambie el orden de claves JSON', async () => {
    const harness = createHarness()
    await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )
    const version = harness.definitions[0].whatsapp_flow_versions[0]
    version.flow_json = Object.fromEntries(
      Object.entries(version.flow_json).reverse(),
    )

    const repeated = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(repeated).toMatchObject({
      ok: true,
      status: 'ready',
      results: [{
        idempotent: true,
        versionId: 'version-1',
        providerFlowId: 'remote-1',
      }],
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(1)
  })

  it('crea reemplazo si cambia solo el origen absoluto del endpoint', async () => {
    const harness = createHarness()
    await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )
    const oldVersion = harness.definitions[0].whatsapp_flow_versions[0]
    const oldFingerprint = oldVersion.provider_version
    harness.dependencies.getBaseUrl.mockReturnValue(
      'https://flows.example.com',
    )
    harness.activationSnapshots.length = 0

    const replaced =
      await harness.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: true },
      )

    const newVersion = harness.definitions[0].whatsapp_flow_versions[1]
    expect(replaced).toMatchObject({
      ok: true,
      status: 'ready',
      results: [{
        status: 'published',
        versionId: 'version-2',
        providerFlowId: 'remote-2',
      }],
    })
    expect(oldVersion.data_exchange_endpoint_path)
      .toBe(newVersion.data_exchange_endpoint_path)
    expect(newVersion.provider_version).not.toBe(oldFingerprint)
    expect(harness.activationSnapshots).toEqual([['version-1']])
    expect(harness.dependencies.createProviderFlow).toHaveBeenLastCalledWith(
      'ycloud-private-key',
      expect.objectContaining({
        endpointUri:
          'https://flows.example.com/webhook/ycloud/flows/data-exchange',
      }),
    )
  })

  it('reemplaza de forma segura una versión antigua sin fingerprint', async () => {
    const harness = createHarness()
    await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )
    const oldVersion = harness.definitions[0].whatsapp_flow_versions[0]
    oldVersion.provider_version = null
    harness.activationSnapshots.length = 0

    const replaced =
      await harness.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: true },
      )

    expect(replaced.results[0]).toMatchObject({
      status: 'published',
      versionId: 'version-2',
      providerFlowId: 'remote-2',
    })
    expect(harness.activationSnapshots).toEqual([['version-1']])
    expect(oldVersion.is_active).toBe(false)
    expect(
      harness.definitions[0].whatsapp_flow_versions[1].provider_version,
    ).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [
      'JSON',
      version => {
        version.flow_json = {
          ...version.flow_json,
          obsolete_contract_marker: true,
        }
      },
    ],
    [
      'data_api_version',
      version => {
        version.data_api_version = '2.0'
      },
    ],
    [
      'data_exchange_endpoint_path',
      version => {
        version.data_exchange_endpoint_path = '/webhook/legacy'
      },
    ],
  ])('crea reemplazo si cambió %s sin desactivar antes la activa', async (
    _field,
    mutate,
  ) => {
    const harness = createHarness()
    await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )
    const oldVersion = harness.definitions[0].whatsapp_flow_versions[0]
    mutate(oldVersion)
    harness.activationSnapshots.length = 0

    const replaced =
      await harness.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: true },
      )

    expect(replaced).toMatchObject({
      ok: true,
      status: 'ready',
      results: [{
        status: 'published',
        versionId: 'version-2',
        providerFlowId: 'remote-2',
      }],
    })
    expect(harness.activationSnapshots).toEqual([['version-1']])
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(2)
    expect(oldVersion.is_active).toBe(false)
    expect(
      harness.definitions[0].whatsapp_flow_versions[1].is_active,
    ).toBe(true)
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(2)
  })

  it('detiene la creación si el ping no confirma data.status=active', async () => {
    const harness = createHarness()
    harness.dependencies.pingDataExchangeEndpoint.mockResolvedValue({
      data: { status: 'inactive' },
    })

    const draft = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )

    expect(draft).toMatchObject({
      ok: false,
      status: 'failed',
      stage: 'endpoint_ping',
    })
    expect(harness.dependencies.createProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
  })

  it('detiene la publicación si falla el segundo ping', async () => {
    const harness = createHarness()
    harness.dependencies.pingDataExchangeEndpoint
      .mockResolvedValueOnce({ data: { status: 'active' } })
      .mockResolvedValueOnce({ data: { status: 'inactive' } })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'failed',
        stage: 'endpoint_ping',
      }],
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
  })

  it('bloquea validaciones remotas y nunca publica ese Flow', async () => {
    const validationErrors = [{ message: 'Componente inválido' }]
    const harness = createHarness({ draftValidationErrors: validationErrors })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'blocked',
        stage: 'verify_draft',
        validationErrors,
        error: 'Componente inválido',
      }],
    })
    expect(harness.dependencies.updateFlowVersionState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'blocked',
        validationErrors,
      }),
    )
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
  })

  it('clasifica BLOCKED aunque YCloud no incluya validationErrors', async () => {
    const harness = createHarness({ remoteStatusOnCreate: 'BLOCKED' })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'blocked',
        stage: 'verify_draft',
        validationErrors: [],
      }],
    })
    expect(harness.dependencies.updateFlowVersionState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'blocked',
        validationErrors: [],
      }),
    )
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
  })

  it('impide publicar si la migración de capacidades no está lista', async () => {
    const harness = createHarness({ schemaReady: false })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'failed',
        stage: 'schema_readiness',
      }],
    })
    expect(setup.results[0].error).toContain(
      'migration-whatsapp-flows-capacidades.sql',
    )
    expect(harness.dependencies.acquireFlowProvisioningLease)
      .not.toHaveBeenCalled()
    expect(harness.dependencies.createProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
  })

  it('no activa si YCloud no confirma PUBLISHED después de publicar', async () => {
    const harness = createHarness({ publishLeavesDraft: true })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'failed',
        stage: 'verify_published',
        enabled: false,
      }],
    })
    expect(setup.results[0].error).toContain('PUBLISHED')
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
    expect(harness.definitions[0].enabled).toBe(false)
  })

  it('devuelve unsupported sin tocar YCloud para proveedores no soportados', async () => {
    const harness = createHarness({
      business: {
        whatsapp_provider: 'meta',
        takes_orders: false,
      },
    })

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'unsupported',
      results: [{
        templateKey: 'lead_standard',
        capability: 'lead',
        status: 'unsupported',
      }],
    })
    expect(harness.dependencies.listYCloudPhoneNumbers).not.toHaveBeenCalled()
    expect(harness.dependencies.createProviderFlow).not.toHaveBeenCalled()
  })

  it('selecciona todas las capacidades persistidas y lead como fallback', async () => {
    const multi = createHarness({
      business: {
        lodging_enabled: true,
        takes_orders: true,
        takes_bookings: true,
      },
    })
    const multiResult =
      await multi.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: false },
      )
    expect(multiResult.results.map(item => item.templateKey)).toEqual([
      'order_standard',
      'appointment_standard',
      'lodging_standard',
    ])
    expect(multiResult.results.every(item => item.status === 'draft')).toBe(true)

    const lead = createHarness({
      business: {
        lodging_enabled: false,
        takes_orders: false,
        takes_bookings: false,
      },
    })
    const leadResult = await lead.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: false },
    )
    expect(leadResult.results).toMatchObject([{
      templateKey: 'lead_standard',
      capability: 'lead',
      status: 'draft',
    }])
  })

  it('usa un lease distribuido y elimina secretos de los errores', async () => {
    const harness = createHarness()
    harness.dependencies.createProviderFlow.mockRejectedValueOnce(
      new Error(
        'falló ycloud-private-key y ycloud-private-key%20en proveedor',
      ),
    )

    const [first, second] = await Promise.all([
      harness.provisioner.provisionFlowDraft(BUSINESS_ID, 'order_standard'),
      harness.provisioner.provisionFlowDraft(BUSINESS_ID, 'order_standard'),
    ])

    expect(first).toMatchObject({
      status: 'failed',
      stage: 'create_remote',
    })
    expect(second).toMatchObject({
      status: 'failed',
      stage: 'lease',
      idempotent: true,
    })
    expect(first.error).not.toContain('ycloud-private-key')
    expect(first.error).toContain('••••••')
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.acquireFlowProvisioningLease)
      .toHaveBeenCalledTimes(2)
    expect(harness.dependencies.releaseFlowProvisioningLease)
      .toHaveBeenCalledTimes(1)
    const acquiredOwner = harness.dependencies
      .acquireFlowProvisioningLease.mock.calls[0][0].ownerToken
    expect(harness.dependencies.releaseFlowProvisioningLease)
      .toHaveBeenCalledWith(expect.objectContaining({
        businessId: BUSINESS_ID,
        templateKey: 'order_standard',
        ownerToken: acquiredOwner,
      }))
    expect(harness.dependencies.renewFlowProvisioningLease)
      .toHaveBeenCalledWith(expect.objectContaining({
        ownerToken: acquiredOwner,
      }))
    expect(harness.definitions[0].whatsapp_flow_versions[0].status)
      .toBe('provisioning')
  })

  it('mantiene el lease hasta publicar, activar y habilitar', async () => {
    const harness = createHarness()

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup.ok).toBe(true)
    const releaseOrder = harness.dependencies
      .releaseFlowProvisioningLease.mock.invocationCallOrder[0]
    const publishOrder = harness.dependencies
      .publishProviderFlow.mock.invocationCallOrder[0]
    const activateOrder = harness.dependencies
      .activateFlowVersion.mock.invocationCallOrder[0]
    const enableOrder = harness.dependencies
      .upsertFlowDefinition.mock.invocationCallOrder.at(-1)
    expect(releaseOrder).toBeGreaterThan(publishOrder)
    expect(releaseOrder).toBeGreaterThan(activateOrder)
    expect(releaseOrder).toBeGreaterThan(enableOrder)
  })

  it('no publica si perdió el lease antes del efecto remoto', async () => {
    const harness = createHarness()
    harness.dependencies.renewFlowProvisioningLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const setup = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(setup).toMatchObject({
      ok: false,
      status: 'failed',
      results: [{
        status: 'failed',
        stage: 'lease_lost',
      }],
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.dependencies.publishProviderFlow).not.toHaveBeenCalled()
    expect(harness.dependencies.activateFlowVersion).not.toHaveBeenCalled()
  })

  it('reemplaza una versión remota BLOCKED en el siguiente setup', async () => {
    const harness = createHarness()
    const first = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )
    harness.remote.get(first.providerFlowId).status = 'BLOCKED'

    const retried = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(retried).toMatchObject({
      ok: true,
      status: 'ready',
      results: [{
        status: 'published',
        versionId: 'version-2',
        providerFlowId: 'remote-2',
      }],
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(2)
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(2)
  })

  it('reemplaza una versión DEPRECATED o ausente en YCloud', async () => {
    const deprecated = createHarness()
    const firstDeprecated = await deprecated.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )
    deprecated.remote.get(firstDeprecated.providerFlowId).status = 'DEPRECATED'

    const retriedDeprecated =
      await deprecated.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: true },
      )

    expect(retriedDeprecated.results[0]).toMatchObject({
      status: 'published',
      versionId: 'version-2',
      providerFlowId: 'remote-2',
    })
    expect(deprecated.dependencies.createProviderFlow).toHaveBeenCalledTimes(2)

    const missing = createHarness()
    const firstMissing = await missing.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )
    missing.remote.delete(firstMissing.providerFlowId)

    const retriedMissing =
      await missing.provisioner.setupRecommendedFlowsForBusiness(
        BUSINESS_ID,
        { publishAndEnable: true },
      )

    expect(retriedMissing.results[0]).toMatchObject({
      status: 'published',
      versionId: 'version-2',
      providerFlowId: 'remote-2',
    })
    expect(missing.dependencies.createProviderFlow).toHaveBeenCalledTimes(2)
  })

  it('recupera una versión local failed si el remoto sigue válido', async () => {
    const harness = createHarness()
    const first = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )
    harness.definitions[0].whatsapp_flow_versions[0].status = 'failed'

    const retried = await harness.provisioner.setupRecommendedFlowsForBusiness(
      BUSINESS_ID,
      { publishAndEnable: true },
    )

    expect(retried.results[0]).toMatchObject({
      status: 'published',
      versionId: first.versionId,
      providerFlowId: first.providerFlowId,
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(1)
  })

  it('reconcilia por nombre un remoto creado antes de guardar su ID', async () => {
    const harness = createHarness()
    const first = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )
    const interrupted =
      harness.definitions[0].whatsapp_flow_versions[0]
    interrupted.status = 'provisioning'
    interrupted.provider_flow_id = null

    const retried = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
      { forceNewVersion: true },
    )

    expect(retried).toMatchObject({
      ok: true,
      status: 'draft',
      versionId: first.versionId,
      providerFlowId: first.providerFlowId,
    })
    expect(harness.dependencies.listProviderFlows).toHaveBeenCalledWith(
      'ycloud-private-key',
      'waba-1',
    )
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(1)
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(1)
  })

  it('permite una versión correctiva manual explícita', async () => {
    const harness = createHarness()
    await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
    )

    const corrective = await harness.provisioner.provisionFlowDraft(
      BUSINESS_ID,
      'order_standard',
      { forceNewVersion: true },
    )

    expect(corrective).toMatchObject({
      ok: true,
      status: 'draft',
      idempotent: false,
      versionId: 'version-2',
      providerFlowId: 'remote-2',
    })
    expect(harness.dependencies.createProviderFlow).toHaveBeenCalledTimes(2)
    expect(harness.definitions[0].whatsapp_flow_versions).toHaveLength(2)
  })
})

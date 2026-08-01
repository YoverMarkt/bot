import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  handleLeadFlowDataExchange,
  resolveLeadTopics,
} = require('../dist/services/whatsapp-flow-data-exchange-lead')

const BUSINESS_ID = '10000000-0000-4000-8000-000000000001'
const FLOW_VERSION_ID = '10000000-0000-4000-8000-000000000002'
const TOKEN = 'valid-lead-flow-token_1234567890'
const NOT_SETTLED = Symbol('not-settled-before-next-turn')

const beforeNextTurn = promise => Promise.race([
  promise,
  new Promise(resolve => setImmediate(() => resolve(NOT_SETTLED))),
])

function fixture(overrides = {}) {
  let session = {
    id: '40000000-0000-4000-8000-000000000001',
    business_id: BUSINESS_ID,
    provider: 'ycloud',
    flow_version_id: FLOW_VERSION_ID,
    status: 'open',
    context: { source: 'chat' },
    context_revision: 2,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    flow: {
      id: '50000000-0000-4000-8000-000000000001',
      flow_key: 'lead_standard',
      capability_key: 'lead',
      version: 1,
      provider_flow_id: 'provider-flow-1',
    },
    ...overrides.session,
  }
  const business = {
    id: BUSINESS_ID,
    name: 'Servicios Andinos',
    active: true,
    bot_active: true,
    suspended: false,
    lead_enabled: true,
    ...overrides.business,
  }
  const dependencies = {
    updateFlowSessionContext: vi.fn(async (
      businessId,
      provider,
      flowToken,
      expectedRevision,
      context,
    ) => {
      if (businessId !== BUSINESS_ID
        || provider !== 'ycloud'
        || flowToken !== TOKEN
        || expectedRevision !== session.context_revision) {
        return { result: 'stale', session }
      }
      session = {
        ...session,
        context,
        context_revision: session.context_revision + 1,
      }
      return { result: 'updated', session }
    }),
    recordFlowMetric: vi.fn(async () => true),
    ...overrides.dependencies,
  }
  const configuration = overrides.configuration ?? {
    topics: [
      { id: 'ventas', title: 'Ventas' },
      { id: 'soporte', title: 'Soporte' },
    ],
  }
  return {
    dependencies,
    business,
    session: () => session,
    exchange: request => handleLeadFlowDataExchange({
      request,
      session,
      business,
      flowToken: TOKEN,
      configuration,
    }, dependencies),
  }
}

describe('handler data_exchange de solicitudes', () => {
  it('inicializa con temas de la configuración del negocio resuelto', async () => {
    const current = fixture()
    const response = await current.exchange({
      version: '3.0',
      action: 'INIT',
      flow_token: TOKEN,
      data: {},
    })

    expect(response).toEqual({
      screen: 'LEAD_DETAILS',
      data: {
        business_name: 'Servicios Andinos',
        topics: [
          { id: 'ventas', title: 'Ventas' },
          { id: 'soporte', title: 'Soporte' },
        ],
        contact_name: '',
        topic_id: '',
        details: '',
        email: '',
        preferred_time: '',
        error_message: '',
      },
    })
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
    expect(current.dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        provider: 'ycloud',
        eventType: 'step.init',
      }),
    )
  })

  it('usa temas genéricos si no existe una configuración válida', async () => {
    const current = fixture({
      configuration: { topics: [null, {}, { id: '', title: '' }] },
    })
    const response = await current.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })

    expect(response.data.topics).toEqual([
      { id: 'informacion', title: 'Información' },
      { id: 'cotizacion', title: 'Cotización' },
      { id: 'hablar-equipo', title: 'Hablar con el equipo' },
    ])
  })

  it('normaliza, deduplica y limita los temas configurados', () => {
    const topics = resolveLeadTopics({
      lead_topics: [
        'Información general',
        { id: 'informacion-general', title: 'Duplicado' },
        ...Array.from(
          { length: 30 },
          (_, index) => ({ id: `tema-${index}`, title: `Tema ${index}` }),
        ),
      ],
    })

    expect(topics[0]).toEqual({
      id: 'informacion-general',
      title: 'Información general',
    })
    expect(topics).toHaveLength(20)
    expect(new Set(topics.map(topic => topic.id)).size).toBe(20)
  })

  it('limita textos dinámicos y conserva IDs únicos para Meta', async () => {
    const current = fixture({
      business: {
        name: 'N'.repeat(120),
      },
      configuration: {
        topics: [
          {
            id: 'tema-largo',
            title: `Tema ${'muy largo '.repeat(8)}`,
          },
          {
            id: 'tema-largo',
            title: 'Duplicado',
          },
        ],
      },
    })

    const response = await current.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })

    expect([...response.data.business_name]).toHaveLength(80)
    expect(response.data.topics).toHaveLength(1)
    expect(response.data.topics[0].id).toBe('tema-largo')
    expect([...response.data.topics[0].title].length)
      .toBeLessThanOrEqual(30)
  })

  it('valida y guarda lead_draft canónico mediante CAS', async () => {
    const current = fixture()
    const response = await current.exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        intent: 'review_lead',
        contact_name: '  Andrea Rosado ',
        topic_id: 'ventas',
        topic_label: 'Etiqueta manipulada',
        details: ' Necesito una cotización ',
        email: ' andrea@example.com ',
        preferred_time: ' Por la tarde ',
        business_id: 'otro-negocio',
      },
    })

    expect(response).toEqual({
      screen: 'LEAD_REVIEW',
      data: {
        flow_token: TOKEN,
        contact_name: 'Andrea Rosado',
        topic_id: 'ventas',
        topic_label: 'Ventas',
        details: 'Necesito una cotización',
        email: 'andrea@example.com',
        preferred_time: 'Por la tarde',
        summary: [
          'Nombre: Andrea Rosado',
          'Solicitud: Necesito una cotización',
          'Correo: andrea@example.com',
          'Horario preferido: Por la tarde',
        ].join('\n'),
      },
    })
    expect(current.dependencies.updateFlowSessionContext).toHaveBeenCalledWith(
      BUSINESS_ID,
      'ycloud',
      TOKEN,
      2,
      {
        source: 'chat',
        lead_draft: {
          schema_version: 1,
          contact_name: 'Andrea Rosado',
          topic_id: 'ventas',
          topic_label: 'Ventas',
          details: 'Necesito una cotización',
          email: 'andrea@example.com',
          preferred_time: 'Por la tarde',
        },
      },
    )
    expect(current.session().context.lead_draft.topic_label).toBe('Ventas')
    expect(current.session().context).not.toHaveProperty('business_id')
  })

  it('persiste el lead y responde sin esperar una métrica colgada', async () => {
    const current = fixture({
      dependencies: {
        recordFlowMetric: vi.fn(() => new Promise(() => {})),
      },
    })

    const response = await beforeNextTurn(current.exchange({
      version: '3.0',
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        intent: 'review_lead',
        contact_name: 'Andrea Rosado',
        topic_id: 'ventas',
        details: 'Necesito una cotización',
      },
    }))

    expect(response).not.toBe(NOT_SETTLED)
    expect(response).toMatchObject({ screen: 'LEAD_REVIEW' })
    expect(current.session().context.lead_draft).toMatchObject({
      contact_name: 'Andrea Rosado',
      topic_id: 'ventas',
      topic_label: 'Ventas',
    })
    expect(current.dependencies.updateFlowSessionContext).toHaveBeenCalledOnce()
  })

  it('BACK reconstruye DETAILS solo con el contexto canónico del servidor', async () => {
    const current = fixture({
      session: {
        context: {
          source: 'chat',
          lead_draft: {
            schema_version: 1,
            contact_name: 'Andrea',
            topic_id: 'soporte',
            topic_label: 'Texto anterior',
            details: 'Ayuda con mi cuenta',
            email: null,
            preferred_time: 'Mañana',
          },
        },
      },
    })

    const response = await current.exchange({
      action: 'BACK',
      screen: 'LEAD_REVIEW',
      flow_token: TOKEN,
      data: {
        contact_name: 'Atacante',
        topic_id: 'ventas',
        details: 'Texto manipulado',
      },
    })

    expect(response).toEqual({
      screen: 'LEAD_DETAILS',
      data: expect.objectContaining({
        contact_name: 'Andrea',
        topic_id: 'soporte',
        details: 'Ayuda con mi cuenta',
        preferred_time: 'Mañana',
      }),
    })
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
    expect(current.dependencies.recordFlowMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'step.back',
        sourceKey: expect.stringContaining('LEAD_REVIEW'),
      }),
    )
  })

  it.each([
    [
      'nombre obligatorio',
      {
        topic_id: 'ventas',
        details: 'Necesito información',
      },
      /obligatorios/i,
    ],
    [
      'tema ajeno a la configuración',
      {
        contact_name: 'Andrea',
        topic_id: 'tenant-ajeno',
        details: 'Necesito información',
      },
      /tema válido/i,
    ],
    [
      'nombre demasiado corto',
      {
        contact_name: 'A',
        topic_id: 'ventas',
        details: 'Necesito información',
      },
      /nombre válido/i,
    ],
    [
      'detalle demasiado corto',
      {
        contact_name: 'Andrea',
        topic_id: 'ventas',
        details: '?',
      },
      /describe brevemente/i,
    ],
    [
      'correo inválido',
      {
        contact_name: 'Andrea',
        topic_id: 'ventas',
        details: 'Necesito información',
        email: 'correo-inválido',
      },
      /correo electrónico válido/i,
    ],
  ])('devuelve en DETAILS el error recuperable de %s', async (
    _label,
    data,
    expectedError,
  ) => {
    const current = fixture()
    const response = await current.exchange({
      action: 'data_exchange',
      screen: 'LEAD_DETAILS',
      flow_token: TOKEN,
      data: { intent: 'review_lead', ...data },
    })

    expect(response).toEqual({
      screen: 'LEAD_DETAILS',
      data: expect.objectContaining({
        error_message: expect.stringMatching(expectedError),
      }),
    })
    expect(current.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('trata un conflicto CAS como recuperable y no muestra datos no guardados', async () => {
    const current = fixture({
      dependencies: {
        updateFlowSessionContext: vi.fn(async () => ({
          result: 'stale',
          session: null,
        })),
      },
    })
    const response = await current.exchange({
      action: 'data_exchange',
      flow_token: TOKEN,
      data: {
        intent: 'review_lead',
        contact_name: 'Dato no guardado',
        topic_id: 'ventas',
        details: 'No debe presentarse como canónico',
      },
    })

    expect(response).toEqual({
      screen: 'LEAD_DETAILS',
      data: expect.objectContaining({
        contact_name: '',
        details: '',
        error_message: 'El formulario cambió. Intenta nuevamente.',
      }),
    })
  })

  it('falla cerrado para capability, tenant o negocio no disponibles', async () => {
    const wrongCapability = fixture({
      session: { flow: { capability_key: 'order' } },
    })
    await expect(wrongCapability.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })

    const wrongTenant = fixture({
      business: { id: 'otro-negocio' },
    })
    await expect(wrongTenant.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })

    const disabled = fixture({
      business: { lead_enabled: false },
    })
    await expect(disabled.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })).rejects.toMatchObject({ status: 403 })

    expect(disabled.dependencies.updateFlowSessionContext).not.toHaveBeenCalled()
  })

  it('no interrumpe el Flow si falla la métrica best-effort', async () => {
    const current = fixture({
      dependencies: {
        recordFlowMetric: vi.fn(async () => {
          throw new Error('métricas no disponibles')
        }),
      },
    })

    await expect(current.exchange({
      action: 'INIT',
      flow_token: TOKEN,
    })).resolves.toMatchObject({ screen: 'LEAD_DETAILS' })
  })
})

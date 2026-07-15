import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import billingRouter from '../dist/routes/admin-billing.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'admin-billing-test-secret'
const BUSINESS_ID = '11111111-1111-4111-8111-111111111111'
const BILLING_ID = '22222222-2222-4222-8222-222222222222'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(claims = {}) {
  return `Bearer ${jwt.sign({ role: 'admin', ...claims }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = billingRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

describe('facturación del superadmin', () => {
  it('protege los tres endpoints exclusivamente con autenticación admin', async () => {
    expect(billingRouter.stack).toHaveLength(3)
    expect(billingRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('get', '/api/admin/billing')).status).toBe(401)

    const clientToken = `Bearer ${jwt.sign({
      role: 'client', businessId: 'business-a',
    }, JWT_SECRET)}`
    expect((await dispatch('get', '/api/admin/billing', { auth: clientToken })).status).toBe(403)
  })

  it('lista y crea facturación conservando el contrato del panel', async () => {
    const getBilling = vi.spyOn(db, 'getBilling').mockResolvedValue([{ id: 'billing-a' }])
    const createBilling = vi.spyOn(db, 'createBilling').mockResolvedValue({
      data: { id: 'billing-b' }, error: null,
    })
    const auth = authorization()

    const listed = await dispatch('get', '/api/admin/billing', { auth })
    const created = await dispatch('post', '/api/admin/billing', {
      auth,
      body: {
        business_id: BUSINESS_ID,
        amount: 25,
        extra: 'no debe llegar a la base',
      },
    })

    expect(listed.body).toEqual([{ id: 'billing-a' }])
    expect(created.body).toEqual({ id: 'billing-b' })
    expect(getBilling).toHaveBeenCalledOnce()
    expect(createBilling).toHaveBeenCalledWith({
      business_id: BUSINESS_ID,
      amount: 25,
      status: 'pending',
      period_start: null,
      period_end: null,
      notes: null,
      paid_at: null,
    })
  })

  it('normaliza centavos y solo persiste campos permitidos al crear', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T15:30:00.000Z'))
    const createBilling = vi.spyOn(db, 'createBilling').mockResolvedValue({
      data: { id: BILLING_ID }, error: null,
    })

    const response = await dispatch('post', '/api/admin/billing', {
      auth: authorization(),
      body: {
        business_id: ` ${BUSINESS_ID} `,
        amount: 10.10,
        status: 'paid',
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        notes: '  Pago manual  ',
        paid_at: '2000-01-01T00:00:00.000Z',
        currency: 'EUR',
      },
    })

    expect(response).toEqual({ status: 200, body: { id: BILLING_ID } })
    expect(createBilling).toHaveBeenCalledWith({
      business_id: BUSINESS_ID,
      amount: 10.1,
      status: 'paid',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      notes: 'Pago manual',
      paid_at: '2026-07-12T15:30:00.000Z',
    })
  })

  it('rechaza negocios, montos, estados, fechas y notas inválidos', async () => {
    const createBilling = vi.spyOn(db, 'createBilling').mockResolvedValue({
      data: { id: BILLING_ID }, error: null,
    })
    const valid = {
      business_id: BUSINESS_ID,
      amount: 25,
      status: 'pending',
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      notes: 'Cuota mensual',
    }
    const invalidBodies = [
      { ...valid, business_id: 'business-a' },
      { ...valid, amount: 0 },
      { ...valid, amount: -1 },
      { ...valid, amount: 1.001 },
      { ...valid, amount: '25.00' },
      { ...valid, status: 'refunded' },
      { ...valid, period_start: '2026-02-29' },
      { ...valid, period_start: '2026-08-01', period_end: '2026-07-31' },
      { ...valid, notes: 123 },
      { ...valid, notes: 'x'.repeat(2_001) },
    ]

    for (const body of invalidBodies) {
      const response = await dispatch('post', '/api/admin/billing', {
        auth: authorization(), body,
      })
      expect(response.status).toBe(400)
      expect(response.body).toHaveProperty('error')
    }
    expect(createBilling).not.toHaveBeenCalled()
  })

  it('no confirma un cambio de estado rechazado por Supabase', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T16:00:00.000Z'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const updateBilling = vi.spyOn(db, 'updateBillingStatus').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })

    const response = await dispatch('put', '/api/admin/billing/:id', {
      auth: authorization(),
      params: { id: BILLING_ID },
      body: { status: 'paid', paid_at: '2000-01-01T00:00:00.000Z' },
    })

    expect(updateBilling).toHaveBeenCalledWith(
      BILLING_ID, 'paid', '2026-07-12T16:00:00.000Z',
    )
    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo actualizar la facturación' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it('confirma únicamente cuando Supabase acepta el cambio', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-12T17:00:00.000Z'))
    const updateBilling = vi.spyOn(db, 'updateBillingStatus').mockResolvedValue({ error: null })

    const response = await dispatch('put', '/api/admin/billing/:id', {
      auth: authorization(),
      params: { id: BILLING_ID },
      body: {
        status: 'paid',
        paid_at: '2000-01-01T00:00:00.000Z',
        amount: 0,
        business_id: 'otro-negocio',
      },
    })

    expect(updateBilling).toHaveBeenCalledWith(
      BILLING_ID, 'paid', '2026-07-12T17:00:00.000Z',
    )
    expect(response).toEqual({ status: 200, body: { ok: true } })
  })

  it('rechaza ids y estados inválidos sin modificar la facturación', async () => {
    const updateBilling = vi.spyOn(db, 'updateBillingStatus').mockResolvedValue({ error: null })

    const invalidId = await dispatch('put', '/api/admin/billing/:id', {
      auth: authorization(),
      params: { id: 'billing-a' },
      body: { status: 'paid' },
    })
    const invalidStatus = await dispatch('put', '/api/admin/billing/:id', {
      auth: authorization(),
      params: { id: BILLING_ID },
      body: { status: 'refunded' },
    })

    expect(invalidId.status).toBe(400)
    expect(invalidStatus.status).toBe(400)
    expect(updateBilling).not.toHaveBeenCalled()
  })

  it('limpia paid_at al volver un registro a pendiente o vencido', async () => {
    const updateBilling = vi.spyOn(db, 'updateBillingStatus').mockResolvedValue({ error: null })

    for (const status of ['pending', 'overdue']) {
      const response = await dispatch('put', '/api/admin/billing/:id', {
        auth: authorization(),
        params: { id: BILLING_ID },
        body: { status, paid_at: '2000-01-01T00:00:00.000Z' },
      })
      expect(response.status).toBe(200)
    }

    expect(updateBilling).toHaveBeenNthCalledWith(1, BILLING_ID, 'pending', null)
    expect(updateBilling).toHaveBeenNthCalledWith(2, BILLING_ID, 'overdue', null)
  })
})

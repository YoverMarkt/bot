import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const db = require('../dist/db')
const facadeSource = readFileSync(`${serverDir}/src/db/index.ts`, 'utf8')
const clientSource = readFileSync(`${serverDir}/src/db/client.ts`, 'utf8')
const businessesSource = readFileSync(
  `${serverDir}/src/db/repositories/businesses.ts`,
  'utf8',
)
const channelsSource = readFileSync(
  `${serverDir}/src/types/channels.ts`,
  'utf8',
)
const usersSource = readFileSync(
  `${serverDir}/src/db/repositories/client-users.ts`,
  'utf8',
)
const policiesSource = readFileSync(
  `${serverDir}/src/db/repositories/policies.ts`,
  'utf8',
)
const billingSource = readFileSync(
  `${serverDir}/src/db/repositories/billing.ts`,
  'utf8',
)
const productsSource = readFileSync(
  `${serverDir}/src/db/repositories/products.ts`,
  'utf8',
)
const historySource = readFileSync(
  `${serverDir}/src/db/repositories/conversation-history.ts`,
  'utf8',
)
const sessionsSource = readFileSync(
  `${serverDir}/src/db/repositories/sessions.ts`,
  'utf8',
)
const tagsSource = readFileSync(
  `${serverDir}/src/db/repositories/conversation-tags.ts`,
  'utf8',
)
const bookingsSource = readFileSync(
  `${serverDir}/src/db/repositories/bookings.ts`,
  'utf8',
)
const salesSource = readFileSync(
  `${serverDir}/src/db/repositories/sales.ts`,
  'utf8',
)
const reportingSource = readFileSync(
  `${serverDir}/src/db/repositories/reporting.ts`,
  'utf8',
)
const ordersSource = readFileSync(
  `${serverDir}/src/db/repositories/orders.ts`,
  'utf8',
)
const statsSource = readFileSync(
  `${serverDir}/src/db/repositories/stats.ts`,
  'utf8',
)
const webhookEventsSource = readFileSync(
  `${serverDir}/src/db/repositories/webhook-events.ts`,
  'utf8',
)
const aiSource = readFileSync(`${serverDir}/src/services/ai.ts`, 'utf8')
const entrySource = readFileSync(`${serverDir}/src/services/bot-entry.ts`, 'utf8')
const indexSource = readFileSync(`${serverDir}/src/index.ts`, 'utf8')

describe('migración de la capa de datos', () => {
  it('conserva el contrato público de negocios en la fachada db.js', () => {
    for (const method of [
      'getBusinessById',
      'getBusinessBySlug',
      'getBusinessByChannel',
      'getBusinessByPhone',
      'getAllBusinesses',
      'createBusiness',
      'createBusinessOnboarding',
      'updateBusiness',
      'suspendBusiness',
      'reactivateBusiness',
      'deleteBusiness',
      'getExpiredBusinesses',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
  })

  it('centraliza la conexión Supabase y mantiene la service role en el servidor', () => {
    expect(clientSource).toContain("import { createClient } from '@supabase/supabase-js'")
    expect(clientSource).toContain('process.env.SUPABASE_SERVICE_KEY')
    expect(facadeSource).not.toContain("require('@supabase/supabase-js')")
    expect(facadeSource).toContain("import businesses = require('./repositories/businesses')")
    expect(businessesSource).toContain("require('../client')")
  })

  it('conserva el aislamiento y la eliminación transaccional del agregado', () => {
    expect(businessesSource).toContain(".eq('id', id)")
    expect(businessesSource).toContain("db.from('businesses').delete().eq('id', id)")
    expect(businessesSource).not.toContain("p_business ->> 'business_id'")
  })

  it('resuelve canales por proveedor e identificador completo sin sufijos', () => {
    const compatibilityResolver = businessesSource.slice(
      businessesSource.indexOf('const getBusinessByPhone'),
      businessesSource.indexOf('const businessListFields'),
    )
    expect(businessesSource).toContain("from('business_channel_identifiers')")
    expect(businessesSource).toContain(".select('business_id,businesses(*)')")
    expect(businessesSource).toContain(".eq('provider', address.provider)")
    expect(businessesSource).toContain(
      ".eq('identifier_type', address.identifierType)",
    )
    expect(businessesSource).toContain(
      ".eq('canonical_identifier', canonical)",
    )
    expect(compatibilityResolver).not.toContain("from('businesses')")
    expect(businessesSource).not.toContain('No se pudo cargar el negocio del canal')
    expect(businessesSource).not.toMatch(/slice\(\s*-9\s*\)/)
    expect(channelsSource).toContain('/^[1-9][0-9]{7,14}$/')
    expect(channelsSource).toContain('nunca infiere país ni compara sufijos')
  })

  it('mantiene usuarios, políticas y facturación en repositorios tipados', () => {
    for (const method of [
      'getClientByEmail',
      'getClientUserByBusiness',
      'createClientUser',
      'updateClientUser',
      'getClientUsers',
      'getClientUserById',
      'updateClientUserById',
      'deleteClientUserById',
      'getPolicies',
      'upsertPolicies',
      'getBilling',
      'createBilling',
      'createBillingBatch',
      'updateBillingStatus',
      'countBilling',
      'updatePendingBilling',
      'generateYearBilling',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(facadeSource).not.toContain("from('client_users')")
    expect(facadeSource).not.toContain("from('bot_policies')")
    expect(facadeSource).not.toContain("from('billing')")
  })

  it('protege dueño, empleados y políticas con business_id', () => {
    expect(usersSource).toContain(".eq('business_id', businessId)")
    expect(usersSource).toContain(".eq('role', 'owner')")
    expect(usersSource).toContain(".eq('role', 'employee')")
    expect(policiesSource).toContain(".eq('business_id', businessId)")
    expect(policiesSource).toContain('business_id: businessId')
    expect(billingSource).toContain(".eq('business_id', businessId)")
  })

  it('conserva el contrato de las 12 cuotas anuales', () => {
    const rows = db.generateYearBilling('business-a', 24.5)

    expect(rows).toHaveLength(12)
    expect(rows.every(row => (
      row.business_id === 'business-a'
      && row.amount === 24.5
      && row.status === 'pending'
      && /^\d{4}-\d{2}-\d{2}$/.test(row.period_start)
      && /^\d{4}-\d{2}-\d{2}$/.test(row.period_end)
    ))).toBe(true)
  })

  it('migra catálogo y RAG sin perder el contrato público', () => {
    for (const method of [
      'getProducts',
      'getProductById',
      'getProductImageById',
      'createProduct',
      'updateProduct',
      'deleteProduct',
      'countProducts',
      'setProductEmbedding',
      'getProductsWithoutEmbedding',
      'searchProductsByVector',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(facadeSource).not.toMatch(/const getProducts\s*=/)
    expect(facadeSource).not.toMatch(/const setProductEmbedding\s*=/)
  })

  it('filtra lecturas, mutaciones y embeddings por business_id', () => {
    expect(productsSource).toContain('const getProductById = async (businessId: string')
    expect(productsSource).toContain('const setProductEmbedding = async (')
    expect(productsSource.match(/\.eq\('business_id', businessId\)/g)?.length).toBeGreaterThanOrEqual(7)
    expect(productsSource).toContain('delete safe.business_id')
    expect(aiSource).toContain(
      'db.setProductEmbedding(product.business_id, product.id, embedding)',
    )
  })

  it('limita la imagen pública a image_url y comprueba errores de indexación', () => {
    expect(productsSource).toContain(".select('image_url')")
    expect(indexSource).toContain('db.getProductImageById(req.params.productId)')
    expect(indexSource).not.toContain('db.getProductById(req.params.productId)')
    expect(aiSource).toContain("if (error) throw new Error(error.message")
    expect(entrySource).toContain("require('./ai')")
  })

  it('migra conversaciones, sesiones y etiquetas sin romper su contrato', () => {
    for (const method of [
      'getConversations',
      'getContactHistory',
      'getLatestBusinessIdForContact',
      'saveMessage',
      'clearSimHistory',
      'getSession',
      'getSessions',
      'upsertSession',
      'getTags',
      'createTag',
      'updateTag',
      'deleteTag',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(facadeSource).not.toMatch(/const getConversations\s*=/)
    expect(facadeSource).not.toMatch(/const upsertSession\s*=/)
    expect(facadeSource).not.toMatch(/const createTag\s*=/)
  })

  it('aísla historial, sesiones y etiquetas por business_id', () => {
    expect(historySource.match(/business_id/g)?.length).toBeGreaterThanOrEqual(4)
    expect(sessionsSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(tagsSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(3)
    expect(tagsSource).toContain('business_id: businessId')
  })

  it('impide que datos de sesión reasignen tenant, teléfono o identidad', () => {
    expect(sessionsSource).toContain('delete safe.id')
    expect(sessionsSource).toContain('delete safe.business_id')
    expect(sessionsSource).toContain('delete safe.contact_phone')
    expect(sessionsSource).toContain('business_id: businessId')
    expect(sessionsSource).toContain('contact_phone: phone')
  })

  it('migra horarios y reservas conservando el contrato público', () => {
    for (const method of [
      'getSchedule',
      'upsertSchedule',
      'getBookings',
      'createBooking',
      'getBookingById',
      'updateBookingStatus',
      'getAvailableSlots',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(facadeSource).not.toMatch(/const getSchedule\s*=/)
    expect(facadeSource).not.toMatch(/const createBooking\s*=/)
  })

  it('aísla disponibilidad, creación atómica y estados por business_id', () => {
    expect(bookingsSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(5)
    expect(bookingsSource).toContain(
      'const getBookingById = async (businessId: string, id: string)',
    )
    expect(bookingsSource).toContain('delete safe.business_id')
    expect(bookingsSource).toContain("'create_booking_if_available'")
    expect(bookingsSource).not.toContain('p_service_product_id')
    expect(bookingsSource).toContain('p_business_id: businessId')
    expect(bookingsSource).not.toContain("from('bookings').insert")
  })

  it('migra ventas y datos de reportes conservando el contrato público', () => {
    for (const method of [
      'createSaleWithItems',
      'getSaleById',
      'getSalesByContact',
      'getSaleCustomers',
      'getCustomerSales',
      'voidSale',
      'getSalesWithItems',
      'recordConsultations',
      'getConsultationsInRange',
      'getWritersInRange',
      'getUserMessagesInRange',
      'getHistoryInRange',
      'recordAiGap',
      'getAiGaps',
      'getLowStockProducts',
      'getPendingOrders',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(facadeSource).not.toMatch(/const createSaleWithItems\s*=/)
    expect(facadeSource).not.toMatch(/const getPendingOrders\s*=/)
  })

  it('conserva la RPC de ventas y filtra todos los reportes por business_id', () => {
    expect(salesSource).toContain("'create_sale_with_items'")
    expect(salesSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(6)
    expect(reportingSource.match(/business_id/g)?.length).toBeGreaterThanOrEqual(10)
    expect(reportingSource).toContain('business_id: businessId')
  })

  it('migra pedidos a una RPC y protege sus actualizaciones por business_id', () => {
    for (const method of ['createOrder', 'getOrders', 'updateOrder', 'setOrderStatus']) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(ordersSource).toContain("'create_order_with_items'")
    expect(ordersSource).toContain("'set_order_status'")
    expect(ordersSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(ordersSource).toContain('delete safe.business_id')
    expect(facadeSource).not.toMatch(/const createOrder\s*=/)
  })

  it('cierra estadísticas y webhooks en repositorios TypeScript', () => {
    for (const method of [
      'getAdminStats',
      'getClientStats',
      'claimWebhookEvent',
      'enqueueWebhookEvent',
      'leaseWebhookEvents',
      'renewWebhookEventLease',
      'completeWebhookEvent',
      'failWebhookEvent',
      'cleanupWebhookEvents',
    ]) {
      expect(db[method]).toBeTypeOf('function')
    }
    expect(statsSource.match(/\.eq\('business_id', businessId\)/g)?.length)
      .toBeGreaterThanOrEqual(4)
    expect(webhookEventsSource).toContain("createHash('sha256')")
    expect(webhookEventsSource).toContain("'claim_webhook_event'")
    expect(webhookEventsSource).toContain("'enqueue_webhook_event'")
    expect(webhookEventsSource).toContain("'lease_webhook_events'")
  })
})

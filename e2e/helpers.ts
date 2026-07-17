import { expect, type Locator, type Page, type Route } from '@playwright/test'

export async function expectConnectedLabels(scope: Locator) {
  const issues = await scope.locator('label').evaluateAll(labels => labels.flatMap(label => {
    const text = label.textContent?.replace(/\s+/g, ' ').trim() || '(sin texto)'
    const controlId = label.getAttribute('for')
    if (controlId) {
      const control = label.ownerDocument.getElementById(controlId)
      return control?.matches('button, input, meter, output, progress, select, textarea, [role="checkbox"], [role="combobox"], [role="switch"]')
        ? []
        : [`${text} → #${controlId} no existe o no es un control`]
    }

    return label.querySelector('input, meter, output, progress, select, textarea')
      ? []
      : [`${text} → no tiene atributo for`]
  }))

  expect(issues).toEqual([])

  const unnamedControls = await scope
    .locator('input:not([type="hidden"]):not([aria-hidden="true"]), select:not([aria-hidden="true"]), textarea:not([aria-hidden="true"]), [role="checkbox"]:not([aria-hidden="true"]), [role="combobox"]:not([aria-hidden="true"]), [role="switch"]:not([aria-hidden="true"])')
    .evaluateAll(controls => controls.flatMap(control => {
      const id = control.getAttribute('id')
      const labelledBy = control.getAttribute('aria-labelledby')
      const hasLabelledBy = labelledBy?.split(/\s+/).some(labelId => {
        const label = control.ownerDocument.getElementById(labelId)
        return Boolean(label?.textContent?.trim())
      })
      const hasName = Boolean(
        control.getAttribute('aria-label')?.trim()
        || hasLabelledBy
        || (id && control.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`))
        || control.closest('label')
      )

      return hasName ? [] : [`${control.tagName.toLowerCase()}${id ? `#${id}` : ''} → sin nombre accesible`]
    }))

  expect(unnamedControls).toEqual([])
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

export async function mockClientApi(page: Page) {
  await page.route('**/api/client/**', async (route) => {
    const path = new URL(route.request().url()).pathname

    if (path === '/api/client/login') {
      return json(route, {
        token: 'e2e-client-token',
        business: { id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda', takes_bookings: false },
        user: { name: 'Dueño E2E', role: 'owner', permissions: [] },
      })
    }
    if (path === '/api/client/business') return json(route, { id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda', takes_bookings: false })
    if (path === '/api/client/stats') return json(route, { totalProducts: 1, totalConversations: 0, totalSales: 0 })
    if (path === '/api/client/dashboard') {
      return json(route, {
        period: 'semana', label: 'Esta semana',
        kpis: { total: 0, orders: 0, avg: 0, conversion: null, items: 0, clientes: 0, nuevos: 0, recurrentes: 0 },
        comparison: { curTotal: 0, prevTotal: 0, pct: null },
        top: [],
        stock: { disponible: 1, ultimas: 0, agotado: 0 },
        customersByStatus: { nuevos: 0, frecuentes: 0, activos: 0, inactivos: 0 },
        trend: { days: 7, rows: [] },
      })
    }
    if (path === '/api/client/alerts') return json(route, { alerts: [] })
    if (path === '/api/client/reports') {
      return json(route, {
        period: 'mes',
        summary: { label: 'este mes', total: 120, orders: 3, items: 5, avg: 40, nuevos: 2, recurrentes: 1, conversion: 50 },
        trend: { days: 7, total: 120, rows: [{ date: '2026-07-11', label: '11/07', total: 40, orders: 1 }, { date: '2026-07-12', label: '12/07', total: 80, orders: 2 }] },
        comparison: { label: 'este mes', curTotal: 120, curOrders: 3, prevTotal: 80, prevOrders: 2, pct: 50 },
        bySeller: { label: 'este mes', rows: [{ name: 'Dueño E2E', total: 120 }] },
        pending: { count: 0, rows: [] },
        top: { label: 'este mes', rows: [{ name: 'Producto E2E', qty: 5, rev: 120 }] },
        mostConsulted: { label: 'este mes', rows: [{ name: 'Producto E2E', count: 8 }] },
        abandoned: { label: 'este mes', rows: [] },
        lowMovement: { label: 'este mes', rows: [] },
        lowStock: { rows: [] },
        recurring: { label: 'este mes', rows: [{ name: 'Cliente E2E', orders: 2, total: 80 }] },
        lostCustomers: { label: 'este mes', count: 0, noRespondio: 0, returning: 0, nuevos: 0, rows: [] },
        faq: { label: 'este mes', analyzed: 4, rows: [{ topic: 'Precios', emoji: '💲', count: 4 }] },
        unanswered: { label: 'este mes', count: 0, unique: 0, rows: [] },
      })
    }
    if (path === '/api/client/onboarding') return json(route, { done: 5, total: 5, pct: 100, steps: [] })
    if (path === '/api/client/products') return json(route, [{ id: 'product-e2e', name: 'Producto E2E', price: 10, stock: 5, active: true, status: 'disponible' }])
    if (path === '/api/client/sessions') {
      return json(route, [{
        contact_phone: '+593999999999',
        contact_name: 'Cliente móvil',
        manual_mode: false,
        unread_owner: false,
        last_message: 'Hola desde E2E',
        last_message_at: '2026-07-12T18:00:00.000Z',
        tags: [],
      }])
    }
    if (path === '/api/client/conversations') {
      return json(route, [{
        contact_phone: '+593999999999',
        role: 'user',
        content: 'Hola desde E2E',
        created_at: '2026-07-12T18:00:00.000Z',
      }, {
        contact_phone: '+593999999999',
        role: 'assistant',
        // URL imposible de partir: regresión del desbordamiento horizontal del chat
        content: 'Aquí está la foto: https://res.cloudinary.com/botpanel/image/upload/v1783287641/botpanel/5f53982a-839d-47ea-8086-4d03e3756b3b/uipguoqgwpetw0upvdk5.jpg',
        created_at: '2026-07-12T18:01:00.000Z',
      }])
    }
    if (path === '/api/client/tags' || path === '/api/client/bookings' || path === '/api/client/schedule') return json(route, [])

    return json(route, {})
  })
}

export async function mockAdminApi(page: Page) {
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname

    if (path === '/api/admin/login') return json(route, { token: 'e2e-admin-token' })
    if (path === '/api/admin/verify-provider') return json(route, { ok: true, info: 'Canal verificado' })
    if (path === '/api/admin/stats') {
      return json(route, { totalClients: 1, activeClients: 1, suspendedClients: 0, messagesToday: 3 })
    }
    if (path === '/api/admin/clients') {
      return json(route, [{
        id: 'biz-e2e', slug: 'negocio-e2e', name: 'Negocio E2E', type: 'tienda',
        whatsapp_number: '+593999999999', active: true, bot_active: true,
        suspended: false, plan: 'basic', plan_expires_at: null,
        created_at: '2026-07-11T00:00:00.000Z', notes: null,
      }])
    }

    return json(route, {})
  })
}

export async function seedClientSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({ id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda', takes_bookings: false }))
    localStorage.setItem('client_user', JSON.stringify({ name: 'Dueño E2E', role: 'owner', permissions: [] }))
  })
}

export async function seedAdminSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('admin_token', 'e2e-admin-token')
  })
}

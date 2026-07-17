import { expect, test } from '@playwright/test'
import { expectConnectedLabels, mockClientApi, seedClientSession } from './helpers'

const clientUrl = 'http://127.0.0.1:4173/app/'

test('protege rutas privadas y muestra el login accesible', async ({ page }) => {
  await page.goto(`${clientUrl}#/catalog`)

  await expect(page).toHaveURL(/#\/login$/)
  await expect(page.getByRole('heading', { name: 'Panel de tu negocio' })).toBeVisible()
  await expect(page.getByLabel('Correo')).toBeVisible()
  await expect(page.getByLabel('Contraseña')).toBeVisible()
  await expect(page.locator('label[for="email"]')).toHaveCSS('margin-bottom', '8px')
})

test('inicia sesión y entra al panel del negocio', async ({ page }) => {
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/login`)

  await page.getByLabel('Correo').fill('dueno@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByText('Negocio E2E').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('client_token'))).toBe('e2e-client-token')
})

test('navega en móvil mediante el Sheet de shadcn', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('button', { name: 'Abrir navegación' })).toBeVisible()
  await page.getByRole('button', { name: 'Abrir navegación' }).click()
  await page.getByRole('link', { name: /Catálogo/ }).click()

  await expect(page).toHaveURL(/#\/catalog$/)
  await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible()
  await expect(page.getByText('Producto E2E')).toBeVisible()
})

test('el formulario de catálogo asocia cada etiqueta con su control', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/catalog`)

  await page.getByRole('button', { name: 'Agregar producto' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nuevo producto' })
  await expect(dialog).toBeVisible()
  await expectConnectedLabels(dialog)
})

test('oculta a un empleado las secciones que no tiene permitidas', async ({ page }) => {
  let alertsRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/client/alerts') alertsRequests += 1
  })
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-employee-token')
    localStorage.setItem('client_biz', JSON.stringify({ id: 'biz-e2e', name: 'Negocio E2E', type: 'tienda' }))
    localStorage.setItem('client_user', JSON.stringify({ name: 'Empleado E2E', role: 'employee', permissions: ['conversaciones'] }))
  })
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: 'Conversaciones' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Catálogo/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reportes' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Ajustes' })).toHaveCount(0)
  expect(alertsRequests).toBe(0)
})

test('un negocio normal conserva horarios y no puede abrir reservas', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: 'Horarios' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Reservas' })).toHaveCount(0)
  await page.goto(`${clientUrl}#/bookings`)
  await expect(page).toHaveURL(/#\/schedule$/)
  await expect(page.getByRole('heading', { name: 'Horarios de atención' })).toBeVisible()
  await expect(page.getByText('Duración de cada cita')).toHaveCount(0)
})

test('horarios expone nombres accesibles en controles dinámicos', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({
      id: 'biz-e2e', name: 'Barbería E2E', type: 'barbería', takes_bookings: true,
    }))
    localStorage.setItem('client_user', JSON.stringify({
      name: 'Dueño E2E', role: 'owner', permissions: [],
    }))
  })
  await mockClientApi(page)
  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Barbería E2E', type: 'barbería',
      takes_bookings: true, takes_orders: false,
    }),
  }))
  await page.route('**/api/client/schedule', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      day_of_week: 1,
      open_time: '09:00:00',
      close_time: '18:00:00',
      slot_duration: 60,
      is_active: true,
    }]),
  }))
  await page.goto(`${clientUrl}#/schedule`)

  await expect(page.getByRole('checkbox', { name: 'Lunes' })).toBeChecked()
  await expect(page.getByLabel('Hora de apertura del Lunes')).toHaveValue('09:00')
  await expect(page.getByLabel('Hora de cierre del Lunes')).toHaveValue('18:00')
  await expectConnectedLabels(page.locator('main'))
})

test('un negocio de servicios conserva su nombre aunque no habilite agenda', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({
      id: 'biz-e2e', name: 'Clínica E2E', type: 'clínica', takes_bookings: false,
    }))
    localStorage.setItem('client_user', JSON.stringify({
      name: 'Dueño E2E', role: 'owner', permissions: [],
    }))
  })
  await mockClientApi(page)
  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Clínica E2E', type: 'clínica',
      takes_bookings: false, takes_orders: false,
    }),
  }))
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: /Servicios/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Catálogo/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reservas' })).toHaveCount(0)
})

test('hospedaje muestra configuración segura y conserva controles accesibles', async ({ page }) => {
  let settingsPayload: Record<string, unknown> | null = null
  let availabilityPayload: Record<string, unknown> | null = null
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({
      id: 'biz-e2e', name: 'Complejo E2E', type: 'hotel',
      takes_bookings: false, lodging_enabled: true,
    }))
    localStorage.setItem('client_user', JSON.stringify({
      name: 'Dueño E2E', role: 'owner', permissions: [],
    }))
  })
  await mockClientApi(page)
  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Complejo E2E', type: 'hotel',
      takes_bookings: false, takes_orders: false, lodging_enabled: true,
    }),
  }))
  await page.route('**/api/client/lodging/**', route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (path.endsWith('/settings') && method === 'PUT') {
      settingsPayload = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settingsPayload) })
    }
    if (path.endsWith('/availability') && method === 'POST') {
      availabilityPayload = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nights: 2,
          options: [{
            roomTypeId: 'room-e2e', name: 'Cabaña familiar',
            availableUnits: 3, unitsRequired: 2, maxGuests: 4,
            pricingModel: 'per_unit', currency: 'USD',
            subtotal: 320, tax: 0, fees: 0, total: 320,
          }],
        }),
      })
    }
    const data = path.endsWith('/settings') ? {
      currency: 'USD', check_in_time: '15:00', check_out_time: '11:00',
      quote_expiry_minutes: 15, hold_minutes: 45, tax_rate: 0,
      service_fee: 0, prices_include_tax: true,
    } : path.endsWith('/room-types') ? [{
      id: 'room-e2e', name: 'Cabaña familiar', description: 'Frente al lago',
      amenities: ['Wi-Fi'], media_urls: [], total_units: 3, max_guests: 4,
      pricing_model: 'per_unit', base_occupancy: 4, base_rate: 80,
      weekend_rate: 95, extra_adult_rate: 0, child_rate: 0, active: true,
    }] : []
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  await page.goto(`${clientUrl}#/lodging`)

  await expect(page.getByRole('heading', { name: 'Hospedaje' })).toBeVisible()
  await expect(page.getByText('El bot cotiza; el equipo confirma')).toBeVisible()
  await page.getByRole('tab', { name: 'Habitaciones' }).click()
  await expect(page.getByText('Cabaña familiar')).toBeVisible()
  await page.getByRole('tab', { name: 'Configuración' }).click()
  await expect(page.getByLabel('Retener por (minutos)')).toHaveValue('45')
  await page.getByLabel('Impuesto (%)').fill('12')
  await page.getByRole('button', { name: 'Guardar reglas' }).click()
  await expect.poll(() => settingsPayload).not.toBeNull()
  expect(settingsPayload).toMatchObject({ currency: 'USD', tax_rate: 0.12 })

  await page.getByRole('tab', { name: 'Disponibilidad' }).click()
  await page.getByLabel('Entrada', { exact: true }).fill('2026-08-10')
  await page.getByLabel('Salida', { exact: true }).fill('2026-08-12')
  await page.getByRole('spinbutton', { name: 'Habitaciones', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Adultos', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Niños', exact: true }).fill('1')
  await page.getByRole('button', { name: 'Consultar disponibilidad' }).click()
  await expect.poll(() => availabilityPayload).not.toBeNull()
  expect(availabilityPayload).toEqual({
    check_in: '2026-08-10', check_out: '2026-08-12',
    rooms: 2, adults: 2, children: 1,
  })
  await expect(page.getByText('necesita 2')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const mainOverflow = await page.locator('main').evaluate(element => element.scrollWidth - element.clientWidth)
  expect(mainOverflow).toBeLessThanOrEqual(1)
  await expectConnectedLabels(page.locator('main'))
})

test('el sidebar cliente queda fijo y solo se desplaza el contenido', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(clientUrl)

  const main = page.locator('main')
  const aside = page.locator('aside')
  const topBefore = (await aside.boundingBox())?.y
  await main.evaluate(element => {
    const filler = document.createElement('div')
    filler.style.height = '2200px'
    element.appendChild(filler)
    element.scrollTop = 500
  })

  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect((await aside.boundingBox())?.y).toBe(topBefore)
})

test('reportes renderiza gráficos shadcn sin desbordar en móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/reports`)

  await expect(page.getByRole('heading', { name: 'Reportes del negocio' })).toBeVisible()
  // 7 datasets del mock traen datos (trend, comparación, vendedor, top,
  // consultados, recurrentes, FAQ); los vacíos muestran su estado sin chart.
  await expect(page.locator('[data-slot="chart"]')).toHaveCount(7)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('un pedido se confirma y completa sin generar cobros automáticos', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let orderStatus = 'pendiente'
  let statusPayload: Record<string, unknown> | null = null

  // `**` tras "orders" para cubrir también /orders/:id/status (`*` no cruza `/`).
  await page.route('**/api/client/orders**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/client/orders/order-e2e/status' && route.request().method() === 'PUT') {
      statusPayload = route.request().postDataJSON() as Record<string, unknown>
      const requested = route.request().postDataJSON() as { status: string }
      orderStatus = requested.status
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    if (path === '/api/client/orders' && route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 'order-e2e', contact_phone: '+593999000111', contact_name: 'Cliente pedido',
          status: orderStatus, subtotal: 25, discount: 0, total: 25, currency: 'USD',
          created_at: '2026-07-14T10:00:00.000Z',
          order_items: [{ product_id: 'product-e2e', product_name: 'Producto E2E', quantity: 1, unit_price: 25, line_total: 25 }],
        }]),
      })
    }
    return route.fallback()
  })
  await page.goto(`${clientUrl}#/sales`)
  await page.getByRole('button', { name: 'Confirmar pedido' }).click()
  const confirmDialog = page.getByRole('alertdialog', { name: 'Confirmar pedido' })
  await confirmDialog.getByRole('button', { name: 'Confirmar pedido' }).click()
  await expect.poll(() => statusPayload).toEqual({ status: 'confirmado' })
  await expect(page.getByRole('button', { name: 'Marcar completado' })).toBeVisible()
  await page.getByRole('button', { name: 'Marcar completado' }).click()
  const completeDialog = page.getByRole('alertdialog', { name: 'Completar pedido' })
  await completeDialog.getByRole('button', { name: 'Marcar completado' }).click()
  await expect.poll(() => statusPayload).toEqual({ status: 'completado' })
})

test('conversaciones se adapta a móvil sin desbordamiento horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/conversations`)

  await expect(page.getByText('Cliente móvil').first()).toBeVisible()
  await page.getByText('Cliente móvil').first().click()
  await expect(page.getByText('Hola desde E2E').last()).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
  ))).toBe(true)
  // El panel de mensajes tampoco desborda aunque un mensaje traiga una URL
  // imposible de partir (regresión: barra horizontal en el chat)
  await expect.poll(() => page.evaluate(() => {
    const pane = document.querySelector('div.overflow-y-auto.p-4')
    return pane !== null && pane.scrollWidth <= pane.clientWidth + 1
  })).toBe(true)
})

test('el nombre del contacto y las etiquetas se editan en modales', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let namePayload: unknown = null
  await page.route('**/api/client/sessions/**/name', async (route) => {
    if (route.request().method() === 'PUT') {
      namePayload = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fallback()
  })
  await page.goto(`${clientUrl}#/conversations`)
  await page.getByText('Cliente móvil').first().click()

  // Modal de nombre: accesible, guarda y se cierra
  await page.getByRole('button', { name: 'Nombre', exact: true }).click()
  const nameDialog = page.getByRole('dialog', { name: 'Editar nombre del contacto' })
  await expect(nameDialog).toBeVisible()
  await expectConnectedLabels(nameDialog)
  await nameDialog.getByLabel('Nombre del contacto').fill('Doña Rosa')
  await nameDialog.getByRole('button', { name: 'Guardar' }).click()
  await expect.poll(() => namePayload).toEqual({ name: 'Doña Rosa' })
  await expect(nameDialog).toBeHidden()

  // Modal de etiquetas: accesible y con el formulario de creación
  await page.getByRole('button', { name: 'Etiquetas' }).click()
  const tagsDialog = page.getByRole('dialog', { name: 'Etiquetas del chat' })
  await expect(tagsDialog).toBeVisible()
  await expectConnectedLabels(tagsDialog)
  await expect(tagsDialog.getByText('Aún no tienes etiquetas — crea la primera abajo.')).toBeVisible()
  await expect(tagsDialog.getByRole('button', { name: '+ Crear etiqueta' })).toBeDisabled()
  await tagsDialog.getByRole('button', { name: 'Cerrar' }).click()
  await expect(tagsDialog).toBeHidden()
})

import { expect, test } from '@playwright/test'
import { expectConnectedLabels, mockAdminApi, seedAdminSession } from './helpers'

const adminUrl = 'http://127.0.0.1:4174/app-admin/'

test('protege el dashboard del superadmin', async ({ page }) => {
  await page.goto(`${adminUrl}#/clients`)

  await expect(page).toHaveURL(/#\/login$/)
  await expect(page.getByRole('heading', { name: 'BotPanel — Superadmin' })).toBeVisible()
})

test('el tema oscuro arranca con el theme-boot externo (compatible con el CSP)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bp-theme-admin', 'dark'))
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/`)

  // El HTML servido referencia theme-boot.js y el archivo existe con la key correcta
  const html = await (await page.request.get(adminUrl)).text()
  expect(html).toContain('theme-boot.js')
  const boot = await page.request.get(`${adminUrl}theme-boot.js`)
  expect(boot.ok()).toBe(true)
  expect(await boot.text()).toContain('bp-theme-admin')
  await expect(page.locator('html')).toHaveClass(/dark/)
})

test('inicia sesión y carga datos administrativos simulados', async ({ page }) => {
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/login`)

  await page.getByLabel('Correo').fill('admin@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByText('BotPanel').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('admin_token'))).toBe('e2e-admin-token')
})

test('la tabla de clientes ocupa el contenido y alinea sus acciones', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)

  await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible()
  const card = page.locator('[data-slot="card"]')
  const main = page.locator('main')
  const [cardBox, mainMetrics] = await Promise.all([
    card.boundingBox(),
    main.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        width: element.getBoundingClientRect().width,
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
      }
    }),
  ])
  expect(cardBox).not.toBeNull()
  expect(Math.abs(cardBox!.width - (mainMetrics.width - mainMetrics.padding))).toBeLessThanOrEqual(2)

  const actionButtons = page.locator('tbody tr').first().locator('[data-slot="button"]')
  const heights = await actionButtons.evaluateAll((buttons) => [...new Set(buttons.map(button => button.getBoundingClientRect().height))])
  expect(heights).toEqual([32])
  await expect(actionButtons.first()).toHaveCSS('cursor', 'pointer')
})

test('Medición muestra todos los negocios y alerta visualmente los excesos', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/usage`)

  await expect(page.getByRole('heading', { name: 'Medición' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Medición' })).toHaveClass(/text-primary/)
  await expect(page.getByText('Negocio E2E')).toBeVisible()
  await expect(page.getByText('Límite excedido')).toBeVisible()
  await expect(page.getByText('Límite alcanzado')).toBeVisible()
  await expect(page.getByText('Exceso: +1')).toBeVisible()
  await expect(page.getByText('50%')).toBeVisible()
  await expect(page.getByText('101%')).toBeVisible()
  await expect(page.getByText('100%').first()).toBeVisible()
  await expect(page.getByText('Exceso: +0')).toHaveCount(0)

  const exceededBusiness = page.locator('[data-slot="card"]')
    .filter({ has: page.getByText('Negocio E2E', { exact: true }) })
  const contacts = exceededBusiness.getByRole('progressbar', { name: /Contactos activos/ })
  const messages = exceededBusiness.getByRole('progressbar', { name: /Mensajes enviados/ })
  await expect(contacts).toBeVisible()
  await expect(messages).toBeVisible()
  const [contactsColor, messagesColor] = await Promise.all([
    contacts.locator('[data-slot="progress-indicator"]').evaluate(
      element => getComputedStyle(element).backgroundColor,
    ),
    messages.locator('[data-slot="progress-indicator"]').evaluate(
      element => getComputedStyle(element).backgroundColor,
    ),
  ])
  expect(contactsColor).not.toBe(messagesColor)

  await expect(page.getByText('230', { exact: true })).toBeVisible()
  await expect(page.getByText('30', { exact: true })).toBeVisible()
  await expect(page.getByText('5', { exact: true })).toBeVisible()
  await expect(page.getByText('15', { exact: true })).toBeVisible()
})

test('Medición conserva las barras dentro de una pantalla móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/usage`)

  await expect(page.getByRole('heading', { name: 'Medición' })).toBeVisible()
  await expect.poll(() => page.locator('main').evaluate(element => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true)
})

test('el sidebar admin queda fijo y solo se desplaza el contenido', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)

  const main = page.locator('main')
  const aside = page.locator('aside')
  const topBefore = (await aside.boundingBox())?.y
  await main.evaluate(element => {
    const filler = document.createElement('div')
    filler.style.height = '2200px'
    filler.style.flexShrink = '0'
    element.appendChild(filler)
    element.scrollTop = 500
  })

  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect((await aside.boundingBox())?.y).toBe(topBefore)
})

test('el simulador conserva los controles y la advertencia dentro del móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/simulator`)

  await page.getByRole('combobox', { name: 'Negocio para simular' }).click()
  await page.getByRole('option', { name: 'Negocio E2E' }).click()
  await page.getByRole('button', { name: 'Modo menú' }).click()
  await expect(page.getByText(/pero en WhatsApp este negocio usa/)).toBeVisible()
  await expect.poll(() => page.locator('main').evaluate(element => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true)
})

test('el alta recomienda capacidades seguras según el tipo de negocio', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)
  await page.getByRole('button', { name: 'Nuevo cliente' }).click()

  const dialog = page.getByRole('dialog', { name: 'Nuevo negocio' })
  const businessType = dialog.getByRole('combobox', { name: 'Tipo de negocio' })
  const bookingMode = dialog.getByRole('combobox', { name: 'Agenda del bot' })
  const salesMode = dialog.getByRole('combobox', { name: 'Ventas por el bot' })
  const lodgingMode = dialog.getByRole('combobox', { name: 'Hospedaje' })
  await businessType.click()
  await page.getByRole('option', { name: 'Hotel' }).click()
  await expect(bookingMode).toContainText('Sin agenda')
  await expect(salesMode).toContainText('Solo informa y deriva')
  await expect(lodgingMode).toContainText('Cotiza habitaciones')
  await expect(dialog.getByText('Módulo de hospedaje independiente')).toBeVisible()

  await businessType.click()
  await page.getByRole('option', { name: 'Pizzería' }).click()
  await expect(bookingMode).toContainText('Sin agenda')
  await expect(salesMode).toContainText('Crea pedidos con total oficial')
  await expect(lodgingMode).toContainText('Sin cotización')

  await businessType.click()
  await page.getByRole('option', { name: 'Barbería' }).click()
  await expect(bookingMode).toContainText('Solicita citas')
  await expect(salesMode).toContainText('Solo informa y deriva')
  await expect(lodgingMode).toContainText('Sin cotización')
  await expect(dialog.getByText(/Se creará un horario inicial/)).toBeVisible()

  await dialog.getByRole('combobox', { name: 'Plan' }).click()
  await page.getByRole('option', { name: /Pro — 500/ }).click()
  await expect(dialog.getByLabel('Contactos al mes')).toHaveValue('500')
  await expect(dialog.getByLabel('Mensajes enviados al mes')).toHaveValue('2500')
  await expectConnectedLabels(dialog)
})

test('crea un hotel con hospedaje separado de citas y pedidos', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  let payload: Record<string, unknown> | null = null
  await page.route('**/api/admin/clients', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    payload = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'hotel-e2e', ...payload }),
    })
  })

  await page.goto(`${adminUrl}#/clients`)
  await page.getByRole('button', { name: 'Nuevo cliente' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nuevo negocio' })
  await dialog.getByLabel('Nombre *').fill('Hostal E2E')
  await dialog.getByRole('combobox', { name: 'Tipo de negocio' }).click()
  await page.getByRole('option', { name: 'Hotel' }).click()
  await dialog.getByLabel('WhatsApp del negocio *').fill('+593999000111')
  await dialog.getByLabel('YCloud API Key').fill('ycloud-e2e-key')
  await dialog.getByLabel('Tarifa mensual ($)').fill('39.90')
  await dialog.getByLabel('Correo del dueño (panel)').fill('dueno@e2e.test')
  await dialog.getByLabel('Contraseña del panel').fill('segura-e2e-123')
  await dialog.getByRole('button', { name: 'Crear negocio' }).click()

  await expect.poll(() => payload).not.toBeNull()
  expect(payload).toMatchObject({
    name: 'Hostal E2E',
    type: 'hotel',
    lodging_enabled: true,
    takes_bookings: false,
    takes_orders: false,
  })
})

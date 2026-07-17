import { expect, test } from '@playwright/test'
import { expectConnectedLabels, mockAdminApi, seedAdminSession } from './helpers'

const adminUrl = 'http://127.0.0.1:4174/app-admin/'

test('protege el dashboard del superadmin', async ({ page }) => {
  await page.goto(`${adminUrl}#/clients`)

  await expect(page).toHaveURL(/#\/login$/)
  await expect(page.getByRole('heading', { name: 'BotPanel — Superadmin' })).toBeVisible()
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

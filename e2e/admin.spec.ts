import { expect, test } from './fixtures'
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

// ⚠️ NINGUNA prueba abría el dashboard con sesión, así que llevaba roto sin
// que nadie se enterara: `channel.businesses.length` sobre un `{}` lo dejaba
// sin renderizar. El fixture que falla ante errores de página no sirve de nada
// si nadie entra en la pantalla.
test('el dashboard del superadmin se renderiza entero', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/`)

  // Lo de arriba: las tarjetas de siempre.
  await expect(page.getByText('Negocios')).toBeVisible()
  // Y el recuadro que lo tumbaba, con su contenido.
  await expect(page.getByText('Canal de entrada')).toBeVisible()
  await expect(page.getByText('Negocio E2E').first()).toBeVisible()
})

// Y el gemelo del de arriba: con el mock arreglado, la prueba anterior pasa
// aunque se quite la defensa del componente. Esta devuelve basura a propósito.
// Es el mismo caso que ya tumbó Conversaciones: un dato secundario no puede
// llevarse por delante la pantalla entera.
test('un fallo en la salud del canal no tumba el dashboard', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.route('**/api/admin/channel-health', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }))
  await page.goto(`${adminUrl}#/`)

  // Lo importante sigue en pie; el recuadro del canal simplemente no sale.
  await expect(page.getByText('Negocios')).toBeVisible()
  await expect(page.getByText('Canal de entrada')).toHaveCount(0)
})

test('la tabla de clientes ocupa el contenido y alinea sus acciones', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)

  await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Vencimiento' })).toHaveCount(0)
  await expect(page.getByText('Inicial', { exact: true })).toBeVisible()
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
  const selectBusinessType = async (name: string) => {
    await businessType.click()
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible()
    await listbox.getByRole('option', { name, exact: true }).click()
    await expect(listbox).toBeHidden()
  }
  await selectBusinessType('Hotel')
  await expect(bookingMode).toContainText('Sin agenda')
  await expect(salesMode).toContainText('Solo informa y deriva')

  await selectBusinessType('Pizzería')
  await expect(bookingMode).toContainText('Sin agenda')
  await expect(salesMode).toContainText('Crea pedidos con total oficial')

  await selectBusinessType('Barbería')
  await expect(bookingMode).toContainText('Solicita citas')
  await expect(salesMode).toContainText('Solo informa y deriva')
  await expect(dialog.getByText(/Se creará un horario inicial/)).toBeVisible()

  await dialog.getByRole('combobox', { name: 'Plan' }).click()
  const planListbox = page.getByRole('listbox')
  await expect(planListbox.getByRole('option')).toHaveCount(6)
  await planListbox.getByRole('option', { name: /Pro — \$99\/mes/ }).click()
  await expect(planListbox).toBeHidden()
  await expect(dialog.getByLabel('Tarifa mensual ($)')).toHaveValue('99')
  await expect(dialog.getByLabel('Contactos al mes')).toHaveValue('400')
  await expect(dialog.getByLabel('Mensajes enviados al mes')).toHaveValue('2000')
  await expect(dialog.getByLabel('Tarifa mensual ($)')).toHaveAttribute('readonly', '')
  await expect(dialog.getByLabel('Plan vence')).toHaveCount(0)
  await expectConnectedLabels(dialog)
})

test('Facturación muestra la cuota automática y conserva el cobro manual del pago', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/billing`)

  await expect(page.getByRole('heading', { name: 'Facturación' })).toBeVisible()
  await expect(page.getByText(/Cuotas mensuales generadas automáticamente/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Nuevo registro/ })).toHaveCount(0)
  await expect(page.getByText('Negocio E2E')).toBeVisible()
  await page.getByRole('button', { name: /Marcar pagado: Negocio E2E/ }).click()
  await expect(page.getByText('Cobro marcado como pagado')).toBeVisible()
})

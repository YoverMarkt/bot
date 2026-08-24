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
  // ⚠️ El sujeto es el NÚMERO, no una fila por local: con un solo canal, un
  // semáforo por negocio enseñaba «Sin mensajes» en todos para siempre.
  await expect(page.getByText('Número de Umbani', { exact: true })).toBeVisible()
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

test('el simulador conserva los controles dentro del móvil', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/simulator`)

  // ⚠️ Ya no hay selector de negocio, y esa es la corrección del 2026-08-23:
  // en el marketplace el local lo elige el CLIENTE navegando el menú, no el
  // superadmin de un desplegable. Se puede escribir sin elegir nada.
  await expect(page.getByRole('combobox', { name: 'Negocio para simular' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Simulador del marketplace' })).toBeVisible()
  await expect(page.getByLabel('Mensaje para el bot')).toBeEnabled()
  await expect(page.getByRole('button', { name: /Empezar de cero/ })).toBeVisible()
  await expect.poll(() => page.locator('main').evaluate(element => (
    element.scrollWidth <= element.clientWidth + 1
  ))).toBe(true)
})

// El simulador manda una LISTA de respuestas: el checkout puede contestar dos
// veces seguidas, igual que en WhatsApp.
test('el simulador pinta lo que respondería el número de Umbani', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.route('**/api/admin/simulate', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      replies: [{ reply: '👋 ¡Hola! Bienvenido a *Umbani*.', options: ['🍕 Pizzerías'] }],
      notes: [],
    }),
  }))
  await page.goto(`${adminUrl}#/simulator`)

  await page.getByLabel('Mensaje para el bot').fill('hola')
  await page.getByRole('button', { name: 'Enviar' }).click()

  await expect(page.getByText('Bienvenido a *Umbani*.')).toBeVisible()
  // Las opciones se tocan, como una lista de WhatsApp.
  await expect(page.getByRole('button', { name: '🍕 Pizzerías' })).toBeVisible()
})

test('el alta deduce del tipo cómo va a atender el negocio', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)
  await page.getByRole('button', { name: 'Nuevo cliente' }).click()

  const dialog = page.getByRole('dialog', { name: 'Nuevo negocio' })
  const businessType = dialog.getByRole('combobox', { name: 'Tipo de negocio' })
  const resumenModo = dialog.getByTestId('client-mode-summary')
  const selectBusinessType = async (name: string) => {
    await businessType.click()
    const listbox = page.getByRole('listbox')
    await expect(listbox).toBeVisible()
    await listbox.getByRole('option', { name, exact: true }).click()
    await expect(listbox).toBeHidden()
  }

  // ⚠️ El criterio es cuánto hay que ELEGIR para armar el pedido, no cuántos
  // productos hay. Una pizzería tiene pocos productos pero pedirla es tamaño,
  // masa, borde y dos sabores: eso se arma en la app. Una almuercería son
  // tres platos del día y se piden hablando.
  await selectBusinessType('Pizzería')
  await expect(resumenModo).toContainText('mini app')

  await selectBusinessType('Almuerzos')
  await expect(resumenModo).toContainText('chat')

  await selectBusinessType('Supermercado')
  await expect(resumenModo).toContainText('mini app')

  // ⚠️ El genérico va el ÚLTIMO a propósito: lo que hay que probar es que la
  // recomendación VUELVE a «no vende» después de tipos que sí venden. Con los
  // que venden al final, una recomendación pegada no se notaría.
  await selectBusinessType('Otro / negocio genérico')
  await expect(resumenModo).toContainText('no crea pedidos')
  await expect(dialog.getByText(/Se creará un horario inicial/)).toBeVisible()

  // El plan solo pacta la mensualidad: los cupos se guardan, pero no se
  // enseñan al dar de alta.
  await dialog.getByRole('combobox', { name: 'Plan' }).click()
  const planListbox = page.getByRole('listbox')
  await expect(planListbox.getByRole('option')).toHaveCount(6)
  await planListbox.getByRole('option', { name: /Pro — \$99\/mes/ }).click()
  await expect(planListbox).toBeHidden()
  const resumen = dialog.getByTestId('client-plan-summary')
  await expect(resumen).toContainText('$99/mes')
  await expect(resumen).not.toContainText('contactos')
  await expect(resumen).not.toContainText('mensajes')
  await expect(dialog.getByLabel('Plan vence')).toHaveCount(0)

  // Nada de esto se pregunta ya al crear: sale del tipo, o del marketplace.
  await expect(dialog.getByText('Canal de WhatsApp')).toHaveCount(0)
  await expect(dialog.getByLabel('Quién conduce la conversación')).toHaveCount(0)
  await expect(dialog.getByLabel('IA de este negocio')).toHaveCount(0)
  // ⚠️ «Ventas por el bot» y «Mini app de la tienda» ya no existen en NINGUNA
  // pantalla desde el 2026-08-23: se fundieron en «Aparece en el marketplace»,
  // que sí sale al editar. Los dos nombres hablaban de un bot por local que no
  // existe, y por separado permitían un estado en el que el local «vendía» y
  // ningún cliente podía encontrarlo.
  await expect(dialog.getByLabel('Ventas por el bot')).toHaveCount(0)
  await expect(dialog.getByLabel('Mini app de la tienda')).toHaveCount(0)
  await expect(dialog.getByLabel('Aparece en el marketplace')).toHaveCount(0)
  await expectConnectedLabels(dialog)
})

// La pantalla que más va a usar el superadmin al dar de alta locales nuevos:
// la única decisión que separa un negocio cargado de uno que los clientes
// pueden encontrar.
test('al editar, una sola decisión dice si el local sale en el menú', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)
  await page.getByRole('row', { name: /Negocio E2E/ }).getByRole('button', { name: 'Editar' }).click()

  const dialog = page.getByRole('dialog', { name: 'Editar negocio' })
  await expect(dialog.getByLabel('Nombre *')).toHaveValue('Negocio E2E')

  const visible = dialog.getByRole('combobox', { name: 'Aparece en el marketplace' })
  await expect(visible).toContainText('Sí')
  await expect(dialog.getByTestId('client-marketplace-help')).toContainText('número de Umbani')

  // Ocultarlo tiene que decir QUÉ deja de pasar, no solo cambiar de valor.
  await visible.click()
  const listbox = page.getByRole('listbox')
  await listbox.getByRole('option', { name: /queda oculto/ }).click()
  await expect(listbox).toBeHidden()
  await expect(dialog.getByTestId('client-marketplace-help')).toContainText('No aparece en ninguna categoría')

  // Y lo que se retiró: un local del marketplace no tiene canal que verificar.
  await expect(dialog.getByLabel('WhatsApp del negocio *')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: /Verificar/ })).toHaveCount(0)
  await expectConnectedLabels(dialog)
})

// Las columnas que enseñaban un mundo de «un bot por local». La de WhatsApp
// salía «—» en TODOS los negocios, porque la base les prohíbe tener número.
test('la tabla de clientes no promete un bot ni un canal por local', async ({ page }) => {
  await seedAdminSession(page)
  await mockAdminApi(page)
  await page.goto(`${adminUrl}#/clients`)

  await expect(page.getByRole('columnheader', { name: 'WhatsApp' })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Bot' })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Canal' })).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Marketplace' })).toBeVisible()

  // El que tiene pedidos y tienda se encuentra; el que no, dice por qué no.
  const visible = page.getByRole('row', { name: /Negocio E2E/ })
  await expect(visible.getByText('Visible')).toBeVisible()
  const oculto = page.getByRole('row', { name: /Negocio al límite/ })
  await expect(oculto.getByText('Sin tienda encendida')).toBeVisible()

  // «Verificar conexión» respondía SIEMPRE «Proveedor no reconocido», y
  // «Pausar bot» prometía dejar mudo a un local sin cortar nada.
  await visible.getByRole('button', { name: /Más acciones/ }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Mensaje de bienvenida' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Verificar conexión/ })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /Pausar bot/ })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: /Reanudar bot/ })).toHaveCount(0)
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

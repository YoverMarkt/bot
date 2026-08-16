import { expect, test } from './fixtures'
import {
  expectConnectedLabels, mockClientApi, mockOrdersFilteredByStatus, seedClientSession,
} from './helpers'

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
  // La agenda salió el 2026-08-16: su ruta ya no existe y cae en el inicio.
  await page.goto(`${clientUrl}#/bookings`)
  await expect(page).toHaveURL(/#\/$/)
  await page.goto(`${clientUrl}#/schedule`)
  await expect(page.getByRole('heading', { name: 'Horarios de atención' })).toBeVisible()
  await expect(page.getByText('Duración de cada cita')).toHaveCount(0)
})

test('horarios expone nombres accesibles en controles dinámicos', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('client_token', 'e2e-client-token')
    localStorage.setItem('client_biz', JSON.stringify({
      id: 'biz-e2e', name: 'Barbería E2E', type: 'barbería',
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
      takes_orders: false,
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
      id: 'biz-e2e', name: 'Clínica E2E', type: 'clínica',
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
      takes_orders: false,
    }),
  }))
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: /Servicios/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Catálogo/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Reservas' })).toHaveCount(0)
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

test('un pedido recorre confirmación, preparación y reparto sin generar cobros automáticos', async ({ page }) => {
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
  await page.goto(`${clientUrl}#/orders`)

  // El flujo entero de una pizzería, un paso por pantalla. El refetch desmonta
  // el diálogo en cuanto responde el PUT; dispatchEvent evita que Playwright
  // reintente un click que ya funcionó sobre un nodo retirado.
  const avanzar = async (boton: string, esperado: string) => {
    await page.getByRole('button', { name: boton, exact: true }).click()
    const dialogo = page.getByRole('alertdialog').filter({ hasText: boton })
    await dialogo.getByRole('button', { name: boton, exact: true }).dispatchEvent('click')
    await expect.poll(() => statusPayload).toEqual({ status: esperado })
  }

  // ⚠️ Aceptar y preparar es UN paso desde el 2026-08-08. Eran dos —aceptar y
  // luego poner en preparación— y para una cocina son la misma decisión: quien
  // acepta es quien manda hacerlo. El paso intermedio dejaba al cliente
  // mirando un «aceptado» que no duraba nada.
  await avanzar('Aceptar y preparar', 'preparacion')
  await avanzar('Marcar en camino', 'en_camino')
  await avanzar('Marcar entregado', 'completado')
})

// Regresión del pedido perdido: la alarma existía y era sorda a `orders`.
// Aquí se comprueba que un pedido que entra ESTANDO el panel abierto enciende
// el banner solo, sin recargar, y lleva a donde se atiende.
test('la alarma se enciende sola cuando entra un pedido pendiente', async ({ page }) => {
  test.setTimeout(45_000)   // el panel consulta cada 12 s
  await seedClientSession(page)
  await mockClientApi(page)
  let orders: Record<string, unknown>[] = []

  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Pizzería E2E', type: 'pizzería',
      takes_orders: true,
    }),
  }))
  await mockOrdersFilteredByStatus(page, () => orders)
  await page.goto(clientUrl)

  // Un negocio que recibe pedidos tiene su sección propia en el menú: sin ella
  // los pedidos quedaban escondidos dentro de Ventas y nadie los veía llegar.
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // Sin pedidos pendientes el panel calla (si no, el dueño la silenciaría siempre).
  await expect(page.getByRole('link', { name: 'Conversaciones' })).toBeVisible()
  await expect(page.getByText('¡Nuevo pedido!')).toHaveCount(0)

  orders = [{
    id: 'order-alarma', contact_phone: '+593999000111', contact_name: 'Cliente pedido',
    status: 'pendiente', subtotal: 25, discount: 0, total: 25, currency: 'USD',
    created_at: '2026-08-02T10:00:00.000Z',
  }]

  await expect(page.getByText('¡Nuevo pedido!')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('1 pedido por confirmar')).toBeVisible()
  await page.getByRole('button', { name: 'Atender' }).click()
  await expect(page).toHaveURL(/#\/orders$/)
})

// ── El pedido que se pagó y nadie oyó ──────────────────────────────────────
//
// El caso real del 2026-08-08: el cliente pide por transferencia, sube su
// comprobante y el pedido pasa a `pago_en_revision`. Nunca fue «pendiente»,
// así que la alarma —que solo vigilaba ese estado— no sonó. Cuatro pedidos
// pagados esa noche y ni una campana.
test('la alarma suena cuando llega el comprobante de una transferencia', async ({ page }) => {
  test.setTimeout(45_000)
  await seedClientSession(page)
  await mockClientApi(page)
  let orders: Record<string, unknown>[] = []

  await page.route('**/api/client/business', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: 'biz-e2e', name: 'Pizzería E2E', type: 'pizzería',
      takes_orders: true,
    }),
  }))
  await page.route('**/api/client/orders**', route => {
    const pedidos = new URL(route.request().url()).searchParams.get('status')
    const filtro = pedidos ? pedidos.split(',') : null
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        filtro ? orders.filter(o => filtro.includes(String(o.status))) : orders,
      ),
    })
  })
  await page.goto(clientUrl)
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // Esperando el pago NO suena: el dueño no puede hacer nada hasta que el
  // cliente pague, y una alarma sin trabajo detrás enseña a ignorarla.
  orders = [{
    id: 'order-transferencia', contact_phone: '+593999000222', contact_name: 'Cliente que paga',
    status: 'esperando_pago', subtotal: 12.5, discount: 0, total: 12.5, currency: 'USD',
    created_at: '2026-08-08T04:40:00.000Z',
  }]
  await page.waitForTimeout(14_000)
  await expect(page.getByText('¡Comprobante por revisar!')).toHaveCount(0)
  await expect(page.getByText('¡Nuevo pedido!')).toHaveCount(0)

  // Sube el comprobante: ahora sí hay algo que mirar, y tiene que sonar.
  orders = [{ ...orders[0], status: 'pago_en_revision' }]
  await expect(page.getByText('¡Comprobante por revisar!')).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('1 comprobante por revisar')).toBeVisible()
  await page.getByRole('button', { name: 'Atender' }).click()
  await expect(page).toHaveURL(/#\/orders$/)
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

// ⚠️ REGRESIÓN del 2026-08-15. La lista de bloqueados es una petición más de
// esta pantalla, y cuando devolvió `{}` en vez de una lista, `new Set({})`
// reventó y se llevó por delante la pantalla ENTERA: el dueño se quedó sin
// poder leer a sus clientes por un dato accesorio.
//
// El caso no es teórico ni de laboratorio: pasa con un 502 del proxy, con un
// error de la base, o con un despliegue a medias. Un dato de adorno no puede
// tumbar lo importante.
test('un fallo en la lista de bloqueados no deja la pantalla en blanco', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.route('**/api/client/sessions/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }))
  await page.goto(`${clientUrl}#/conversations`)

  // La conversación se sigue leyendo, que es para lo que existe la pantalla.
  await expect(page.getByText('Cliente móvil').first()).toBeVisible()
  await page.getByText('Cliente móvil').first().click()
  await expect(page.getByText('Hola desde E2E').last()).toBeVisible()
})

// ⚠️ El texto se borraba al enviar y no volvía si el envío fallaba: el dueño
// escribía media pantalla, el canal fallaba —sin saldo, fuera de la ventana de
// 24 h, un 500— y su mensaje desaparecía sin decir nada. Escribirlo otra vez
// de memoria es lo peor que se le puede pedir a quien está atendiendo.
test('si el envío manual falla, el texto vuelve al campo', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.route('**/api/client/sessions/**/send', route => route.fulfill({
    status: 500, contentType: 'application/json', body: '{"error":"Sin saldo en el canal"}',
  }))
  // El campo de escribir solo existe en modo manual, así que la conversación
  // se monta ya así: tomar el control aquí dependería de que el simulador
  // reflejara el cambio, que es otra prueba distinta.
  await page.route('**/api/client/sessions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      contact_phone: '+593999999999',
      contact_name: 'Cliente móvil',
      manual_mode: true,
      unread_owner: false,
      last_message: 'Hola desde E2E',
      last_message_at: '2026-07-12T18:00:00.000Z',
      tags: [],
    }]),
  }))
  await page.goto(`${clientUrl}#/conversations`)

  await page.getByText('Cliente móvil').first().click()

  const campo = page.getByLabel('Mensaje manual')
  await campo.fill('Su pedido sale en veinte minutos')
  await page.getByRole('button', { name: 'Enviar' }).click()

  await expect(campo).toHaveValue('Su pedido sale en veinte minutos')
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

test('el recordatorio de venta solo aparece en conversaciones con actividad reciente', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  const recentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const dormantAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  await page.route('**/api/client/sessions', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { contact_phone: '+593999999999', contact_name: 'Cliente reciente', manual_mode: true, unread_owner: false, last_message: 'Quiero el adaptador', last_message_at: recentAt, tags: [] },
      { contact_phone: '+593888888888', contact_name: 'Cliente dormido', manual_mode: true, unread_owner: false, last_message: 'Hola', last_message_at: dormantAt, tags: [] },
    ]),
  }))
  await page.goto(`${clientUrl}#/conversations`)

  // Chat dormido hace semanas: devolver al bot NO recuerda registrar la venta
  await page.getByText('Cliente dormido').first().click()
  const dormantMode = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/mode'))
  const dormantRefetch = page.waitForResponse(r => r.request().method() === 'GET' && r.url().endsWith('/api/client/sessions'))
  await page.getByRole('button', { name: 'Devolver al bot' }).click()
  await dormantMode
  await dormantRefetch
  await page.waitForTimeout(500)
  await expect(page.getByText('¿Cerraste una venta con este cliente?')).toHaveCount(0)

  // Chat con actividad en las últimas 24 h: sí aparece el recordatorio
  await page.getByText('Cliente reciente').first().click()
  await page.getByRole('button', { name: 'Devolver al bot' }).click()
  await expect(page.getByText('¿Cerraste una venta con este cliente?')).toBeVisible()
  // El recordatorio lleva a Pedidos: desde que se retiró el alta manual, una
  // venta solo nace de un pedido o de una cita. Se busca DENTRO del aviso,
  // porque la propia conversación tiene ya su botón con el mismo nombre.
  await expect(
    page.getByLabel('Notifications alt+T').getByRole('button', { name: 'Registrar pedido' }),
  ).toBeVisible()
})

test('cambiar de sesión no hereda módulos ni datos del negocio anterior', async ({ page }) => {
  await mockClientApi(page)
  // Pedidos es lo que ahora distingue a un negocio de otro: la agenda, que era
  // el módulo que separaba a la barbería, se retiró el 2026-08-16.
  const bizFor = (vende: boolean) => ({
    id: vende ? 'biz-tienda' : 'biz-informa',
    name: vende ? 'Tienda E2E' : 'Consultorio E2E',
    type: vende ? 'tienda' : 'consultorio',
    takes_orders: vende,
  })
  await page.route('**/api/client/login', route => {
    const { email } = route.request().postDataJSON() as { email: string }
    const vende = email.startsWith('tienda')
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        token: vende ? 'token-tienda' : 'token-informa',
        business: bizFor(vende),
        user: { name: 'Dueño E2E', role: 'owner', permissions: [] },
      }),
    })
  })
  await page.route('**/api/client/business', route => {
    const vende = (route.request().headers().authorization || '').includes('token-tienda')
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bizFor(vende)) })
  })

  await page.goto(`${clientUrl}#/login`)
  await page.getByLabel('Correo').fill('tienda@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('link', { name: 'Pedidos' })).toBeVisible()

  // Cambio de negocio SIN recargar: el panel debe entrar limpio
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.getByLabel('Correo').fill('informa@e2e.test')
  await page.getByLabel('Contraseña').fill('segura-e2e')
  await page.getByRole('button', { name: 'Entrar' }).click()

  await expect(page.getByText('Consultorio E2E').first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Pedidos' })).toHaveCount(0)
})

test('el tema oscuro arranca con el theme-boot externo (compatible con el CSP)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bp-theme-client', 'dark'))
  await seedClientSession(page)
  await mockClientApi(page)
  await page.goto(`${clientUrl}#/`)

  // El HTML servido referencia theme-boot.js y el archivo existe con la key correcta
  const html = await (await page.request.get(clientUrl)).text()
  expect(html).toContain('theme-boot.js')
  const boot = await page.request.get(`${clientUrl}theme-boot.js`)
  expect(boot.ok()).toBe(true)
  expect(await boot.text()).toContain('bp-theme-client')
  await expect(page.locator('html')).toHaveClass(/dark/)
})

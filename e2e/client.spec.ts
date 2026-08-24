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
    // ⚠️ Era `conversaciones`, y ese permiso se quedó sin pantalla el
    // 2026-08-23. Se prueba con `catalogo`, que sí abre una sección: lo que
    // fija esta prueba es que un empleado ve SOLO lo suyo, no qué permiso.
    localStorage.setItem('client_user', JSON.stringify({ name: 'Empleado E2E', role: 'employee', permissions: ['catalogo'] }))
  })
  await mockClientApi(page)
  await page.goto(clientUrl)

  await expect(page.getByRole('link', { name: /Catálogo/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Conversaciones' })).toHaveCount(0)
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
      id: 'biz-e2e', name: 'Panadería E2E', type: 'panadería',
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
      id: 'biz-e2e', name: 'Panadería E2E', type: 'panadería',
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

// El test que vivía aquí comprobaba que una clínica veía «Servicios» en vez de
// «Catálogo». Se fue el 2026-08-20 con `isServiceBiz`: retirados los tipos de
// servicios, salud y hospedaje, todo negocio de Umbani tiene catálogo. Lo que
// sí se sigue probando está repartido: que la barra lateral lleva a «Catálogo»
// en la primera prueba del archivo, y que no ofrece Reservas en la de horarios.

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

  // ⚠️ «Conversaciones» se retiró el 2026-08-23: el dueño de un local del
  // marketplace no tiene chats que leer — sus clientes escriben al número de
  // Umbani y esa conversación no pasa por `conversation_history`.
  await expect(page.getByRole('link', { name: 'Conversaciones' })).toHaveCount(0)

  // Sin pedidos pendientes el panel calla (si no, el dueño la silenciaría siempre).
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

// ⚠️ Aquí vivían CINCO pruebas de la pantalla de Conversaciones —el móvil sin
// desbordamiento, el fallo de la lista de bloqueados, el envío manual que
// devuelve el texto, los modales de nombre y etiquetas, y el recordatorio de
// venta—. Se van con la pantalla el 2026-08-23: el dueño de un local del
// marketplace no tiene chats que leer.
//
// La única que seguía protegiendo algo se REESCRIBE justo debajo: el bloqueo
// se mudó a Clientes, y con él la misma forma de romperse.

// ⚠️ REGRESIÓN del 2026-08-15, que sigue viva en su nueva casa. La lista de
// bloqueados es una petición más de la pantalla, y cuando devolvió `{}` en vez
// de una lista, `new Set({})` reventó y se llevó por delante la pantalla
// ENTERA: el dueño se quedó sin poder leer a sus clientes por un dato
// accesorio.
//
// El caso no es teórico ni de laboratorio: pasa con un 502 del proxy, con un
// error de la base, o con un despliegue a medias. Un dato de adorno no puede
// tumbar lo importante.
test('un fallo en la lista de bloqueados no deja Clientes en blanco', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  await page.route('**/api/client/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }))
  await page.goto(`${clientUrl}#/customers`)

  // El directorio se sigue leyendo, que es para lo que existe la pantalla.
  await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible()
  await expect(page.getByText('Cliente E2E').first()).toBeVisible()
})

// El bloqueo es la única defensa del dueño frente a quien pide para molestar,
// y se mudó de Conversaciones a Clientes con la pantalla que lo alojaba.
test('desde Clientes se puede bloquear y desbloquear', async ({ page }) => {
  await seedClientSession(page)
  await mockClientApi(page)
  let bloqueados: string[] = []
  await page.route('**/api/client/blocked', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(bloqueados),
  }))
  await page.route('**/api/client/blocked/*', route => {
    bloqueados = ['593999000111']
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ blocked: true }),
    })
  })
  await page.goto(`${clientUrl}#/customers`)

  await page.getByRole('button', { name: /Bloquear a Cliente E2E/ }).click()
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
  await expect(page.getByText('Cliente bloqueado')).toBeVisible()
  // Y al recargar la lista sale marcado, con su salida a mano.
  await expect(page.getByRole('button', { name: /Desbloquear/ }).first()).toBeVisible()
})


test('cambiar de sesión no hereda módulos ni datos del negocio anterior', async ({ page }) => {
  await mockClientApi(page)
  // Pedidos es lo que ahora distingue a un negocio de otro: la agenda, que era
  // el otro módulo que los separaba, se retiró el 2026-08-16.
  const bizFor = (vende: boolean) => ({
    id: vende ? 'biz-tienda' : 'biz-informa',
    name: vende ? 'Tienda E2E' : 'Negocio E2E',
    type: vende ? 'tienda' : 'negocio',
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

  await expect(page.getByText('Negocio E2E').first()).toBeVisible()
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

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL ALTA DE UN LOCAL
//
// Pedía 21 campos para crear una pizzería que se atiende por el número de la
// plataforma. Se queda con los que de verdad hacen falta; el resto sigue vivo
// en la EDICIÓN, que es donde se usa el caso raro.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(
  fileURLToPath(new URL(ruta, import.meta.url)),
  'utf8',
)

describe('el modo de atención ya no se elige a mano en el alta', () => {
  const ruta = readFileSync(
    fileURLToPath(new URL('../../server/src/routes/admin-clients.routes.ts', import.meta.url)),
    'utf8',
  )

  it('`ai` ya no está entre los modos aceptados', () => {
    // La base solo acepta ('menu','miniapp') desde el 2026-08-21. Que la ruta
    // siguiera nombrando 'ai' no era cosmético: ver el test de abajo.
    const linea = ruta.match(/const CHAT_MODES = \[[^\]]*\]/)?.[0] || ''
    expect(linea).toContain("'menu'")
    expect(linea).toContain("'miniapp'")
    expect(linea).not.toContain("'ai'")
  })

  it('un alta sin `chat_mode` cae en `menu`, nunca en `ai`', () => {
    // ⚠️ EL BUG: el fallback era `'ai'`, que el CHECK de la base rechaza, así
    // que `create_business_onboarding` abortaba y el negocio NO se creaba.
    // Desde el panel no saltaba porque el modal siempre manda uno válido;
    // por API, cualquier alta sin el campo reventaba.
    const bloque = ruta.match(/chat_mode: CHAT_MODES\.includes[\s\S]{0,200}?,\n/)?.[0] || ''
    expect(bloque).toContain("'menu'")
    expect(bloque).not.toMatch(/:\s*'ai'/)
  })

  it('el defecto es `menu` y no `miniapp`, que exige tienda', () => {
    // `migration-2026-08-19-miniapp-exige-tienda.sql`: el modo mini app no se
    // enciende sin pedidos Y tienda. De defecto dejaría mudo a un negocio sin
    // ellos; el menú atiende con cualquier catálogo.
    expect(ruta).toMatch(/chat_mode: CHAT_MODES\.includes[\s\S]{0,200}?'menu'/)
  })
})

describe('la IA de este negocio se retira del alta', () => {
  it('el modal ya no la pide', () => {
    const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')
    // La IA conversacional se retiró el 2026-08-21: el campo no decidía nada.
    expect(modal).not.toContain('ai_provider')
    expect(modal).not.toContain('IA de este negocio')
  })

  it('la ruta ya no la acepta ni la guarda', () => {
    const ruta = leer('../src/routes/admin-clients.routes.ts')
    expect(ruta).not.toContain('ai_provider')
  })

  it('pero el ajuste GLOBAL sigue: transcripción y visión lo usan', () => {
    // ⚠️ Son dos cosas distintas y solo sobraba la del negocio.
    // `settings.get('ai_provider')` elige el motor de Whisper y de visión.
    // Soltar la columna obligaría además a recrear el onboarding entero.
    const settings = leer('../src/services/settings.ts')
    const ai = leer('../src/services/ai.ts')
    expect(settings).toContain("'ai_provider'")
    expect(ai).toContain("settings.get('ai_provider')")
  })
})

describe('lo que el alta deja de preguntar', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  /** El bloque solo se pinta al editar si está envuelto en `{id && (`. */
  const soloAlEditar = (marca) => {
    const desde = modal.lastIndexOf('{id && (', modal.indexOf(marca))
    const hasta = modal.indexOf(marca)
    return desde !== -1 && hasta > desde
  }

  it('el canal propio: un local NACE en el marketplace', () => {
    // Siete campos (proveedor, número, 3 de YCloud, 2 de Meta, Telegram) para
    // credenciales de una cuenta que ese local no va a tener nunca.
    expect(soloAlEditar('Canal de WhatsApp')).toBe(true)
  })

  it('el modo: lo deduce el tipo, y en el marketplace el catálogo', () => {
    // Al crear, el negocio tiene CERO productos: la regla de los 20 no se
    // puede evaluar todavía, así que preguntarlo sería inventar el dato.
    expect(soloAlEditar('Quién conduce la conversación')).toBe(true)
  })

  it('los tres derivados del plan pasan a una línea de resumen', () => {
    // Eran inputs `readOnly`: nadie podía tocarlos porque salen del plan.
    expect(modal).not.toContain('client-monthly-rate')
    expect(modal).not.toContain('client-contact-limit')
    expect(modal).not.toContain('client-outbound-limit')
    expect(modal).toContain('client-plan-summary')
  })

  it('pero el PAYLOAD sigue enviando los mismos valores del plan', () => {
    // Que dejen de ser campos no puede cambiar lo que se guarda.
    expect(modal).toContain('payload.monthly_rate')
    expect(modal).toContain('payload.monthly_contact_limit')
    expect(modal).toContain('payload.monthly_outbound_message_limit')
  })
})

describe('lo que el alta SIGUE pidiendo', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  it('los ocho campos que hacen falta para crear un local', () => {
    for (const campo of [
      'client-name',              // sin nombre no hay negocio
      'client-business-type',     // decide plantilla, prep_time, familia y modo
      'client-owner-phone',       // el ÚNICO número del local en marketplace
      'client-sales-mode',        // takes_orders
      'client-storefront',        // storefront_enabled
      'client-plan',              // tarifa y cupos
      'client-owner-email',       // acceso al panel
      'client-owner-password',
      'client-internal-notes',
    ]) {
      expect(modal, `falta ${campo}`).toContain(campo)
    }
  })

  it('el WhatsApp del dueño sigue siendo obligatorio en el marketplace', () => {
    // Es con lo que pide sus reportes: sin él nace sin forma de alcanzarlo.
    expect(modal).toMatch(/sinCanalPropio && !id && !f\.owner_phone/)
  })

  it('y la edición conserva el canal completo, intacto', () => {
    // Nada se pierde: un negocio con número propio se configura al editar.
    for (const campo of [
      'client-ycloud-api-key',
      'client-ycloud-endpoint-id',
      'client-ycloud-signing-secret',
      'client-meta-token',
      'client-meta-phone-id',
      'client-telegram-token',
    ]) {
      expect(modal, `se perdió ${campo}`).toContain(campo)
    }
  })
})

describe('con qué modo NACE cada tipo de negocio', () => {
  const tipos = leer('../../apps/admin/src/features/clients/business-types.ts')
  const lista = tipos.match(/const PEDIDO_SIMPLE = \[[\s\S]*?\]/)?.[0] || ''

  it('el criterio es cuánto hay que ELEGIR, no cuántos productos hay', () => {
    // ⚠️ Corrección del dueño (2026-08-22). El primer intento clasificó por
    // número de productos y mandó la pizzería al chat: pocos productos, sí,
    // pero pedirla es tamaño, masa, borde y dos sabores. Eso en una lista de
    // WhatsApp es penoso; en la mini app es un momento.
    expect(tipos).toContain('PEDIDO_SIMPLE')
    expect(tipos).not.toContain('CATALOGO_LARGO')
  })

  it('una almuercería y una cevichería piden por el CHAT', () => {
    // Tres o cuatro platos del día: se eligen hablando.
    for (const simple of ['almuerzos', 'comida típica', 'marisquería', 'desayunos']) {
      expect(lista, `${simple} debería pedir por el chat`).toContain(`'${simple}'`)
    }
  })

  it('una pizzería y una heladería piden por la MINI APP', () => {
    // Hay bastante que elegir en cada producto: sabores, tamaños, extras.
    for (const armado of ['pizzería', 'heladería', 'hamburguesería', 'sushi']) {
      expect(lista, `${armado} NO debería pedir por el chat`).not.toContain(`'${armado}'`)
    }
  })

  it('el retail también va a la app', () => {
    for (const retail of ['supermercado', 'farmacia', 'ferretería', 'tienda']) {
      expect(lista).not.toContain(`'${retail}'`)
    }
  })

  it('un tipo SIN clasificar cae en la mini app, que nunca es inusable', () => {
    // Falla hacia lo seguro: la tienda atiende cualquier catálogo, mientras
    // que un menú de chat mal elegido deja al cliente en listas interminables.
    expect(tipos).toMatch(/return simple \? 'menu' : 'miniapp'/)
  })

  it('sin pedidos no hay menú de compra: el genérico cae en `menu`', () => {
    expect(tipos).toMatch(/recommendedSalesForBusinessType\(type\) !== 'vende'\) return 'menu'/)
  })

  it('sigue siendo solo una RECOMENDACIÓN al crear', () => {
    expect(tipos).toMatch(/solo PROPONE al crear/i)
  })
})

describe('el alta ya no pregunta lo que se deduce del tipo', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  it('«Ventas por el bot» y «Mini app de la tienda» son solo de edición', () => {
    // Dos decisiones (`takes_orders` y `storefront_enabled`) que salen de lo
    // mismo: el tipo de negocio. En el alta se explican en una línea.
    const desde = modal.indexOf('{id ? (')
    const ventas = modal.indexOf('client-sales-mode')
    const tienda = modal.indexOf('client-storefront')
    expect(desde).toBeGreaterThan(-1)
    expect(ventas).toBeGreaterThan(desde)
    expect(tienda).toBeGreaterThan(desde)
  })

  it('en su lugar dice cómo va a atender', () => {
    expect(modal).toContain('client-mode-summary')
    expect(modal).toContain('chatModeSummary')
  })

  it('y el resumen lo explica en español, sin jerga', () => {
    const tipos = leer('../../apps/admin/src/features/clients/business-types.ts')
    expect(tipos).toMatch(/Pedirá por el chat/)
    expect(tipos).toMatch(/Pedirá por su mini app/)
  })
})

describe('el plan solo pacta la mensualidad', () => {
  const modal = leer('../../apps/admin/src/features/clients/ClientModal.tsx')

  it('ni el desplegable ni el resumen enseñan cupos', () => {
    // Los cupos se siguen guardando y Medición alerta los excesos; lo que se
    // pacta al dar de alta es la mensualidad y nada más.
    expect(modal).not.toContain('monthlyContactLimit.toLocaleString')
    expect(modal).not.toContain('contactos')
    expect(modal).not.toMatch(/\}\s*mensajes/)
  })

  it('pero el payload los sigue enviando', () => {
    expect(modal).toContain('payload.monthly_contact_limit')
    expect(modal).toContain('payload.monthly_outbound_message_limit')
  })
})

describe('el número del marketplace se puede verificar', () => {
  it('el panel tiene su botón', () => {
    const panel = leer('../../apps/admin/src/features/settings/ServerSettings.tsx')
    expect(panel).toContain('Verificar el número')
    expect(panel).toContain('verifyPlatformChannel')
  })

  it('y el servidor comprueba el número contra YCloud', () => {
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toContain('/api/admin/verify-platform-channel')
    // Reutiliza la MISMA comprobación que un negocio con canal propio: el
    // canal es el mismo, solo cambia de dónde salen las credenciales.
    expect(ruta).toMatch(/verify-platform-channel[\s\S]{0,2000}?verifyProvider\(\{/)
  })

  it('le pasa el secreto y el endpoint de PLATAFORMA a la comprobación', () => {
    // ⚠️ El bug del 2026-08-22: `verifyProvider` mira `ycloud_webhook_*` —los
    // campos del NEGOCIO—, así que sin pasárselos decía «falta Signing Secret
    // y Endpoint ID» aunque estuvieran guardados en `platform_webhook_*`. El
    // resultado salía en rojo justo cuando la configuración era correcta.
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    const bloque = ruta.match(
      /verify-platform-channel[\s\S]*?verifyProvider\(\{[\s\S]*?\}\)/,
    )?.[0] || ''
    expect(bloque).toContain('ycloud_webhook_secret: secret')
    expect(bloque).toContain('ycloud_webhook_endpoint_id: endpoint')
  })

  it('avisa de lo que YCloud no puede decir: falta el webhook', () => {
    // Sin signing secret ni endpoint id, el webhook rechaza en producción y
    // el número queda mudo aunque la key sea correcta.
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toContain('Signing Secret')
    expect(ruta).toContain('Endpoint ID')
    expect(ruta).toMatch(/el bot no recibirá mensajes/)
  })

  it('exige autenticación de superadmin', () => {
    const ruta = leer('../src/routes/admin-providers.routes.ts')
    expect(ruta).toMatch(/verify-platform-channel', auth\.authAdmin/)
  })
})

describe('rechazar el comprobante avisa al cliente', () => {
  const ruta = leer('../src/routes/orders.routes.ts')

  it('se le manda un WhatsApp pidiendo otra foto', () => {
    // ⚠️ Hasta el 2026-08-22 no se avisaba. En la mini app el cliente lo veía
    // al recargar la pantalla de pago; quien pidió por el CHAT no se enteraba
    // nunca y se quedaba esperando un pedido devuelto a «esperando pago».
    expect(ruta).toContain('avisarQueFaltaOtroComprobante')
    expect(ruta).toMatch(/No pudimos leer tu comprobante/)
  })

  it('el mensaje dice QUÉ tiene que verse, no solo «manda otra»', () => {
    // Sin decirle qué falta, la segunda foto suele salir igual de mal.
    expect(ruta).toMatch(/valor/)
    expect(ruta).toMatch(/fecha/)
    expect(ruta).toMatch(/banco/)
  })

  it('y lleva el importe exacto del pedido', () => {
    expect(ruta).toMatch(/Number\(pedido\.total \|\| 0\)\.toFixed\(2\)/)
  })

  it('nunca lanza: el pedido ya volvió a esperar pago', () => {
    // Un fallo de envío no puede tumbar la respuesta al dueño, que ya hizo
    // lo que pidió.
    const bloque = ruta.match(
      /async function avisarQueFaltaOtroComprobante[\s\S]*?\n}/,
    )?.[0] || ''
    expect(bloque).toContain('try {')
    expect(bloque).toContain('catch')
  })

  it('sale sin await, como el resto de avisos', () => {
    expect(ruta).toMatch(/void avisarQueFaltaOtroComprobante/)
  })
})

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

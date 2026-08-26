import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL BOTÓN DE REEMPLAZAR TIENE QUE SER ALCANZABLE
//
// Estuvo CONSTRUIDO Y DESCONECTADO: la ruta `PUT /api/admin/pricing-rules/:id`,
// el repositorio `replacePricingRule`, la mutación del panel y hasta el estado
// `reemplazando` existían… y `setReemplazando` solo se llamaba con `null`. No
// había forma de activarlo desde ninguna pantalla.
//
// Lo encontró el dueño preguntando cómo se cambia el porcentaje: el servidor le
// respondía «Reemplázala en vez de crear otra» y ese botón no existía.
//
// Por qué importa que sea UNA operación: solo puede haber una regla activa por
// destino (`idx_pricing_rules_activa_*`), así que sin reemplazo hay que
// archivar y luego crear — y entre los dos pasos la plataforma se queda SIN
// regla, cobrando sin margen a quien pida en ese hueco.
// ═══════════════════════════════════════════════════════════════════════════

const PANEL = readFileSync(
  fileURLToPath(new URL('../../apps/admin/src/features/pricing/Finance.tsx', import.meta.url)), 'utf8')
const RUTA = readFileSync(
  fileURLToPath(new URL('../src/routes/admin-pricing.routes.ts', import.meta.url)), 'utf8')
const REPO = readFileSync(
  fileURLToPath(new URL('../src/db/repositories/pricing-rules.ts', import.meta.url)), 'utf8')

describe('reemplazar una regla', () => {
  // ⚠️ EL FALLO EXACTO: que `setReemplazando` solo se llame con `null`.
  it('algo activa el modo reemplazo con un id, no solo con null', () => {
    const llamadas = [...PANEL.matchAll(/setReemplazando\(([^)]*)\)/g)].map(m => m[1].trim())
    expect(llamadas.length).toBeGreaterThan(0)
    expect(
      llamadas.some(a => a !== 'null'),
      'setReemplazando solo se llama con null: el modo reemplazo es inalcanzable',
    ).toBe(true)
  })

  it('hay un botón que carga la regla en el formulario', () => {
    expect(PANEL).toMatch(/onClick=\{\(\) => cargarParaReemplazar\(r\)\}/)
    expect(PANEL).toMatch(/Reemplazar/)
  })

  it('el formulario guarda por el camino de reemplazo cuando toca', () => {
    expect(PANEL).toMatch(/reemplazando\s*\n?\s*\?\s*replacePricingRule\(reemplazando, borrador\)/)
  })

  // El camino entero tiene que existir, no solo el botón.
  it('la ruta y el repositorio siguen ahí', () => {
    expect(RUTA).toMatch(/router\.put\('\/api\/admin\/pricing-rules\/:id'/)
    expect(REPO).toMatch(/const replacePricingRule = async/)
  })

  // ⚠️ Reemplazar NO edita en sitio: crea una versión nueva y archiva la
  // anterior. Los pedidos ya sellados apuntan a la versión que les tocó, y
  // editar en sitio haría que un pedido de ayer dijera que se le cobró lo de
  // hoy.
  it('archiva la anterior y sube la versión, en vez de editar', () => {
    const fn = REPO.slice(REPO.indexOf('const replacePricingRule'))
    expect(fn).toMatch(/status: 'archived'/)
    expect(fn).toMatch(/version: Number\(anterior\?\.version \|\| 0\) \+ 1/)
    expect(fn, 'el archivado va PRIMERO o el índice único rechaza la nueva')
      .toMatch(/status: 'archived'[\s\S]*\.insert\(/)
  })

  // El modelo del negocio es `on_top` desde el 2026-08-25: el formulario debe
  // proponerlo, no el modo que le descuenta el margen al dueño.
  it('el formulario nace en on_top', () => {
    const inicial = PANEL.slice(PANEL.indexOf('const BORRADOR_INICIAL'), PANEL.indexOf('export default'))
    expect(inicial).toMatch(/markup_mode: 'on_top'/)
  })
})

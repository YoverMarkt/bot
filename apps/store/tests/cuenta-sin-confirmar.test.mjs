import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// «MIS PEDIDOS» CON UN ENLACE SIN CONFIRMAR PIDE EL NÚMERO, NO FALLA
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-09-25, en el repaso de todas las pantallas: abriendo el enlace en otro
// teléfono, «Mis pedidos» decía «No pudimos cargar tus pedidos». No era un
// fallo: el servidor contestaba que faltaba confirmar el número, y el resto de
// la tienda ya lo convertía en la pantalla de confirmar. Esta se lo tragaba.
//
// Se lee el código en vez de montarlo: la tienda prueba sus componentes sin
// navegador, y el efecto que carga los pedidos solo corre dentro de uno.

const leer = (ruta) => readFileSync(new URL(ruta, import.meta.url), 'utf8')

describe('la cuenta usa la misma puerta que el resto de la tienda', () => {
  it('los pedidos que no cargan pasan primero por onFalloEnlace', () => {
    const cuenta = leer('../src/screens/Account.tsx')
    const carga = cuenta.slice(cuenta.indexOf('getOrders(slug)'))
    const puerta = carga.indexOf('onFalloEnlace(fallo)')
    const error = carga.indexOf("setError('No pudimos cargar tus pedidos')")
    expect(puerta).toBeGreaterThan(-1)
    // La puerta va ANTES: solo si no era cosa del enlace se enseña el error.
    expect(puerta).toBeLessThan(error)
  })

  it('la tienda le pasa esa puerta a la cuenta', () => {
    const tienda = leer('../src/screens/FoodStore.tsx')
    const cuenta = tienda.slice(tienda.indexOf('<Account'), tienda.indexOf('/>', tienda.indexOf('<Account')))
    expect(cuenta).toContain('onFalloEnlace={onFalloEnlace}')
  })
})

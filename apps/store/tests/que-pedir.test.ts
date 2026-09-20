import { describe, expect, it } from 'vitest'
import { quePedir } from '../src/lib/que-pedir'

const base = {
  hayLineas: true,
  sinSesion: false,
  yaAvisamosDeLaSesion: false,
  yaPedimosDireccion: false,
  entrega: 'delivery' as const,
  tieneDirecciones: false,
}

describe('qué se le pide al cliente', () => {
  it('con el carrito vacío, nada: pedir antes sería un peaje', () => {
    expect(quePedir({ ...base, hayLineas: false })).toBe('nada')
  })

  it('sin sesión, el número va primero', () => {
    // Sin sesión no hay dirección que guardar: el servidor la rechazaría.
    expect(quePedir({ ...base, sinSesion: true })).toBe('sesion')
  })

  it('sin dirección guardada, la dirección', () => {
    expect(quePedir(base)).toBe('direccion')
  })

  it('con dirección guardada, nada', () => {
    expect(quePedir({ ...base, tieneDirecciones: true })).toBe('nada')
  })

  it('quien retira en el local no da dirección', () => {
    expect(quePedir({ ...base, entrega: 'pickup' })).toBe('nada')
  })

  it('mientras `/me` no contesta no se pide nada, y NO se gasta el turno', () => {
    expect(quePedir({ ...base, tieneDirecciones: null })).toBe('nada')
  })

  it('cada cosa se pide UNA vez por visita', () => {
    expect(quePedir({ ...base, sinSesion: true, yaAvisamosDeLaSesion: true })).toBe('nada')
    expect(quePedir({ ...base, yaPedimosDireccion: true })).toBe('nada')
  })

  // ── El fallo que costó dos rondas de pruebas en staging ─────────────────
  it('pedir el número NO gasta el turno de pedir la dirección', () => {
    // El cliente NUEVO: se le pide el número, lo confirma, y entonces sí toca
    // la dirección. Con una sola marca compartida, este caso devolvía 'nada' y
    // el cliente no veía la pantalla de dirección NUNCA.
    const nuevo = { ...base, sinSesion: true }
    expect(quePedir(nuevo)).toBe('sesion')

    const yaConfirmoSuNumero = {
      ...nuevo,
      sinSesion: false,
      yaAvisamosDeLaSesion: true,
      tieneDirecciones: false,
    }
    expect(quePedir(yaConfirmoSuNumero)).toBe('direccion')
  })

  it('da igual el producto: lo que cambiaba era el TIEMPO', () => {
    // Con un plato que se arma, `/me` contesta 401 ANTES de agregar, así que
    // se entra por la rama de la sesión. Con uno suelto se agrega antes de que
    // conteste. Los dos caminos tienen que acabar pidiendo la dirección.
    const armado = quePedir({ ...base, sinSesion: true })
    expect(armado).toBe('sesion')
    expect(quePedir({ ...base, yaAvisamosDeLaSesion: true })).toBe('direccion')

    const suelto = quePedir({ ...base, tieneDirecciones: null })
    expect(suelto).toBe('nada')
    expect(quePedir(base)).toBe('direccion')
  })
})

import { describe, expect, it } from 'vitest'
import { leerPunto, verEnElMapa, rutaDeReparto, MENSAJE_DEL_PUNTO } from '../src/lib/ubicacion'

// ═══════════════════════════════════════════════════════════════════════════
// EL PUNTO DEL LOCAL, LEÍDO DEL ENLACE QUE PEGA EL DUEÑO
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Este parser vive en el NAVEGADOR a propósito: hacer que el servidor siga
// una URL pegada por un usuario es el agujero que se llama SSRF. Es decir, la
// única defensa de ese lado es que esto funcione bien aquí.
//
// Hasta hoy no tenía una sola prueba, y es de lo más delicado del panel: si lee
// mal un punto, el repartidor sale hacia otro sitio.

describe('leerPunto', () => {
  it('lee el sitio concreto (!3d!4d), que es el que manda', () => {
    // El formato de un enlace de Google Maps con el local seleccionado: trae el
    // centro del mapa (@) Y el sitio (!3d!4d), y el segundo es el bueno.
    const url = 'https://www.google.com/maps/place/Monster+Pizza/@-1.0500000,-80.4500000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-1.0661434!4d-80.4670130'
    const r = leerPunto(url)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.punto.latitude).toBe(-1.0661434)
      expect(r.punto.longitude).toBe(-80.467013)
    }
  })

  it('cae al centro del mapa (@) cuando no hay sitio', () => {
    const r = leerPunto('https://www.google.com/maps/@-1.0546,-80.4547,17z')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.punto).toEqual({ latitude: -1.0546, longitude: -80.4547 })
  })

  it('lee un ?q= o ?ll= explícito', () => {
    for (const url of [
      'https://maps.google.com/?q=-1.0546,-80.4547',
      'https://maps.google.com/?ll=-1.0546,-80.4547&z=17',
    ]) {
      const r = leerPunto(url)
      expect(r.ok, url).toBe(true)
    }
  })

  it('acepta coordenadas pegadas a mano', () => {
    const r = leerPunto('-1.0661434, -80.467013')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.punto.latitude).toBe(-1.0661434)
  })

  it('⚠️ el enlace CORTO se reconoce y se explica', () => {
    // Los `maps.app.goo.gl` NO llevan el punto dentro. Decir «no se pudo leer»
    // a secas es lo que convierte un error en abandono: hay que decir QUÉ HACER.
    for (const url of [
      'https://maps.app.goo.gl/abc123',
      'https://goo.gl/maps/xyz789',
    ]) {
      const r = leerPunto(url)
      expect(r.ok, url).toBe(false)
      if (!r.ok) expect(r.motivo).toBe('enlace_corto')
    }
    expect(MENSAJE_DEL_PUNTO.enlace_corto).toContain('Ábrelo en el navegador')
  })

  it('⚠️ rechaza coordenadas fuera del mapa', () => {
    // «Revisa que no falte un signo menos»: el error real del dueño.
    const r = leerPunto('-91.5, -80.4')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('fuera_de_rango')
  })

  it('un texto sin coordenadas lo dice, y vacío es vacío', () => {
    expect(leerPunto('mi local está frente al parque')).toEqual({ ok: false, motivo: 'sin_coordenadas' })
    expect(leerPunto('')).toEqual({ ok: false, motivo: 'vacio' })
    expect(leerPunto('   ')).toEqual({ ok: false, motivo: 'vacio' })
  })

  it('redondea a siete decimales, que es lo que guarda la columna', () => {
    const r = leerPunto('-1.06614341234567, -80.46701312345')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.punto.latitude).toBe(-1.0661434)
  })

  it('cada motivo tiene un mensaje que dice qué hacer', () => {
    for (const motivo of ['enlace_corto', 'sin_coordenadas', 'fuera_de_rango'] as const) {
      expect(MENSAJE_DEL_PUNTO[motivo].length, motivo).toBeGreaterThan(30)
    }
  })
})

describe('los enlaces de mapa no cuestan un centavo', () => {
  // ⚠️ Ni «cómo llegar» ni «ver en el mapa» llevan API key: son URLs normales
  // que abren la app de mapas del teléfono. Lo que se paga es DIBUJAR un mapa
  // dentro de nuestra app, y eso no se hace aquí.
  const punto = { latitude: -1.0546, longitude: -80.4547 }

  it('ver en el mapa apunta al punto y sin key', () => {
    const url = verEnElMapa(punto)
    expect(url).toContain('-1.0546')
    expect(url).toContain('-80.4547')
    expect(url.toLowerCase()).not.toContain('key=')
  })

  it('la ruta lleva los DOS extremos: de dónde sale y a dónde va', () => {
    const url = rutaDeReparto(punto, { latitude: -1.06, longitude: -80.46 })
    expect(url, String(url)).toBeTruthy()
    expect(String(url)).toContain('-1.0546')
    expect(String(url)).toContain('-1.06')
    expect(String(url).toLowerCase()).not.toContain('key=')
  })

  it('sin uno de los dos extremos NO inventa una ruta', () => {
    // Una ruta con un solo punto es un destino sin origen, que es lo que ya
    // se tenía. Un local sin punto se queda con el pin del cliente.
    expect(rutaDeReparto(null, { latitude: -1.06, longitude: -80.46 })).toBe(null)
    expect(rutaDeReparto(punto, null)).toBe(null)
  })
})

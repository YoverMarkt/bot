import { describe, expect, it } from 'vitest'
import { leerPunto, verEnElMapa, MENSAJE_DEL_PUNTO } from '../../client/src/lib/ubicacion'

// ═══════════════════════════════════════════════════════════════════════════
// DE UN ENLACE DE GOOGLE MAPS A UN PUNTO
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño de un local no sabe cuáles son sus coordenadas, y no tiene por qué:
// lo que sí sabe es buscar su negocio en Google Maps y tocar «Compartir». Esta
// es la pieza que convierte eso en un punto, y la que más puede fallar en sus
// manos — de ahí que tenga más pruebas que el resto.
//
// ⚠️ Se resuelve en el NAVEGADOR, no en el servidor. Un enlace pegado es una
// URL arbitraria: hacer que el servidor la siga sería pedirle peticiones a
// donde diga un usuario, que es el agujero llamado SSRF.

describe('leer el punto de lo que pegue el dueño', () => {
  it('saca el punto del enlace largo de Maps', () => {
    const r = leerPunto('https://www.google.com/maps/@-1.0661434,-80.4670130,17z')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.punto).toEqual({ latitude: -1.0661434, longitude: -80.467013 })
  })

  // ⚠️ El `@` es el CENTRO DEL MAPA; `!3d!4d` es el SITIO. Cuando Maps trae
  // los dos, el bueno es el segundo: el centro puede estar desplazado si el
  // dueño movió el mapa antes de compartir.
  it('con centro Y sitio, gana el SITIO', () => {
    const url = 'https://www.google.com/maps/place/La+Abuelita/@-1.05,-80.40,17z/'
      + 'data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-1.0661434!4d-80.4670130'
    const r = leerPunto(url)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.punto).toEqual({ latitude: -1.0661434, longitude: -80.467013 })
  })

  it('acepta coordenadas pegadas a mano', () => {
    for (const texto of ['-1.0661434, -80.467013', '-1.0661434,-80.467013']) {
      const r = leerPunto(texto)
      expect(r.ok, texto).toBe(true)
      if (r.ok) expect(r.punto.latitude).toBe(-1.0661434)
    }
  })

  it('acepta el formato `?q=lat,lng`', () => {
    const r = leerPunto('https://maps.google.com/?q=-1.0661434,-80.467013')
    expect(r.ok).toBe(true)
  })

  // ⚠️ El enlace CORTO es el que sale al compartir desde el móvil, y NO lleva
  // el punto dentro: hay que seguir la redirección para verlo, que es justo lo
  // que no se va a hacer desde el servidor. Se detecta para poder decirle al
  // dueño qué hacer — un «no se pudo leer» a secas es lo que convierte un
  // error en abandono.
  it('reconoce el enlace corto y explica la salida', () => {
    const r = leerPunto('https://maps.app.goo.gl/AbCdEfGh123')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('enlace_corto')
      expect(MENSAJE_DEL_PUNTO[r.motivo]).toMatch(/ábrelo en el navegador/i)
    }
  })

  it('un texto sin coordenadas dice qué pegar', () => {
    const r = leerPunto('mi local está frente a Portocentro')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('sin_coordenadas')
      expect(MENSAJE_DEL_PUNTO[r.motivo]).toMatch(/enlace de Google Maps/i)
    }
  })

  it('rechaza lo que no cae en el mapa', () => {
    const r = leerPunto('95.5, -80.4')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('fuera_de_rango')
  })

  // El (0,0) es el golfo de Guinea: nunca es una tienda, siempre es un parseo
  // que devolvió ceros.
  it('rechaza el (0,0)', () => {
    expect(leerPunto('0, 0').ok).toBe(false)
    expect(leerPunto('https://www.google.com/maps/@0,0,17z').ok).toBe(false)
  })

  it('el vacío no es un error que enseñar', () => {
    const r = leerPunto('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.motivo).toBe('vacio')
      expect(MENSAJE_DEL_PUNTO[r.motivo]).toBe('')
    }
  })

  it('el enlace para VER el punto no lleva API key', () => {
    const url = verEnElMapa({ latitude: -1.0661434, longitude: -80.467013 })
    expect(url).toBe('https://www.google.com/maps?q=-1.0661434,-80.467013')
    expect(url).not.toMatch(/key=|apiKey/i)
  })
})

import { describe, expect, it } from 'vitest'
import {
  MENSAJES, motivoDelError, pedirUbicacion, recortar, recortarPrecision,
} from '../src/lib/ubicacion'

// El pin decide a dónde va un repartidor. Lo que se prueba aquí no es que el
// GPS funcione —eso es del aparato— sino que ningún fallo suyo deje al cliente
// sin poder pedir, y que lo que se manda a la base quepa en la base.

/** Un `navigator.geolocation` de mentira, que responde lo que se le diga. */
const geoQueDevuelve = (coords: Partial<GeolocationCoordinates>) => ({
  getCurrentPosition: (ok: PositionCallback) => {
    ok({ coords, timestamp: Date.now() } as GeolocationPosition)
  },
})

const geoQueFalla = (code: number) => ({
  getCurrentPosition: (_ok: PositionCallback, mal?: PositionErrorCallback | null) => {
    mal?.({ code, message: '' } as GeolocationPositionError)
  },
})

describe('recortar', () => {
  it('deja siete decimales, que es lo que acepta numeric(10,7)', () => {
    // El navegador devuelve quince decimales; del octavo en adelante son
    // milímetros, y la columna rechazaría la fila entera por desbordamiento.
    expect(recortar(-1.054621098765432)).toBe(-1.0546211)
    expect(String(recortar(-80.454472)).split('.')[1]!.length).toBeLessThanOrEqual(7)
  })

  it('no toca las coordenadas que ya caben', () => {
    expect(recortar(0)).toBe(0)
    expect(recortar(-1.0546211)).toBe(-1.0546211)
  })
})

describe('recortarPrecision', () => {
  it('redondea a un decimal', () => {
    expect(recortarPrecision(12.3456)).toBe(12.3)
  })

  it('descarta lo que no sirve en vez de tumbar el pin', () => {
    // El punto vale aunque no sepamos cuánto se equivoca; rechazarlo por la
    // precisión sería perder el dato bueno por el accesorio.
    for (const basura of [NaN, Infinity, -1, 1e9, 'mucho', null, undefined]) {
      expect(recortarPrecision(basura)).toBeNull()
    }
  })
})

describe('motivoDelError', () => {
  it('traduce los tres códigos del navegador', () => {
    expect(motivoDelError(1)).toBe('permiso')
    expect(motivoDelError(2)).toBe('no_disponible')
    expect(motivoDelError(3)).toBe('tardo')
  })

  it('lo que no reconoce cae en «no disponible», no revienta', () => {
    expect(motivoDelError(99)).toBe('no_disponible')
    expect(motivoDelError(Number.NaN)).toBe('no_disponible')
  })
})

describe('pedirUbicacion', () => {
  it('devuelve el punto recortado y su precisión', async () => {
    const r = await pedirUbicacion(
      geoQueDevuelve({ latitude: -1.054621098, longitude: -80.454472012, accuracy: 12.55 }),
    )
    expect(r).toEqual({
      ok: true,
      ubicacion: { latitude: -1.0546211, longitude: -80.4544720, accuracy: 12.6 },
    })
  })

  it('sin navegador que lo soporte, avisa y no lanza', async () => {
    const r = await pedirUbicacion(undefined)
    expect(r).toEqual({ ok: false, motivo: 'sin_soporte', mensaje: MENSAJES.sin_soporte })
  })

  it('el permiso denegado menciona abrir fuera de WhatsApp', async () => {
    // Es el fallo más frecuente y casi nunca es que el cliente dijera que no:
    // el navegador incrustado de WhatsApp no siempre reenvía el permiso.
    const r = await pedirUbicacion(geoQueFalla(1))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('permiso')
    expect(r.mensaje).toContain('WhatsApp')
  })

  it('una coordenada imposible se descarta en vez de mandarse', async () => {
    // Si llegara al servidor, el CHECK de la base la rechazaría y el cliente
    // vería un error al guardar la dirección, no al pedir la ubicación.
    const r = await pedirUbicacion(geoQueDevuelve({ latitude: 200, longitude: 0, accuracy: 5 }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('no_disponible')
  })

  it('ningún fallo lanza: siempre se puede seguir pidiendo sin pin', async () => {
    for (const codigo of [1, 2, 3, 42]) {
      const r = await pedirUbicacion(geoQueFalla(codigo))
      expect(r.ok).toBe(false)
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  MENSAJES, esNavegadorIncrustado, motivoDelError, pedirUbicacion, recortar, recortarPrecision,
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

/** El entorno completo: geo, permisos y agente. Sin permisos y en Chrome. */
const entorno = (geo: { getCurrentPosition: PositionCallback extends never ? never : any }) => ({
  geo: geo as never,
  agente: 'Mozilla/5.0 (Linux; Android 13) Chrome/120',
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

describe('esNavegadorIncrustado', () => {
  it('reconoce el WebView de Android y WhatsApp', () => {
    expect(esNavegadorIncrustado('Mozilla/5.0 (Linux; Android 13; wv) Chrome/120')).toBe(true)
    expect(esNavegadorIncrustado('Mozilla/5.0 WhatsApp/2.24')).toBe(true)
  })

  it('un Chrome normal no lo es, ni Safari de iOS', () => {
    expect(esNavegadorIncrustado('Mozilla/5.0 (Linux; Android 13) Chrome/120')).toBe(false)
    expect(esNavegadorIncrustado('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605')).toBe(false)
    expect(esNavegadorIncrustado('')).toBe(false)
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
      entorno(geoQueDevuelve({ latitude: -1.054621098, longitude: -80.454472012, accuracy: 12.55 })),
    )
    expect(r).toEqual({
      ok: true,
      ubicacion: { latitude: -1.0546211, longitude: -80.4544720, accuracy: 12.6 },
    })
  })

  it('sin navegador que lo soporte, avisa y no lanza', async () => {
    const r = await pedirUbicacion({})
    expect(r).toEqual({ ok: false, motivo: 'sin_soporte', mensaje: MENSAJES.sin_soporte })
  })

  // ── «Denegado» son tres cosas distintas ─────────────────────────────────
  //
  // Y cada una se arregla en un sitio distinto. La primera versión mandaba a
  // todos el mismo texto —«prueba abrirlo en tu navegador»— y se lo enseñaba a
  // quien YA estaba en Chrome. Un mensaje que culpa al sitio equivocado es peor
  // que ninguno: el cliente hace lo que le pides, falla otra vez y se rinde.

  it('en Chrome NO culpa a WhatsApp', async () => {
    const r = await pedirUbicacion(entorno(geoQueFalla(1)))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('permiso')
    expect(r.mensaje).not.toContain('WhatsApp')
  })

  it('dentro del navegador de WhatsApp manda a abrirlo fuera', async () => {
    const r = await pedirUbicacion({
      geo: geoQueFalla(1) as never,
      agente: 'Mozilla/5.0 (Linux; Android 13; wv) Chrome/120',
    })
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('incrustado')
    expect(r.mensaje).toContain('WhatsApp')
  })

  it('con el permiso bloqueado manda al candado, no a reintentar', async () => {
    // Reintentar con el permiso bloqueado no abre ningún aviso: el navegador
    // deniega en silencio y el cliente toca el botón hasta cansarse.
    const r = await pedirUbicacion({
      geo: geoQueFalla(1) as never,
      agente: 'Mozilla/5.0 (Linux; Android 13) Chrome/120',
      permisos: { query: async () => ({ state: 'denied' }) },
    })
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('bloqueada')
    // ⚠️ NO se nombra el candado: Chrome para Android lo cambió por un icono
    // de controles, y mandar a buscar un candado que no está hace que el
    // cliente crea que ya lo tiene bien y se rinda.
    expect(r.mensaje).not.toContain('candado')
    expect(r.mensaje).toContain('icono a la izquierda de la dirección')
    // Y que es de la PÁGINA, que es donde la gente no mira.
    expect(r.mensaje).toContain('no el del teléfono')
  })

  it('si la API de permisos no existe o falla, no se cae', async () => {
    for (const permisos of [
      undefined,
      { query: async () => { throw new Error('no soportado') } },
    ]) {
      const r = await pedirUbicacion({
        geo: geoQueFalla(1) as never,
        agente: 'Chrome/120',
        permisos: permisos as never,
      })
      if (r.ok) throw new Error('debía fallar')
      expect(r.motivo).toBe('permiso')
    }
  })

  // ── El segundo intento ──────────────────────────────────────────────────
  //
  // Bajo techo o de noche el GPS puede no fijar en quince segundos. Un pin de
  // trescientos metros por antena es peor que uno de diez, pero muchísimo
  // mejor que ninguno — y `accuracy` lo dice para que nadie se fíe de más.

  it('si el GPS tarda, reintenta por antena y wifi', async () => {
    const opciones: PositionOptions[] = []
    const geo = {
      getCurrentPosition: (ok: PositionCallback, mal: PositionErrorCallback | null | undefined, opts: PositionOptions) => {
        opciones.push(opts)
        if (opciones.length === 1) return mal?.({ code: 3, message: '' } as GeolocationPositionError)
        ok({ coords: { latitude: -1.05, longitude: -80.45, accuracy: 320 }, timestamp: 0 } as GeolocationPosition)
      },
    }
    const r = await pedirUbicacion({ geo: geo as never, agente: 'Chrome/120' })

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('debía funcionar')
    expect(r.ubicacion.accuracy).toBe(320)
    // El primero exige GPS; el segundo lo suelta y acepta caché reciente.
    expect(opciones[0].enableHighAccuracy).toBe(true)
    expect(opciones[1].enableHighAccuracy).toBe(false)
  })

  it('un fallo de permiso NO se reintenta: fallaría igual y alargaría la espera', async () => {
    let intentos = 0
    const geo = {
      getCurrentPosition: (_ok: PositionCallback, mal?: PositionErrorCallback | null) => {
        intentos += 1
        mal?.({ code: 1, message: '' } as GeolocationPositionError)
      },
    }
    await pedirUbicacion({ geo: geo as never, agente: 'Chrome/120' })
    expect(intentos).toBe(1)
  })

  it('una coordenada imposible se descarta en vez de mandarse', async () => {
    // Si llegara al servidor, el CHECK de la base la rechazaría y el cliente
    // vería un error al guardar la dirección, no al pedir la ubicación.
    const r = await pedirUbicacion(entorno(geoQueDevuelve({ latitude: 200, longitude: 0, accuracy: 5 })))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('debía fallar')
    expect(r.motivo).toBe('no_disponible')
  })

  it('ningún fallo lanza: siempre se puede seguir pidiendo sin pin', async () => {
    for (const codigo of [1, 2, 3, 42]) {
      const r = await pedirUbicacion(entorno(geoQueFalla(codigo)))
      expect(r.ok).toBe(false)
    }
  })
})

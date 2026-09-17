import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// UN ENLACE MUERTO SIGUE DICIENDO «EXPIRÓ» AL RECARGAR
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso real (2026-09-17), probando La Abuelita en su propio teléfono y sin
// compartir nada: la tienda estaba abierta, el cliente escribió MENÚ en el
// chat y el enlace se revocó. La primera petición siguiente recibió 401
// `revocada` —bien— y la app BORRÓ el token guardado. Al volver a la pestaña,
// la tienda arrancó sin token: para el servidor era un visitante sin enlace,
// no un enlace muerto, así que mostraba la carta y al intentar pedir salía
// «Necesitas tu propio enlace», el texto de quien abre un enlace reenviado.
//
// Borrar el token era correcto para lo que no tiene arreglo en este teléfono,
// pero un enlace revocado o caducado NO es eso: es la prueba de que esta
// persona YA tuvo su enlace, y es lo único que permite seguir diciéndole la
// verdad —«tu enlace expiró»— en cada recarga.

const almacen = (): Storage => {
  const datos = new Map<string, string>()
  return {
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => { datos.set(k, v) },
    removeItem: (k: string) => { datos.delete(k) },
    clear: () => datos.clear(),
    key: (i: number) => [...datos.keys()][i] ?? null,
    get length() { return datos.size },
  } as Storage
}

const CLAVE = 'vz_store_token:la-abuelita'

const montar = (search = '') => {
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('sessionStorage', almacen())
  vi.stubGlobal('window', {
    location: { pathname: '/t/la-abuelita', search },
    history: { replaceState: () => {} },
  })
}

const responder = (status: number, cuerpo: Record<string, unknown>) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cuerpo), { status })))
}

describe('el token de un enlace que ya no vale', () => {
  beforeEach(() => { vi.resetModules() })

  for (const reason of ['revocada', 'caducada']) {
    it(`uno ${reason} se CONSERVA, para que la recarga siga diciendo «expiró»`, async () => {
      montar()
      localStorage.setItem(CLAVE, 'token-muerto')
      responder(401, { error: 'Tu enlace expiró', reason })
      const api = await import('../src/lib/api')
      const { readToken } = await import('../src/lib/session')

      await expect(api.getMe('la-abuelita')).rejects.toMatchObject({ status: 401, reason })
      expect(readToken()).toBe('token-muerto')
    })
  }

  it('lo que no tiene arreglo en este teléfono sí se borra, como siempre', async () => {
    montar()
    localStorage.setItem(CLAVE, 'token-ajeno')
    responder(401, { error: 'Este enlace no es válido', reason: 'no_existe' })
    const api = await import('../src/lib/api')
    const { readToken } = await import('../src/lib/session')

    await expect(api.getMe('la-abuelita')).rejects.toMatchObject({ status: 401 })
    expect(readToken()).toBe('')
  })

  it('el enlace NUEVO que llega por el chat reemplaza al muerto', async () => {
    // Guardar el muerto no puede dejar a nadie atascado: al abrir el enlace
    // nuevo, el `?s=` de la dirección gana.
    montar('?s=token-nuevo')
    localStorage.setItem(CLAVE, 'token-muerto')
    const { readToken } = await import('../src/lib/session')
    expect(readToken()).toBe('token-nuevo')
    expect(localStorage.getItem(CLAVE)).toBe('token-nuevo')
  })
})

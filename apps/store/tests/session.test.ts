import { beforeEach, describe, expect, it, vi } from 'vitest'

// La credencial de la tienda es el enlace que mandó el bot. Lo que se protege
// aquí son las dos formas de perderla sin haber hecho nada raro.

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

const montarNavegador = (ruta: string) => {
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('sessionStorage', almacen())
  vi.stubGlobal('window', {
    location: { pathname: ruta, search: '' },
    history: { replaceState: () => {} },
  })
}

describe('el token es de CADA negocio', () => {
  beforeEach(() => { vi.resetModules() })

  // ⚠️ Con una sola clave para toda la app, abrir la tienda de un segundo
  // local pisaba el token del primero: el cliente volvía al primero y se
  // encontraba «este enlace no es válido» sin haber hecho nada.
  it('abrir una segunda tienda no pisa el enlace de la primera', async () => {
    montarNavegador('/t/monster-pizza')
    const uno = await import('../src/lib/session')
    localStorage.setItem('vz_store_token:monster-pizza', 'token-de-monster')

    // El cliente abre otra tienda con SU enlace.
    vi.resetModules()
    montarNavegador('/t/otro-local')
    localStorage.setItem('vz_store_token:monster-pizza', 'token-de-monster')
    localStorage.setItem('vz_store_token:otro-local', 'token-del-otro')
    const dos = await import('../src/lib/session')
    expect(dos.readToken()).toBe('token-del-otro')

    // Y al volver a la primera, el suyo sigue ahí.
    vi.resetModules()
    montarNavegador('/t/monster-pizza')
    localStorage.setItem('vz_store_token:monster-pizza', 'token-de-monster')
    const devuelta = await import('../src/lib/session')
    expect(devuelta.readToken()).toBe('token-de-monster')
    expect(uno).toBeDefined()
  })

  // Quien ya tenía su sesión guardada con la clave única no puede quedarse
  // fuera por un despliegue.
  it('respeta el token guardado con la clave vieja', async () => {
    montarNavegador('/t/monster-pizza')
    localStorage.setItem('vz_store_token', 'token-de-antes')
    const sesion = await import('../src/lib/session')
    expect(sesion.readToken()).toBe('token-de-antes')
  })

  it('sin nada guardado devuelve vacío, no revienta', async () => {
    montarNavegador('/t/monster-pizza')
    const sesion = await import('../src/lib/session')
    expect(sesion.readToken()).toBe('')
  })
})

describe('el identificador aleatorio', () => {
  beforeEach(() => { vi.resetModules() })

  // ⚠️ `crypto.randomUUID` no existe en los WebView viejos de Android —los que
  // abre WhatsApp en teléfonos modestos—. Sin respaldo, confirmar el pedido
  // lanzaba una excepción ANTES de llamar al servidor: el cliente no podía
  // pedir, y no había ni error que mirar.
  it('funciona sin crypto.randomUUID', async () => {
    montarNavegador('/t/monster-pizza')
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 13) % 256
        return arr
      },
    })
    const { randomId } = await import('../src/lib/session')
    const id = randomId()
    expect(id).toMatch(/^[0-9a-f-]{8,}$/i)
    expect(id.length).toBeGreaterThanOrEqual(16)
  })

  it('usa randomUUID cuando existe', async () => {
    montarNavegador('/t/monster-pizza')
    vi.stubGlobal('crypto', {
      randomUUID: () => 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      getRandomValues: (arr: Uint8Array) => arr,
    })
    const { randomId } = await import('../src/lib/session')
    expect(randomId()).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })
})

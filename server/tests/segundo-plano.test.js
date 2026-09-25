import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { enSegundoPlano, esperarSegundoPlano } = require('../dist/lib/segundo-plano.js')
const { createErrorLogger, resetErrorLogThrottle } = require('../dist/services/error-log.js')

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE SE LANZA SIN ESPERAR DEJA RASTRO
// ═══════════════════════════════════════════════════════════════════════════
//
// El CI se ponía rojo una de cada cuatro veces porque tres registros lanzados
// con `void` terminaban después de su prueba (ver `lib/segundo-plano.ts`).
// Estas pruebas fijan las dos mitades del arreglo: que el rastro NO cambia lo
// que ve quien llama, y que de verdad se puede esperar lo que quedó en vuelo.

const diferida = () => {
  let resolver
  let rechazar
  const promesa = new Promise((ok, mal) => { resolver = ok; rechazar = mal })
  return { promesa, resolver, rechazar }
}

describe('enSegundoPlano', () => {
  it('devuelve la misma promesa: quien la espera ve lo mismo que antes', async () => {
    const tarea = Promise.resolve(42)
    expect(enSegundoPlano(tarea)).toBe(tarea)
    await expect(enSegundoPlano(Promise.resolve('hecho'))).resolves.toBe('hecho')
  })

  it('un fallo le sigue llegando a quien lo espera, y no se queda en vuelo', async () => {
    const { promesa, rechazar } = diferida()
    const tarea = enSegundoPlano(promesa)
    rechazar(new Error('la base no contestó'))
    await expect(tarea).rejects.toThrow('la base no contestó')
    // Si el fallo lo dejara colgado en el conjunto, esto no volvería nunca.
    await esperarSegundoPlano()
  })
})

describe('esperarSegundoPlano', () => {
  it('no vuelve hasta que termina lo que se lanzó sin esperar', async () => {
    const { promesa, resolver } = diferida()
    let terminada = false
    void enSegundoPlano(promesa.then(() => { terminada = true }))

    const espera = esperarSegundoPlano()
    await Promise.resolve()
    expect(terminada).toBe(false)

    resolver()
    await espera
    expect(terminada).toBe(true)
  })

  it('espera también lo que se lanza MIENTRAS espera', async () => {
    // Un registro puede encadenar otro: el primero termina y lanza el segundo.
    const segunda = diferida()
    let segundaTerminada = false
    void enSegundoPlano(Promise.resolve().then(() => {
      void enSegundoPlano(segunda.promesa.then(() => { segundaTerminada = true }))
    }))

    const espera = esperarSegundoPlano()
    setTimeout(() => segunda.resolver(), 5)
    await espera
    expect(segundaTerminada).toBe(true)
  })

  it('sin nada en vuelo vuelve enseguida', async () => {
    await expect(esperarSegundoPlano()).resolves.toBeUndefined()
  })
})

describe('el registro de errores deja rastro', () => {
  it('un recordError lanzado con `void` se puede esperar hasta que se guarda', async () => {
    // Es el camino real de los huérfanos: casi todos lo llaman sin esperar.
    resetErrorLogThrottle()
    const base = diferida()
    const guardados = []
    const recordError = createErrorLogger({
      recordPlatformError: async (fila) => { await base.promesa; guardados.push(fila) },
    })

    void recordError({ category: 'servidor', code: 'prueba', message: 'algo falló' })
    const espera = esperarSegundoPlano()
    await Promise.resolve()
    expect(guardados).toHaveLength(0)

    base.resolver()
    await espera
    expect(guardados).toHaveLength(1)
    expect(guardados[0].code).toBe('prueba')
  })
})

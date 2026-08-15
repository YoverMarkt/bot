import { test as base, expect } from '@playwright/test'

// ── UNA PANTALLA ROTA TIENE QUE PONER LA PRUEBA EN ROJO ────────────────────
//
// El 2026-08-15 el E2E daba 32/32 con el Dashboard del superadmin sin
// renderizar: React lanzaba `Cannot read properties of undefined (reading
// 'length')` y Playwright ni se inmutaba, porque las pruebas solo miraban la
// URL, el tema o el token — cosas que siguen estando aunque el contenido no.
//
// Un error de JavaScript en la página es, por definición, algo que el usuario
// ve roto. Aquí se convierte en un fallo de la prueba.
//
// ⚠️ Se vigilan DOS cosas distintas:
//   · `pageerror` — una excepción que escapó (el caso del Dashboard).
//   · `console.error` de React — los avisos de renderizado que no lanzan pero
//     señalan un componente mal montado.
//
// Y se ignoran a propósito los errores de RED: un `fetch` fallido es cosa de
// los mocks de cada prueba, no de la página, y hacerlas fallar por eso las
// volvería ruidosas hasta que alguien las apagara.
const RUIDO_DE_RED = /Failed to load resource|net::ERR_|ERR_CONNECTION|favicon/i

export const test = base.extend<{ sinErroresDePagina: void }>({
  sinErroresDePagina: [async ({ page }, use, testInfo) => {
    const errores: string[] = []

    page.on('pageerror', (error) => {
      errores.push(`excepción en la página: ${error.message}`)
    })
    page.on('console', (mensaje) => {
      if (mensaje.type() !== 'error') return
      const texto = mensaje.text()
      if (RUIDO_DE_RED.test(texto)) return
      errores.push(`console.error: ${texto}`)
    })

    await use()

    // Si la prueba ya falló por su cuenta, no se le añade ruido encima: el
    // primer error es el que explica lo que pasó.
    if (testInfo.status !== testInfo.expectedStatus) return
    expect(
      errores,
      'la página lanzó errores de JavaScript: algo se está viendo roto aunque la prueba pasara',
    ).toEqual([])
  }, { auto: true }],
})

export { expect }

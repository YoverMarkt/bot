import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { verNegocios, paso, elegir } = require('../dist/services/marketplace-menu')
const { buildInteractivePayload } = require('../dist/integrations/ycloud')

// ═══════════════════════════════════════════════════════════════════════════
// EL TÍTULO QUE VUELVE RECORTADO
// ═══════════════════════════════════════════════════════════════════════════
//
// Encontrado probando La Abuelita de punta a punta (2026-09-13).
//
// WhatsApp devuelve el TÍTULO de la fila que se toca, no su id
// (`webhooks.routes.ts`: `text = reply?.title`), y ese título sale recortado a
// 24 caracteres por nosotros mismos (`clip` en `ycloud.ts`). Con nombres
// reales eso pasa constantemente:
//
//   se envía  «Ceviches y más de la Bahía»  (26)
//   vuelve    «Ceviches y más de la Ba…»    (24)
//
// El cliente tocaba, recibía «🙏 No te entendí» y veía LA MISMA lista. Bucle
// infinito, sin salida salvo escribir MENÚ.
//
// ⚠️ REESCRITA EL 2026-09-16. Probaba el motor del chat (`bot-menu-flow`), que
// se retiró con el pedido por chat. El fallo NO se fue con él: el marketplace
// sigue mandando listas —las categorías y los LOCALES—, y el nombre de un
// local lo escribe su dueño, así que pasarse de 24 es lo normal. Lo que cambia
// es quién tiene que reconocer el recorte: ahora `elegir` en
// `marketplace-menu.ts`.
//
// ⚠️ Y se prueba con el payload REAL del canal, no con una cadena recortada a
// mano. Ese es el valor: si mañana cambia el tope de `ycloud.ts` y el motor no
// se entera, esta prueba lo caza. Comparar dos constantes escritas por mí no
// probaría nada.

const LARGO = 'Ceviches y más de la Bahía'   // 26 caracteres
const CORTO = 'Doña Mary'

const CATEGORIA = { code: 'marisqueria', label: 'Marisquerías', emoji: '🦐', locales: 2 }
const LOCALES = [
  { id: 'b1', slug: 'ceviches-bahia', name: LARGO, type: 'marisquería', prep_min: 20 },
  { id: 'b2', slug: 'dona-mary', name: CORTO, type: 'marisquería', prep_min: 15 },
]

/** Lo que WhatsApp devuelve al tocar una fila: el título TAL COMO SE ENVIÓ. */
const loQueVuelve = (titulo) => {
  const payload = buildInteractivePayload('cuerpo', [{ id: 'x', title: titulo, description: 'd' }])
  return payload.action.sections[0].rows[0].title
}

describe('un local cuyo nombre no cabe en 24 caracteres', () => {
  it('el cliente puede elegirlo aunque vuelva recortado', () => {
    const lista = verNegocios(CATEGORIA, LOCALES)
    expect(lista.options).toContain(LARGO)

    const vuelve = loQueVuelve(LARGO)
    expect(vuelve).toBe('Ceviches y más de la Ba…')
    expect(vuelve.length).toBe(24)

    // Antes: «🙏 No te entendí» y la misma lista otra vez. Bucle.
    const respuesta = paso({
      mensaje: vuelve,
      vista: lista.vista,
      categorias: [CATEGORIA],
      negocios: LOCALES,
    })
    expect(respuesta.reply || '', respuesta.reply).not.toContain('No te entendí')
    expect(respuesta.negocioElegido?.id).toBe('b1')
  })

  it('un nombre que SÍ cabe sigue funcionando igual', () => {
    const lista = verNegocios(CATEGORIA, LOCALES)
    const respuesta = paso({
      mensaje: loQueVuelve(CORTO),
      vista: lista.vista,
      categorias: [CATEGORIA],
      negocios: LOCALES,
    })
    expect(respuesta.negocioElegido?.id).toBe('b2')
  })

  it('si dos locales se recortan IGUAL, no elige ninguno', () => {
    // Mandar al cliente al local equivocado es peor que volver a preguntar:
    // acabaría pidiendo a un negocio que no eligió.
    const gemelos = [
      { id: 'g1', slug: 'g1', name: 'Ceviches y más de la Bahía', type: 'marisquería', prep_min: 20 },
      { id: 'g2', slug: 'g2', name: 'Ceviches y más de la Barra', type: 'marisquería', prep_min: 20 },
    ]
    const lista = verNegocios(CATEGORIA, gemelos)
    const respuesta = paso({
      mensaje: loQueVuelve('Ceviches y más de la Bahía'),
      vista: lista.vista,
      categorias: [CATEGORIA],
      negocios: gemelos,
    })
    expect(respuesta.negocioElegido).toBeFalsy()
  })
})

describe('el recorte del canal y el del motor no pueden divergir', () => {
  // ⚠️ El motor no puede importar la integración del canal —es una función
  // pura—, así que lo que los ata es esta prueba: lo que `ycloud.ts` manda
  // tiene que ser algo que `elegir` sepa reconocer.
  it('todo lo que el canal recorta, el motor lo reconoce', () => {
    for (const nombre of [
      'Ceviches y más de la Bahía',
      'Pollo en salsa de champiñones',
      'Doña Mary',
      'Heladería La Fuente del Sabor',
    ]) {
      const payload = buildInteractivePayload('cuerpo', [{ id: 'x', title: nombre, description: 'd' }])
      const delCanal = payload.action.sections[0].rows[0].title
      expect(delCanal.length, nombre).toBeLessThanOrEqual(24)
      expect(elegir(delCanal, [nombre, 'Otra cosa distinta']), nombre).toBe(nombre)
    }
  })
})

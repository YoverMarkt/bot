import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// LOS ESTADOS DEL PEDIDO NO PUEDEN SEPARARSE ENTRE LA BASE Y EL PANEL
// ═══════════════════════════════════════════════════════════════════════════
//
// Viven en tres sitios: el CHECK de `orders`, la función `set_order_status` y
// el tipo `OrderStatus` del panel del dueño. Que se separen no rompe nada de
// golpe — rompe A MEDIAS, que es peor:
//
//   · un estado en la base y no en el panel → llega un pedido y el dueño ve un
//     hueco donde debería estar su etiqueta, sin botón para moverlo;
//   · un estado en el panel y no en la base → el botón existe, el dueño lo
//     toca, y la base lo rechaza con un error que no dice nada.
//
// Pasó con el CHECK duplicado el 2026-08-05: había DOS `add constraint
// orders_status_check` en schema.sql y el de abajo pisaba al de arriba con la
// lista vieja, así que los estados nuevos se guardaban en un sitio y se
// rechazaban en otro.

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(path.join(serverDir, 'schema.sql'), 'utf8')
const panel = readFileSync(
  path.join(serverDir, '..', 'apps', 'client', 'src', 'features', 'orders', 'api.ts'),
  'utf8',
)
// El TERCER sitio, y el más traidor: si esta lista se queda corta, el botón
// existe en el panel, el dueño lo toca, y la ruta lo rechaza con un «estado no
// válido» que no explica nada.
const rutaPedidos = readFileSync(
  path.join(serverDir, 'src', 'routes', 'orders.routes.ts'),
  'utf8',
)
// El CUARTO sitio, y el que se rompió sin avisar: lo que la alarma vigila.
// Los otros tres fallan de cara —un botón que no funciona, una etiqueta en
// blanco—; este falla callándose, que es la peor forma.
const vigilancia = readFileSync(
  path.join(serverDir, '..', 'apps', 'client', 'src', 'hooks', 'useAttention.ts'),
  'utf8',
)

const estadosDeLaRuta = () => {
  const inicio = rutaPedidos.indexOf('const ESTADOS_PEDIDO = [')
  const fin = rutaPedidos.indexOf(']', inicio)
  return [...rutaPedidos.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map(([, valor]) => valor)
}

/** Los estados de un bloque `status in ( ... )`, en orden de aparición. */
const estadosDe = (texto, desde = 0) => {
  const inicio = texto.indexOf('status in (', desde)
  if (inicio === -1) return null
  const fin = texto.indexOf(')', inicio)
  return [...texto.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map(([, valor]) => valor)
}

/** TODOS los `add constraint orders_status_check`, porque el último manda. */
const checksDelEsquema = () => {
  const bloques = []
  let desde = 0
  for (;;) {
    const inicio = schema.indexOf('orders_status_check check (', desde)
    if (inicio === -1) break
    bloques.push(estadosDe(schema, inicio))
    desde = inicio + 1
  }
  return bloques
}

const estadosDelPanel = () => {
  const inicio = panel.indexOf('export type OrderStatus')
  const fin = panel.indexOf('\n\n', inicio)
  return [...panel.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map(([, valor]) => valor)
}

/** El CUARTO sitio: los estados que hacen sonar la alarma del panel. */
const estadosVigilados = () => {
  const inicio = vigilancia.indexOf('export const VIGILADOS')
  const fin = vigilancia.indexOf(']', inicio)
  return [...vigilancia.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map(([, valor]) => valor)
}

const estadosDeLaFuncion = () => {
  const inicio = schema.indexOf('if p_status not in (')
  const fin = schema.indexOf(')', inicio)
  return [...schema.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map(([, valor]) => valor)
}

describe('los estados del pedido', () => {
  it('encuentra los tres sitios (si no, todo lo demás pasaría en falso)', () => {
    expect(checksDelEsquema().length).toBeGreaterThanOrEqual(1)
    expect(estadosDelPanel().length).toBeGreaterThanOrEqual(7)
    expect(estadosDeLaFuncion().length).toBeGreaterThanOrEqual(7)
  })

  // El fallo del 2026-08-05: dos CHECK y el de abajo pisando al de arriba.
  it('todos los CHECK de schema.sql dicen exactamente lo mismo', () => {
    const bloques = checksDelEsquema()
    const referencia = [...bloques[0]].sort()
    for (const [indice, bloque] of bloques.entries()) {
      expect([...bloque].sort(), `el CHECK nº ${indice + 1} difiere del primero`)
        .toEqual(referencia)
    }
  })

  it('la función acepta los mismos estados que el CHECK', () => {
    expect(estadosDeLaFuncion().sort()).toEqual([...checksDelEsquema()[0]].sort())
  })

  // Este se saltó al guardián la primera vez: el panel ya tenía los doce
  // estados y la ruta que los recibe seguía con siete, así que los botones
  // nuevos habrían muerto en un 400.
  it('la ruta que cambia el estado acepta los mismos que el CHECK', () => {
    const enLaBase = checksDelEsquema()[0]
    const enLaRuta = estadosDeLaRuta()
    const faltan = enLaBase.filter(estado => !enLaRuta.includes(estado))

    expect(
      faltan,
      faltan.length
        ? 'La base guarda estos estados y `orders.routes.ts` los rechaza:\n'
          + `${faltan.map(e => `  · ${e}`).join('\n')}\n\n`
          + 'El botón existirá en el panel y el dueño recibirá «estado no\n'
          + 'válido» al tocarlo. Añádelos a ESTADOS_PEDIDO.'
        : '',
    ).toEqual([])
  })

  // Un estado que la base guarda y el panel no conoce deja al dueño con un
  // hueco y sin botón para mover ese pedido.
  it('el panel del dueño conoce todos los estados de la base', () => {
    const enLaBase = checksDelEsquema()[0]
    const enElPanel = estadosDelPanel()
    const desconocidos = enLaBase.filter(estado => !enElPanel.includes(estado))

    expect(
      desconocidos,
      desconocidos.length
        ? 'La base guarda estos estados y el panel del dueño no los conoce:\n'
          + `${desconocidos.map(e => `  · ${e}`).join('\n')}\n\n`
          + 'Llegará un pedido con ese estado y el dueño verá un hueco sin\n'
          + 'etiqueta ni botón. Añádelos a OrderStatus, ESTADO_TEXTO,\n'
          + 'ESTADO_COLOR y —si el pedido debe poder avanzar— a siguientePaso.'
        : '',
    ).toEqual([])
  })

  // Y al revés: un botón que la base va a rechazar.
  it('el panel no ofrece estados que la base no acepta', () => {
    const enLaBase = checksDelEsquema()[0]
    const inventados = estadosDelPanel().filter(estado => !enLaBase.includes(estado))

    expect(
      inventados,
      inventados.length
        ? 'El panel ofrece estados que la base rechazará:\n'
          + `${inventados.map(e => `  · ${e}`).join('\n')}`
        : '',
    ).toEqual([])
  })

  // ── El CUARTO sitio: lo que la alarma vigila ─────────────────────────────
  //
  // El fallo del 2026-08-08. La alarma miraba solo `pendiente`, y el día antes
  // se había decidido que quien transfiere nace en `esperando_pago` y pasa a
  // `pago_en_revision` al subir su comprobante. Nada falló al compilar, ningún
  // test se puso rojo: simplemente dejó de sonar. El negocio tuvo pedidos
  // pagados sin enterarse.
  //
  // No se puede exigir que vigile TODOS los estados —«entregado» no despierta
  // a nadie—, así que lo que se comprueba es que los que nombra existan de
  // verdad y que el que de verdad importa no se caiga de la lista.
  it('la alarma vigila estados que la base conoce', () => {
    const enLaBase = checksDelEsquema()[0]
    const inventados = estadosVigilados().filter(estado => !enLaBase.includes(estado))

    expect(
      inventados,
      inventados.length
        ? 'La alarma vigila estados que la base no guarda:\n'
          + `${inventados.map(e => `  · ${e}`).join('\n')}\n\n`
          + 'Esa consulta devolverá un 400 y la alarma dejará de sonar entera.'
        : '',
    ).toEqual([])
  })

  it('la alarma vigila el comprobante por revisar', () => {
    expect(
      estadosVigilados(),
      'Si `pago_en_revision` sale de VIGILADOS, un cliente puede pagar y subir\n'
      + 'su comprobante sin que el negocio se entere de nada. Es exactamente lo\n'
      + 'que pasó el 2026-08-08.',
    ).toContain('pago_en_revision')
  })

  // Cada estado necesita su etiqueta y su color, o la ficha se ve rota.
  it('cada estado tiene su texto y su color en el panel', () => {
    const sinTexto = []
    for (const estado of estadosDelPanel()) {
      const bloqueTexto = panel.slice(panel.indexOf('ESTADO_TEXTO'), panel.indexOf('ESTADO_COLOR'))
      const bloqueColor = panel.slice(panel.indexOf('ESTADO_COLOR'))
      if (!bloqueTexto.includes(`${estado}:`)) sinTexto.push(`${estado} (sin texto)`)
      if (!bloqueColor.includes(`${estado}:`)) sinTexto.push(`${estado} (sin color)`)
    }
    expect(sinTexto).toEqual([])
  })
})

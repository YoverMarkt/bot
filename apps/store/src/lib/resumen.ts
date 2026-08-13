import type { CartLine, GrupoElegido, TrackedItem } from './types'

// ── LO QUE PIDIÓ, PARA ENSEÑÁRSELO ─────────────────────────────────────────
//
// El resumen del pedido decía «1× Pizza $16.83» y se acababa ahí, justo
// después de que el cliente eligiera masa, borde y sabor. El dato estaba en
// las dos fuentes —en el carrito recién enviado y en el pedido que devuelve el
// servidor—; la pantalla simplemente no lo pintaba.
//
// Vive aquí y no dentro de la pantalla porque son DOS caminos que tienen que
// acabar en la misma forma: el que acaba de pedir y el que vuelve debiendo el
// comprobante. Cuando cada uno arma su versión es cuando empiezan a contar
// cosas distintas del mismo plato — le pasó ya a las tres superficies del
// pedido, y por eso el servidor agrupa en un solo sitio (`order-detail.ts`).

/** Una línea lista para pintar, venga de donde venga. */
export interface LineaResumen {
  nombre: string
  cantidad: number
  importe: number
  /** Ya agrupado: «Sabor: Alemana», no una lista plana. */
  grupos: GrupoElegido[]
  /** Lo que escribió el cliente para esa línea. */
  nota: string
}

const limpio = (valor: unknown): string => String(valor ?? '').trim()

/**
 * El pedido que se acaba de enviar, armado desde el CARRITO.
 *
 * Se agrupa aquí porque el carrito guarda las opciones en plano, cada una con
 * el nombre de su grupo. El orden es el de elección, que es el que puso el
 * dueño en la ficha: llegan ya ordenadas porque así se recorrieron los grupos.
 */
export const resumenDesdeCarrito = (lineas: readonly CartLine[]): LineaResumen[] =>
  lineas.map((linea) => {
    const grupos: GrupoElegido[] = []
    const porNombre = new Map<string, GrupoElegido>()
    for (const opcion of linea.options || []) {
      const grupo = limpio(opcion.groupName)
      const nombre = limpio(opcion.name)
      if (!grupo || !nombre) continue
      let destino = porNombre.get(grupo)
      if (!destino) {
        destino = { group: grupo, items: [] }
        porNombre.set(grupo, destino)
        grupos.push(destino)
      }
      destino.items.push({ name: nombre, quantity: Number(opcion.quantity) || 1 })
    }
    // Los extras vienen de `menu_modifiers`, la tabla vieja que el bot sigue
    // usando. Traen su propio grupo («Retira ingredientes», «Extras»), así que
    // se respeta en vez de meterlos todos bajo un rótulo inventado: «Sin ají»
    // bajo «Extras» se lee como si le añadieran ají.
    for (const extra of linea.extras || []) {
      const grupo = limpio(extra.group) || 'Extras'
      const nombre = limpio(extra.name)
      if (!nombre) continue
      let destino = porNombre.get(grupo)
      if (!destino) {
        destino = { group: grupo, items: [] }
        porNombre.set(grupo, destino)
        grupos.push(destino)
      }
      destino.items.push({ name: nombre, quantity: 1 })
    }
    return {
      nombre: `${linea.product.name}${linea.variant ? ` · ${linea.variant.name}` : ''}`,
      cantidad: linea.quantity,
      importe: 0, // lo pone quien llama: el importe oficial no se calcula aquí
      grupos,
      nota: limpio(linea.note),
    }
  })

/**
 * El pedido que ya está en la base, tal como lo devuelve el servidor.
 *
 * Aquí NO se agrupa nada: llega agrupado de `services/order-detail.ts`, con el
 * orden que el dueño le dio a sus grupos. `extras_names` es el respaldo de los
 * pedidos anteriores al motor de opciones, y se enseña plano porque plano es
 * todo lo que se guardó de ellos.
 */
export const resumenDesdePedido = (items: readonly TrackedItem[]): LineaResumen[] =>
  items.map((item) => {
    const agrupadas = (item.options || []).filter(grupo => grupo?.items?.length)
    const sueltas = (item.extras_names || []).map(limpio).filter(Boolean)
    return {
      nombre: `${item.product_name}${item.variant_name ? ` · ${item.variant_name}` : ''}`,
      cantidad: Number(item.quantity) || 1,
      importe: Number(item.line_total) || 0,
      grupos: agrupadas.length
        ? agrupadas
        : sueltas.length
          ? [{ group: 'Incluye', items: sueltas.map(name => ({ name, quantity: 1 })) }]
          : [],
      nota: limpio(item.item_note),
    }
  })

/**
 * Lo elegido en una línea, en texto corrido: «Sabor: Alemana · Masa:
 * Tradicional».
 *
 * ⚠️ En la mini app SÍ se corta a dos líneas con CSS, al contrario que en el
 * panel del dueño: aquí el cliente acaba de armarlo y ya sabe lo que pidió,
 * mientras que allí lo lee la cocina y una descripción cortada se prepara mal.
 */
export const grupoEnTexto = (grupo: GrupoElegido): string => {
  const elegidas = grupo.items
    .map(item => (item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name))
    .join(', ')
  return `${grupo.group}: ${elegidas}`
}

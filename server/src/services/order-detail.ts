// ── LO QUE EL CLIENTE PIDIÓ, CONTADO ENTERO ────────────────────────────────
//
// Un pedido se enseña en TRES sitios —el seguimiento de la mini app, la bandeja
// del dueño y el WhatsApp del cliente— y los tres decían cosas distintas del
// mismo plato:
//
//   panel y app:  «Tradicional · Sin borde · Extra queso · Sin ají · Cheese Burguer»
//   WhatsApp:     «1× Pizza (Personal)»   ← y nada más
//
// La lista plana no es solo fea, es AMBIGUA: «Sin ají» es un retiro y «Extra
// queso» un añadido, y salían idénticos; «Cheese Burguer» es un sabor de pizza
// y parecía que el cliente había pedido una hamburguesa.
//
// El dato estaba entero desde el principio en `order_item_options`, con su
// grupo y su cantidad. Lo único que faltaba era leerlo agrupado.
//
// Esto vive en el servidor y NO en cada app a propósito: son tres superficies,
// y ya derivaron una vez. La agrupación se hace aquí, una sola vez, y las apps
// solo pintan lo que reciben.

/** Una opción tal como la congeló la base al crear el pedido. */
export interface OpcionDelPedido {
  option_group_name?: string | null
  option_name?: string | null
  quantity?: number | null
}

/** Un grupo con lo que se eligió dentro. El nombre del grupo es lo que explica
 *  qué clase de cosa es cada opción: «Retira ingredientes: ají» se lee solo. */
export interface GrupoDelPedido {
  group: string
  items: { name: string; quantity: number }[]
}

const texto = (valor: unknown): string => String(valor ?? '').trim()

/**
 * Agrupa las opciones de una línea por su grupo.
 *
 * ⚠️ El orden de los grupos es ALFABÉTICO, y es una decisión, no un descuido.
 * Las filas de `order_item_options` se insertan todas en la misma sentencia, o
 * sea que comparten `created_at` al milisegundo: no hay ningún orden guardado
 * que respetar, y sin criterio propio el mismo plato saldría con los grupos
 * barajados de un pedido a otro.
 *
 * Lo natural sería usar `option_groups.sort`, que es el orden que el dueño
 * configuró y el que vio el cliente al armar el plato. Eso pide una columna
 * copiada al insertar —y recrear la RPC del dinero— y no compensa hacerlo por
 * el orden de cinco líneas: está anotado en PENDIENTE.md.
 */
export const agruparOpciones = (
  opciones: readonly OpcionDelPedido[] | null | undefined,
): GrupoDelPedido[] => {
  const porGrupo = new Map<string, GrupoDelPedido>()

  for (const opcion of opciones || []) {
    const grupo = texto(opcion?.option_group_name)
    const nombre = texto(opcion?.option_name)
    // Sin grupo o sin nombre no se puede contar nada: se ignora en vez de
    // pintar «: algo», que sería peor que no decirlo.
    if (!grupo || !nombre) continue

    const cantidad = Math.max(1, Math.trunc(Number(opcion?.quantity) || 1))
    const yaEsta = porGrupo.get(grupo)
    if (yaEsta) yaEsta.items.push({ name: nombre, quantity: cantidad })
    else porGrupo.set(grupo, { group: grupo, items: [{ name: nombre, quantity: cantidad }] })
  }

  return [...porGrupo.values()]
    .map(grupo => ({
      group: grupo.group,
      items: [...grupo.items].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }))
    .sort((a, b) => a.group.localeCompare(b.group, 'es'))
}

/**
 * Una opción en texto. La cantidad solo se dice cuando es más de una: «Alitas»
 * y «Alitas x1» son lo mismo, y el x1 solo ensucia.
 */
export const opcionEnTexto = (item: { name: string; quantity: number }): string =>
  item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name

/** Un grupo en una línea: «Sabor: Criolla, Desgranada». */
export const grupoEnTexto = (grupo: GrupoDelPedido): string =>
  `${grupo.group}: ${grupo.items.map(opcionEnTexto).join(', ')}`

/**
 * Añade a cada línea del pedido sus opciones YA agrupadas, en `options`.
 *
 * Existe para que las dos apps no vuelvan a agrupar cada una por su cuenta.
 * Son tres superficies contando el WhatsApp, y ya derivaron una vez: el panel
 * y la app enseñaban una lista plana mientras el mensaje no enseñaba nada.
 *
 * `order_item_options` se queda tal cual además de `options`: quitarlo sería
 * romper a cualquiera que hoy lo lea, y no estorba.
 */
export const conOpcionesAgrupadas = (
  pedido: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (!pedido || !Array.isArray(pedido.order_items)) return pedido
  return {
    ...pedido,
    order_items: (pedido.order_items as Record<string, unknown>[]).map(linea => ({
      ...linea,
      options: agruparOpciones(linea?.order_item_options as OpcionDelPedido[] | null),
    })),
  }
}

/** Lo mismo para una lista, que es como los lee el panel del dueño. */
export const conOpcionesAgrupadasEnLote = (pedidos: unknown): unknown => {
  if (!Array.isArray(pedidos)) return pedidos
  return pedidos.map(pedido => conOpcionesAgrupadas(pedido as Record<string, unknown>))
}

/**
 * Lo que se eligió, en líneas de texto listas para leer.
 *
 * `extras_names` es el respaldo de los pedidos VIEJOS, los de antes del motor
 * de opciones: ahí no hay grupos, solo una lista, y se enseña tal cual. Un
 * pedido de hace tres meses tiene que seguir diciendo lo que el cliente compró.
 */
export const detalleEnTexto = (linea: {
  order_item_options?: readonly OpcionDelPedido[] | null
  extras_names?: readonly string[] | null
}): string[] => {
  const grupos = agruparOpciones(linea?.order_item_options)
  if (grupos.length) return grupos.map(grupoEnTexto)

  const sueltos = (linea?.extras_names || []).map(texto).filter(Boolean)
  return sueltos.length ? [sueltos.join(' · ')] : []
}

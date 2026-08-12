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
  /**
   * El orden que el dueño le dio a este grupo, copiado al crear el pedido.
   *
   * Se copia y no se consulta a propósito: el panel del dueño pide sus pedidos
   * cada 12 segundos, y unirse a `option_groups` en esa consulta la haría
   * correr sin parar durante todo el servicio.
   */
  group_sort?: number | null
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
 * ⚠️ El orden es el que puso EL DUEÑO (`group_sort`), no el alfabético. Una
 * pizza se piensa en un orden —sabor, masa, borde, y al final lo que se agrega
 * y cuesta aparte— y ese orden es el mismo que el cliente vio al armarla. Por
 * nombre saldría «Borde, Extras, Masa, Retira, Sabor», que es el orden de un
 * listado y no el de una cocina.
 *
 * El alfabético queda de desempate, y hace falta: los grupos de un pedido
 * anterior a esto tienen `group_sort` en cero, igual que dos grupos que el
 * dueño nunca ordenó. Sin desempate, esos saldrían barajados de un pedido a
 * otro, porque las filas se insertan todas en la misma sentencia y comparten
 * `created_at` al milisegundo — no hay ningún orden natural del que fiarse.
 */
export const agruparOpciones = (
  opciones: readonly OpcionDelPedido[] | null | undefined,
): GrupoDelPedido[] => {
  const porGrupo = new Map<string, GrupoDelPedido & { orden: number }>()

  for (const opcion of opciones || []) {
    const grupo = texto(opcion?.option_group_name)
    const nombre = texto(opcion?.option_name)
    // Sin grupo o sin nombre no se puede contar nada: se ignora en vez de
    // pintar «: algo», que sería peor que no decirlo.
    if (!grupo || !nombre) continue

    const cantidad = Math.max(1, Math.trunc(Number(opcion?.quantity) || 1))
    const orden = Number(opcion?.group_sort)
    const yaEsta = porGrupo.get(grupo)
    if (yaEsta) yaEsta.items.push({ name: nombre, quantity: cantidad })
    else {
      porGrupo.set(grupo, {
        group: grupo,
        orden: Number.isFinite(orden) ? orden : 0,
        items: [{ name: nombre, quantity: cantidad }],
      })
    }
  }

  return [...porGrupo.values()]
    .sort((a, b) => a.orden - b.orden || a.group.localeCompare(b.group, 'es'))
    .map(grupo => ({
      group: grupo.group,
      items: [...grupo.items].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }))
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

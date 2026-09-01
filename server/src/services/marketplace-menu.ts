// ═══════════════════════════════════════════════════════════════════════════
// EL MENÚ DEL MARKETPLACE
//
// Lo que ve quien escribe al número de Umbani: categorías → locales → y de ahí
// al enlace de la tienda de ese local.
//
// ⚠️ Termina en el ENLACE a propósito. La mini app ya sabe hacer productos,
// opciones, carrito, dirección, pago y seguimiento: rehacer todo eso en
// botones de WhatsApp sería una segunda implementación del mismo camino, y
// dos sitios donde el precio puede divergir. El menú solo lleva al cliente
// hasta la puerta del local correcto.
//
// ⚠️ Función PURA, como `bot-menu-flow.ts`: recibe los datos ya consultados y
// devuelve texto y opciones. Nada de base de datos aquí — así se prueba entera
// sin levantar nada, que es lo que permite confiar en ella.
//
// ⚠️ La paginación es de NUEVE, no diez. Una lista de WhatsApp admite diez
// filas y la última se la lleva «Ver más»; con diez opciones más el botón, la
// última se perdería sin que nada avisara.
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketplaceCategory {
  code: string
  label: string
  emoji: string | null
  locales: number
}

export interface MarketplaceBusiness {
  id: string
  slug: string
  name: string
  type: string
  prep_min: number | null
}

/** Dónde está el cliente dentro del menú. Se guarda en `flow_state`. */
export interface MarketplaceView {
  vista: 'categorias' | 'negocios' | 'busqueda' | 'confirmando_reinicio'
  categoria?: string
  /**
   * Lo que el cliente escribió, cuando la vista es una BÚSQUEDA.
   *
   * ⚠️ Se guarda la consulta, no los resultados. Volver a buscar cuesta una
   * consulta, pero mantiene `flow_state` pequeño y —lo que importa— los
   * resultados frescos: un local que se suspendió entre medias desaparece de
   * la lista en vez de seguir ofreciéndose.
   */
  consulta?: string
  pagina: number
}

export interface MarketplaceReply {
  reply: string
  options: string[]
  /**
   * El mensaje no casó con ninguna opción del menú.
   *
   * Es la señal de que quizá el cliente esté BUSCANDO («quiero ceviche») en
   * vez de equivocándose. El llamador la usa para consultar la búsqueda antes
   * de responder «no te entendí» — `paso` no puede hacerlo solo porque es una
   * función pura y buscar exige tocar la base.
   */
  noEntendido?: boolean
  /** Cuando el cliente eligió local: a partir de aquí manda la tienda. */
  negocioElegido?: MarketplaceBusiness
  vista: MarketplaceView
}

export const VER_MAS = '➡️ Ver más'
export const VOLVER = '⬅️ Volver'
export const PAGINA = 9

const SALUDO = '👋 ¡Hola! Bienvenido a *Umbani*.'
const PREGUNTA = '¿Qué deseas pedir?'
const NO_ENTENDI = '🙏 No te entendí. Elige una opción de la lista 👇'

/** Sin acentos ni mayúsculas: el cliente escribe «pizzerias» y también vale. */
const normalizar = (valor: string): string => String(valor || '')
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')

/**
 * Los saludos que abren una conversación. No son opciones equivocadas.
 *
 * ⚠️ Nace de un fallo real: un cliente escribía «Hola» y recibía «🙏 No te
 * entendí. Elige una opción de la lista». La bienvenida existía, pero solo se
 * daba en el PRIMER mensaje de alguien que nunca había escrito —y como la
 * conversación no vence ni la borra nadie, el cliente que VUELVE (que es el
 * que más vale) recibía el reproche para siempre.
 */
const PALABRAS_DE_SALUDO = new Set([
  'hola', 'ola', 'holi', 'holis', 'hey', 'ey', 'alo', 'hello', 'hi',
  'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche',
  'noches', 'saludos', 'que', 'tal', 'como', 'estas', 'feliz',
])

/** Un saludo suelto no puede ocupar media conversación. */
const MAX_PALABRAS_DE_SALUDO = 4

/**
 * ¿El mensaje es SOLO un saludo?
 *
 * ⚠️ Se exige que TODAS sus palabras sean de saludo, no que contenga una.
 * Así «hola buenas noches» se reconoce entero —que es como saluda la gente—
 * mientras que «hola quiero pizza» sigue siendo una BÚSQUEDA: tratarla como
 * saludo le devolvería la portada en vez de buscarle su pizza. Es el mismo
 * criterio que `esComandoMenu`, que tampoco se dispara con una frase que
 * solo contiene la palabra.
 *
 * Las letras estiradas del final se recortan («holaaa», «buenasss»): es como
 * se saluda de verdad por WhatsApp.
 */
export function esSaludo(mensaje: string): boolean {
  const texto = normalizar(mensaje)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!texto) return false
  const palabras = texto.split(' ')
  if (palabras.length > MAX_PALABRAS_DE_SALUDO) return false
  return palabras.every(palabra => (
    PALABRAS_DE_SALUDO.has(palabra.replace(/(.)\1+$/, '$1'))
  ))
}

const etiquetaCategoria = (categoria: MarketplaceCategory): string => (
  categoria.emoji ? `${categoria.emoji} ${categoria.label}` : categoria.label
)

const etiquetaNegocio = (negocio: MarketplaceBusiness): string => negocio.name

/** El trozo de lista que toca, más «Ver más» si queda algo detrás. */
function paginar<T>(todos: T[], pagina: number, etiqueta: (item: T) => string) {
  const desde = pagina * PAGINA
  const mostrados = todos.slice(desde, desde + PAGINA)
  const hayMas = todos.length > desde + PAGINA
  return { mostrados, hayMas, opciones: mostrados.map(etiqueta) }
}

/**
 * Casa lo que escribió el cliente contra las opciones ofrecidas.
 *
 * Acepta el texto exacto, el texto sin emoji, y el número de la fila — la app
 * de WhatsApp devuelve el título, pero mucha gente responde «3».
 */
export function elegir(mensaje: string, opciones: string[]): string | null {
  const texto = normalizar(mensaje)
  if (!texto) return null

  const posicion = Number.parseInt(texto, 10)
  if (Number.isInteger(posicion) && posicion >= 1 && posicion <= opciones.length) {
    return opciones[posicion - 1]
  }
  const exacta = opciones.find(opcion => normalizar(opcion) === texto)
  if (exacta) return exacta
  // Sin el emoji delante: «pizzerias» debe encontrar «🍕 Pizzerías».
  const porTexto = opciones.find((opcion) => {
    const limpia = normalizar(opcion).replace(/[^a-z0-9 ]/g, '').trim()
    return limpia === texto || (limpia.length > 2 && limpia.includes(texto))
  })
  if (porTexto) return porTexto

  // ⚠️ WHATSAPP RECORTA LOS TÍTULOS, y esto dejaba opciones IMPOSIBLES de
  // elegir. Un botón admite 20 caracteres: «✅ Sí, empezar de nuevo» son 22, así
  // que al tocarlo volvía «✅ Sí, empezar de nu…» y no casaba con nada. El
  // cliente tocaba el botón y recibía «no te entendí», una y otra vez.
  //
  // Se compara por PREFIJO, y solo si es inequívoco: con dos opciones que
  // empiecen igual no se adivina, se vuelve a preguntar.
  const recortado = texto.replace(/[…]+$/, '').replace(/\.{3,}$/, '').trim()
  if (recortado.length >= 4) {
    const candidatas = opciones.filter((opcion) => {
      const limpia = normalizar(opcion).replace(/[^a-z0-9 ]/g, '').trim()
      return limpia.startsWith(recortado) || normalizar(opcion).startsWith(recortado)
    })
    if (candidatas.length === 1) return candidatas[0]
  }
  return null
}

/** La portada: las categorías que hoy tienen locales detrás. */
export function verCategorias(
  categorias: MarketplaceCategory[],
  pagina = 0,
  saludar = false,
): MarketplaceReply {
  if (!categorias.length) {
    return {
      reply: '😔 Ahora mismo no tenemos locales disponibles. Vuelve a escribirnos en un rato.',
      options: [],
      vista: { vista: 'categorias', pagina: 0 },
    }
  }
  const { hayMas, opciones } = paginar(categorias, pagina, etiquetaCategoria)
  return {
    reply: `${saludar ? `${SALUDO}\n\n` : ''}${PREGUNTA}`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : [])],
    vista: { vista: 'categorias', pagina },
  }
}

/** Los locales de una categoría. */
export function verNegocios(
  categoria: MarketplaceCategory,
  negocios: MarketplaceBusiness[],
  pagina = 0,
): MarketplaceReply {
  if (!negocios.length) {
    // No debería pasar —la consulta solo devuelve categorías con locales—,
    // pero el último local pudo cerrar entre el menú y esta respuesta.
    return {
      reply: `😔 Justo ahora no hay locales abiertos en ${categoria.label}. Elige otra categoría 👇`,
      options: [VOLVER],
      vista: { vista: 'negocios', categoria: categoria.code, pagina: 0 },
    }
  }
  const { hayMas, opciones } = paginar(negocios, pagina, etiquetaNegocio)
  return {
    reply: `${etiquetaCategoria(categoria)}\n\nElige un local 👇`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER],
    vista: { vista: 'negocios', categoria: categoria.code, pagina },
  }
}

/**
 * Lo que encontró la búsqueda. Un local es un local: se pintan igual que los
 * de una categoría, y al tocar uno se entra por el mismo camino.
 *
 * ⚠️ Se dice QUÉ se buscó («Esto encontré para "ceviche"»). Sin eso, una lista
 * suelta de locales después de escribir una frase parece que el bot cambió de
 * tema — sobre todo si el nombre del local no contiene la palabra buscada, que
 * es justo el caso para el que existen los alias y los trigramas.
 */
export function verResultados(
  consulta: string,
  negocios: MarketplaceBusiness[],
  pagina = 0,
): MarketplaceReply {
  const limpia = String(consulta || '').trim().slice(0, 60)
  const { hayMas, opciones } = paginar(negocios, pagina, etiquetaNegocio)
  return {
    reply: `🔎 Esto encontré para *${limpia}*:`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER],
    vista: { vista: 'busqueda', consulta: limpia, pagina },
  }
}

export interface PasoInput {
  /**
   * Lo que escribió el cliente.
   *
   * ⚠️ **Vacío significa REPINTAR, no «se equivocó»**. Al elegir una
   * categoría, `paso` devuelve una vista sin texto para que el llamador
   * consulte los locales y vuelva a llamar — y en esa segunda llamada el
   * mensaje ya se consumió, así que llega vacío. Tratarlo como una elección
   * fallida dejaba el menú en bucle: el cliente tocaba «🍕 Pizzerías», la
   * vista avanzaba bien a los locales… y encima le decía «no te entendí».
   */
  mensaje: string
  vista: MarketplaceView
  categorias: MarketplaceCategory[]
  /** Los locales de `vista.categoria`. El llamador los consulta. */
  negocios: MarketplaceBusiness[]
  /**
   * Primera vez que este cliente escribe al marketplace.
   *
   * ⚠️ Un «hola» NO es una opción equivocada. Sin esto, el primerísimo
   * mensaje de alguien que nunca ha escrito recibía «🙏 No te entendí» como
   * bienvenida a Umbani.
   */
  primerContacto?: boolean
}

/**
 * Un paso del menú: qué contesta el bot ante este mensaje.
 *
 * Devuelve `negocioElegido` cuando el cliente llegó a un local; a partir de
 * ahí el llamador emite el enlace de su tienda.
 */
export function paso(input: PasoInput): MarketplaceReply {
  const { mensaje, vista, categorias, negocios } = input
  // Repintar la vista tal cual: nadie se equivocó, no hay nada que reprochar.
  const repintar = !normalizar(mensaje)

  // ── Los resultados de una búsqueda ──────────────────────────────────
  //
  // Se pintan como cualquier lista de locales y al tocar uno se entra por el
  // MISMO camino (`negocioElegido`): un local es un local, venga del menú o de
  // haber escrito «quiero ceviche».
  if (vista.vista === 'busqueda' && vista.consulta) {
    const { mostrados, hayMas, opciones } = paginar(negocios, vista.pagina, etiquetaNegocio)
    const elegida = elegir(mensaje, [
      ...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER,
    ])

    if (elegida === VOLVER) return verCategorias(categorias, 0)
    if (elegida === VER_MAS) return verResultados(vista.consulta, negocios, vista.pagina + 1)

    const negocio = mostrados.find(n => etiquetaNegocio(n) === elegida)
    if (negocio) {
      return {
        reply: '',
        options: [],
        negocioElegido: negocio,
        vista: { vista: 'busqueda', consulta: vista.consulta, pagina: vista.pagina },
      }
    }

    // No eligió ninguno: puede estar buscando OTRA cosa. Se devuelve la señal
    // para que el llamador busque de nuevo antes de reprocharle nada.
    const repetir = verResultados(vista.consulta, negocios, vista.pagina)
    if (repintar || esSaludo(mensaje)) return repetir
    return { ...repetir, reply: `${NO_ENTENDI}\n\n${repetir.reply}`, noEntendido: true }
  }

  if (vista.vista === 'negocios' && vista.categoria) {
    const categoria = categorias.find(c => c.code === vista.categoria)
    // La categoría dejó de tener locales mientras el cliente miraba.
    if (!categoria) return verCategorias(categorias, 0)

    const { mostrados, hayMas, opciones } = paginar(negocios, vista.pagina, etiquetaNegocio)
    const elegida = elegir(mensaje, [
      ...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER,
    ])

    if (elegida === VOLVER) return verCategorias(categorias, 0)
    if (elegida === VER_MAS) return verNegocios(categoria, negocios, vista.pagina + 1)

    const negocio = mostrados.find(n => etiquetaNegocio(n) === elegida)
    if (negocio) {
      return {
        reply: '',
        options: [],
        negocioElegido: negocio,
        vista: { vista: 'negocios', categoria: categoria.code, pagina: vista.pagina },
      }
    }
    const repetir = verNegocios(categoria, negocios, vista.pagina)
    // Un saludo a media navegación tampoco es un error: se repinta la lista
    // donde estaba. Aquí NO se saluda con «Bienvenido a Umbani» — el cliente
    // ya está dentro de una categoría, y darle la bienvenida otra vez leería
    // como si hubiera vuelto al principio.
    if (repintar || esSaludo(mensaje)) return repetir
    return { ...repetir, reply: `${NO_ENTENDI}\n\n${repetir.reply}`, noEntendido: true }
  }

  // Estamos en la portada.
  const { mostrados, hayMas, opciones } = paginar(categorias, vista.pagina, etiquetaCategoria)
  const elegida = elegir(mensaje, [...opciones, ...(hayMas ? [VER_MAS] : [])])

  if (elegida === VER_MAS) return verCategorias(categorias, vista.pagina + 1)

  const categoria = mostrados.find(c => etiquetaCategoria(c) === elegida)
  if (categoria) {
    // El llamador aún no trae los locales de ESTA categoría: los pide y
    // vuelve a llamar. Se devuelve la vista para que sepa cuál consultar.
    return {
      reply: '',
      options: [],
      vista: { vista: 'negocios', categoria: categoria.code, pagina: 0 },
    }
  }
  // Repintado, o el primer «hola» de alguien que nunca ha escrito: en los dos
  // casos se le da la bienvenida, no un reproche.
  const saluda = esSaludo(mensaje)
  if (repintar || input.primerContacto || saluda) {
    return verCategorias(
      categorias, vista.pagina, Boolean(input.primerContacto) || saluda,
    )
  }
  const repetir = verCategorias(categorias, vista.pagina)
  return { ...repetir, reply: `${NO_ENTENDI}\n\n${repetir.reply}`, noEntendido: true }
}

// ═══════════════════════════════════════════════════════════════════════════
// EL COMANDO MENÚ Y EL BLOQUEO DE FLUJO
//
// Un cliente atiende UN pedido a la vez. Si está en El Puerto y escribe «ahora
// quiero pizza», cambiarlo de local en silencio le tira lo que llevaba: la
// mini app de El Puerto se le queda abierta con un carrito que ya no lleva a
// ninguna parte.
//
// ⚠️ El bloqueo NO es un muro: se le dice qué tiene abierto y cómo salir. Un
// «no puedes» sin salida es peor que no bloquear.
//
// ⚠️ MENÚ se comprueba ANTES que ninguna otra intención, siempre. Es la única
// forma que tiene el cliente de salir de donde esté, así que no puede depender
// de en qué vista se encuentre — que es justo lo que lo volvería inútil el día
// que se atasque.
// ═══════════════════════════════════════════════════════════════════════════

const COMANDOS_MENU = [
  'menu', 'menú', 'inicio', 'empezar', 'empezar de nuevo', 'volver al menu',
  'volver al menú', 'reiniciar', 'cancelar', 'salir',
]

export const SI_REINICIAR = '✅ Empezar de nuevo'
export const NO_CONTINUAR = '↩️ Seguir mi pedido'

/**
 * ¿Es el comando global de volver al menú?
 *
 * Se compara sobre el texto normalizado —sin tildes, sin signos— porque quien
 * escribe «MENÚ!» o «menu» quiere exactamente lo mismo.
 */
export function esComandoMenu(mensaje: string): boolean {
  const texto = normalizar(mensaje).replace(/[^a-z0-9 ]/g, '').trim()
  if (!texto) return false
  return COMANDOS_MENU.some(comando => (
    normalizar(comando).replace(/[^a-z0-9 ]/g, '') === texto
  ))
}

export interface EstadoDeCompra {
  /** El local en el que está, si eligió uno. */
  negocio?: { name: string; slug: string } | null
  bloqueado: boolean
}

/**
 * Lo que se responde a MENÚ.
 *
 * ⚠️ Con un pedido en marcha NO se borra nada sin preguntar. El cliente pudo
 * escribir «menú» buscando ayuda, no queriendo tirar lo que llevaba — y la
 * mini app de ese local sigue abierta en su teléfono.
 */
export function responderAlMenu(
  estado: EstadoDeCompra,
  categorias: MarketplaceCategory[],
): MarketplaceReply {
  if (estado.bloqueado && estado.negocio) {
    return {
      reply: `Tienes un pedido en proceso en *${estado.negocio.name}*.\n\n`
        + 'Si vuelves al menú, ese pedido se queda sin terminar.\n\n'
        + '¿Qué prefieres?',
      options: [SI_REINICIAR, NO_CONTINUAR],
      vista: { vista: 'confirmando_reinicio', pagina: 0 },
    }
  }
  return verCategorias(categorias, 0)
}

/**
 * Lo que se responde a quien intenta empezar otra cosa con un pedido abierto.
 *
 * Se le dice DÓNDE lo tiene y CÓMO salir, en el mismo mensaje: cada respuesta
 * se paga, así que no se gasta una en decir solo «no».
 */
export function recordarPedidoEnProceso(
  negocio: { name: string },
): MarketplaceReply {
  return {
    reply: `Tienes un pedido en proceso en *${negocio.name}*.\n\n`
      + 'Termínalo, o elige empezar de nuevo aquí abajo 👇',
    // ⚠️ Antes decía «escribe *MENÚ*» y no ofrecía nada. Escribir MENÚ llevaba
    // a una pregunta que MENÚ no podía responder, así que el cliente se quedaba
    // dando vueltas. Ahora se le dan las dos salidas, que es lo que de verdad
    // resuelve — y siguen siendo las mismas dos de la confirmación.
    options: [SI_REINICIAR, NO_CONTINUAR],
    vista: { vista: 'confirmando_reinicio', pagina: 0 },
  }
}

/**
 * Lo que ve quien escribe DEBIENDO un comprobante.
 *
 * ⚠️ `recordarPedidoEnProceso` dice «Termínalo», y a quien debe una foto eso
 * no le dice nada: su pedido ya está hecho, lo que falta es la captura. Desde
 * el 2026-08-30 el candado dura hasta que el comprobante llega, así que este
 * mensaje es el que más va a leerse — y tiene que decir las DOS cosas: qué
 * falta, y cómo salir si prefiere pedir en otro sitio.
 *
 * ⚠️ Las opciones son LAS MISMAS que el otro recordatorio, y a propósito:
 * `resolverReinicio` las interpreta por su texto, así que cambiarlas aquí
 * dejaría al cliente tocando un botón que nadie sabe leer. Lo que cambia es
 * lo que significan: «Seguir mi pedido» es «me quedo con él y mando la foto».
 */
export function recordarComprobantePendiente(
  negocio: { name: string },
): MarketplaceReply {
  return {
    reply: `Tienes un pedido en *${negocio.name}* esperando tu comprobante.\n\n`
      + 'Mándanos aquí la foto de tu transferencia —a tu nombre— y el local empieza a '
      + 'prepararlo 📸\n\n'
      + 'Si prefieres dejarlo y pedir en otro local, elige *empezar de nuevo*.',
    options: [SI_REINICIAR, NO_CONTINUAR],
    vista: { vista: 'confirmando_reinicio', pagina: 0 },
  }
}

/**
 * Lo que ve quien YA mandó su comprobante y espera al local.
 *
 * ⚠️ Es un TERCER mensaje, y hace falta: `recordarComprobantePendiente` le
 * pide una foto que esta persona acaba de mandar, y `recordarPedidoEnProceso`
 * le dice «termínalo» a un pedido que ya terminó. Los dos suenan a que el bot
 * no se enteró.
 *
 * ⚠️ **Sin los botones de reinicio, a diferencia de los otros dos.** Aquí ya
 * hay dinero transferido: ofrecer «✅ Empezar de nuevo» a un toque de distancia
 * invita a abandonar un pedido pagado, y eso no tiene vuelta atrás. Quien de
 * verdad quiera salir escribe MENÚ, que sigue preguntándole antes de tirar
 * nada — la salida existe, solo que no está en un botón que se toca sin leer.
 */
export function recordarPagoEnRevision(
  negocio: { name: string },
): MarketplaceReply {
  return {
    reply: `🧾 Tu pedido en *${negocio.name}* está en revisión.\n\n`
      + 'El local está comprobando tu pago y te avisamos aquí mismo en cuanto '
      + 'empiece a prepararlo 👨‍🍳\n\n'
      + 'Mientras tanto no hace falta que hagas nada.',
    options: [],
    vista: { vista: 'negocios', pagina: 0 },
  }
}

/**
 * La respuesta a la confirmación de reinicio.
 *
 * ⚠️ `continua` NO es lo contrario de `reinicia`: son TRES respuestas, no dos.
 * «Empezar de nuevo» reinicia, «Seguir mi pedido» continúa, y cualquier otra
 * cosa no es ninguna de las dos —se vuelve a preguntar—. Quien llama necesita
 * distinguir la segunda de la tercera para devolverle el enlace solo a quien
 * dijo que sigue; deducirlo de `options.length === 0` funcionaba, pero ataba
 * una decisión de flujo a cuántos botones lleva un mensaje.
 */
export function resolverReinicio(
  mensaje: string,
  estado: EstadoDeCompra,
  categorias: MarketplaceCategory[],
): { reinicia: boolean; continua: boolean; respuesta: MarketplaceReply } {
  const elegida = elegir(mensaje, [SI_REINICIAR, NO_CONTINUAR])

  if (elegida === SI_REINICIAR) {
    return { reinicia: true, continua: false, respuesta: verCategorias(categorias, 0) }
  }
  if (elegida === NO_CONTINUAR) {
    return {
      reinicia: false,
      continua: true,
      respuesta: {
        reply: estado.negocio
          ? `Perfecto, sigues en *${estado.negocio.name}*. Termina tu pedido cuando quieras 👍`
          : 'Perfecto 👍',
        options: [],
        vista: { vista: 'negocios', pagina: 0 },
      },
    }
  }
  // No entendió: se repite la pregunta, no se decide por él. Tirar un carrito
  // por un «ok» ambiguo es lo único que no tiene vuelta atrás.
  return {
    reinicia: false,
    continua: false,
    respuesta: {
      reply: `${NO_ENTENDI}\n\n¿Empezamos de nuevo o sigues con tu pedido?`,
      options: [SI_REINICIAR, NO_CONTINUAR],
      vista: { vista: 'confirmando_reinicio', pagina: 0 },
    },
  }
}

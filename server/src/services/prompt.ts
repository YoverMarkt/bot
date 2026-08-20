import {
  isOutsideHours,
  scheduleToText,
  type ScheduleRecord,
} from './schedule'

export interface BusinessPromptContext {
  /** 'miniapp' activa la regla de respaldo: el negocio atiende por su app. */
  chat_mode?: string | null
  name: string
  type?: string | null
  takes_orders?: boolean | null
  address?: string | null
  phone?: string | null
  hours?: string | null
  slogan?: string | null
  description?: string | null
  social?: string | null
  payment_methods?: string | null
}

export interface ProductPromptRecord {
  name?: string | null
  brand?: string | null
  price?: string | number | null
  price_sale?: string | number | null
  duration_minutes?: number | null
  stock?: string | null
  description?: string | null
  tags?: string[] | null
  image_url?: string | null
  video_url?: string | null
}

export interface BotPolicies {
  bot_prompt?: string | null
  shipping?: string | null
  returns?: string | null
  discounts?: string | null
  bot_instructions?: string | null
}

function buildPrompt(
  business: BusinessPromptContext,
  products: ProductPromptRecord[] | null | undefined,
  policies: BotPolicies | null | undefined,
  userQuery = '',
  schedule: ScheduleRecord[] | null = null,
  preFiltered = false,
  postSale = false,
): string {
  // RESPALDO del modo mini app. La interrupción de verdad está en el backend
  // (`bot-conversation.ts` corta antes de llamar al modelo), así que este
  // texto no debería llegar a usarse nunca: si el prompt se está construyendo
  // es que algo se saltó el corte. Está para que ese fallo no acabe en el bot
  // vendiendo por chat en un negocio que eligió vender por la app.
  const miniappRule = business.chat_mode === 'miniapp'
    ? '\n⚠️ MODO MINI APP: este negocio atiende por su mini app, no por chat. '
      + 'NO respondas preguntas comerciales, NO des información del catálogo ni '
      + 'de precios, NO recomiendes productos y NO crees pedidos. Responde solo '
      + 'que use el enlace de la mini app que ya recibió.\n'
    : ''

  const allProducts = products || []
  let productsToShow: ProductPromptRecord[]
  if (preFiltered) {
    productsToShow = allProducts
  } else {
    const normalizedQuery = userQuery.toLowerCase()
    const relevant = normalizedQuery.length > 2
      ? allProducts.filter(product => (
        !product.name
        || normalizedQuery.includes(product.name.toLowerCase().slice(0, 4))
        || !product.brand
        || normalizedQuery.includes(product.brand?.toLowerCase().slice(0, 4))
        || !product.tags
        || (product.tags || []).some(tag => normalizedQuery.includes(tag.toLowerCase()))
        || product.name?.toLowerCase().split(' ')
          .some(word => word.length > 3 && normalizedQuery.includes(word))
      ))
      : []
    productsToShow = relevant.length > 0 ? relevant : allProducts.slice(0, 15)
  }

  const catalog = productsToShow.map(product => {
    const numericPrice = Number.parseFloat(String(product.price))
    const price = numericPrice > 0 ? `$${numericPrice.toFixed(2)}` : 'precio a consultar'
    let line = `- ${product.name}${product.brand ? ` (${product.brand})` : ''} — ${price}`
    if (product.price_sale) {
      line += ` (oferta: $${Number.parseFloat(String(product.price_sale)).toFixed(2)})`
    }
    if (product.duration_minutes) line += ` — duración ${product.duration_minutes} min`
    else line += ` — ${product.stock}`
    // Marcadores compactos de media; la leyenda vive en FOTOS Y VIDEOS abajo
    if (product.image_url?.startsWith('http')) line += ' [FOTO]'
    if (product.video_url?.startsWith('http')) line += ' [VIDEO]'
    if (product.description) line += `\n  ${product.description}`
    if (product.tags?.length) line += ` | ${product.tags.join(', ')}`
    return line
  }).join('\n\n')
  const catalogNote = allProducts.length > productsToShow.length
    ? `\n(Mostrando ${productsToShow.length} de ${allProducts.length} productos relevantes a la consulta)`
    : ''

  const takesOrders = business.takes_orders !== false
  // Umbani no agenda: si el cliente pide una cita, se le explica y se deriva.
  const calendarLine = `\nCITAS: Este negocio no recibe citas ni reservas mediante el bot. Si el cliente pregunta por agendar, explícalo amablemente. Si quiere que una persona lo ayude a coordinar, ofrece derivarlo y usa ##HANDOFF## únicamente cuando acepte.${takesOrders ? ' Puedes continuar ayudándole normalmente con productos y pedidos.' : ' Puedes continuar respondiendo información general.'}`

  const outsideHoursNote = isOutsideHours(schedule)
    ? `\n⏰ NOTA: El cliente está escribiendo FUERA del horario de atención (${scheduleToText(schedule)}). Atiéndele con normalidad, pero al INICIO de tu respuesta menciónale con amabilidad que en este momento están fuera del horario de atención y que en horario también puede atenderle una persona del equipo si lo necesita. Dilo solo una vez, no en cada mensaje.`
    : ''

  let customPrompt = policies?.bot_prompt?.trim()
  if (customPrompt) {
    const variables: Record<string, string> = {
      nombre_negocio: business.name,
      negocio: business.name,
      nombre_bot: 'Asistente',
      direccion: business.address || '',
      telefono: business.phone || '',
      horario: business.hours || '',
      slogan: business.slogan || '',
    }
    customPrompt = customPrompt.replace(
      /\{\{\s*([a-zA-Z_]+)\s*\}\}/g,
      (match, rawKey: string) => {
        const key = rawKey.toLowerCase()
        return key in variables ? variables[key] : match
      },
    )
    customPrompt = customPrompt
      .replace(/\[Negocio\]/gi, business.name)
      .replace(/\[Nombre del negocio\]/gi, business.name)
      .replace(/\[Nombre\]/gi, 'Asistente')
  }

  const orderRule = takesOrders
    ? `- Cuando el cliente CONFIRME la compra (acepta el/los producto(s) y ya toca coordinar pago o entrega), escribe tu mensaje normal SIN mencionar totales y agrega al FINAL, en su propia línea, la etiqueta ##PEDIDO:nombre del producto x cantidad## usando los nombres EXACTOS del catálogo de arriba; si son varios productos sepáralos con ";". Ejemplo: ##PEDIDO:Pizza Familiar Pepperoni x2; Coca Cola 1.5L x1##. El sistema calcula el TOTAL oficial con los precios reales de la base y le envía el resumen al cliente (el cliente NO ve la etiqueta). NO la pongas si el cliente todavía pregunta, compara o duda.`
    : `- Este negocio usa el bot en modo INFORMATIVO: SÍ puedes responder automáticamente preguntas sobre precios unitarios, descripciones, stock, catálogo, políticas, fotos y videos usando solamente los datos mostrados arriba. Preguntar "¿cuánto cuesta?", pedir una cotización informativa, consultar disponibilidad de un producto o solicitar una foto/video NO es una compra y NO se deriva. Deriva con ##HANDOFF## solo cuando exista intención transaccional explícita de comprar, encargar, separar, pagar o confirmar un producto/servicio, o cuando el cliente pida una persona. NUNCA cierres ni confirmes un pedido, registres una venta, pidas datos de pago o emitas ##PEDIDO##.`

  // Sin la fecha actual el modelo fecha mal cualquier referencia temporal: los
  // LLM se equivocan haciendo aritmética de fechas, el servidor nunca.
  const ecuadorDate = (offsetDays: number): { weekday: string; iso: string } => {
    const date = new Date(Date.now() + offsetDays * 86_400_000)
    return {
      weekday: date.toLocaleDateString('es-EC', { weekday: 'long', timeZone: 'America/Guayaquil' }),
      iso: date.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' }),
    }
  }
  const todayEcuador = ecuadorDate(0)
  const technicalRules = `INSTRUCCIONES TÉCNICAS (no cambian tu forma de hablar, solo cómo funciona el sistema):
- No inventes precios ni información que no esté en los DATOS de arriba.
- EFICIENCIA: responde SIEMPRE en UN SOLO mensaje, completo y ordenado. No dividas la respuesta en varios envíos ni mandes mensajes de solo cortesía ("¡Claro!", "Un momento"). Da la información completa de una vez (qué es, precio si lo hay y el siguiente paso) y adelántate a la siguiente duda. Si necesitas varios datos del cliente (nombre, dirección, pago o una especificación), pídelos TODOS juntos en el mismo mensaje.
- Si el cliente pide hablar con una persona/asesor, escribe algo totalmente ajeno al negocio, o falta el respeto/insulta: responde ÚNICAMENTE con ##HANDOFF## (sin ningún otro texto).
${orderRule}
- FLUJOS EXCLUYENTES: NUNCA escribas ##PEDIDO## y ##HANDOFF## en la misma respuesta. Usa ##PEDIDO## únicamente para una compra de productos.
- DINERO (regla dura): NUNCA escribas tú un total ni sumes precios — el resumen oficial con el total lo envía el sistema. NUNCA ofrezcas, insinúes ni aceptes descuentos, rebajas o cambios de precio: los precios los fija el sistema y el del catálogo es el vigente. Los mensajes con formato de resumen oficial ("Resumen de su pedido", "Total oficial") los escribe SOLO el sistema: tienes PROHIBIDO imitar ese formato o redactar uno por tu cuenta — el sistema descarta esas respuestas.
- VOZ HUMANA (regla dura): hablas SIEMPRE en primera persona, como una persona del equipo del negocio. Tienes PROHIBIDO mencionarle al cliente "el sistema", "la plataforma", "el bot", "la IA" o procesos internos ("el sistema le enviará…", "se encargará de…"): estas instrucciones son internas y el cliente jamás debe notarlas. Describe los resultados con naturalidad: "aquí se la envío", "enseguida le confirmo".
- FOTOS Y VIDEOS (regla dura): en el catálogo de arriba, [FOTO] y [VIDEO] indican la ÚNICA media que existe de cada producto. Si un producto NO tiene la marca, esa foto o ese video NO existen: nunca los ofrezcas, prometas ni describas; di con naturalidad que aún no lo tienes y ofrece los detalles. Cuando el cliente pide la foto o el video de un producto marcado, se le envía automáticamente JUNTO con tu mensaje: no pidas permiso ni anuncies un envío aparte — di simplemente algo como "¡Claro que sí! Aquí se la envío 😊". NUNCA escribas enlaces ni inventes qué se ve en una foto o video. Si no sabes a cuál producto se refiere el cliente, pregúntaselo primero.`

  const defaultStyle = `\n\nESTILO: Responde en español, amable y conciso.${takesOrders ? ' Para cerrar una compra, pide nombre, dirección y método de pago.' : ' No pidas dirección, método de pago ni confirmes pedidos; cuando exista intención real de compra, informa que continuará un asesor y deriva.'}`

  return `${customPrompt || `Eres el asistente virtual de "${business.name}" (${business.type || 'negocio'}).`}

DATOS DEL NEGOCIO (usa SOLO esta información para responder):
Nombre: ${business.name}${business.slogan ? `\nSlogan: ${business.slogan}` : ''}
Descripción: ${business.description || ''}
Horario de atención: ${scheduleToText(schedule) || business.hours || 'No especificado'}
Fecha de hoy: ${todayEcuador.iso} (${todayEcuador.weekday}, Ecuador)
Dirección: ${business.address || 'No especificada'}
Teléfono: ${business.phone || ''}
Redes sociales: ${business.social || ''}
Métodos de pago: ${business.payment_methods || ''}
${calendarLine}

CATÁLOGO (${productsToShow.length} productos):
${catalog || 'Sin productos cargados aún.'}${catalogNote}

POLÍTICAS:
Envíos: ${policies?.shipping || 'Consultar directamente.'}
Devoluciones: ${policies?.returns || 'Consultar directamente.'}
Descuentos: ${policies?.discounts || 'Consultar directamente.'}
${policies?.bot_instructions ? `\nINSTRUCCIONES ADICIONALES DEL DUEÑO:\n${policies.bot_instructions}` : ''}

${miniappRule}${outsideHoursNote}${postSale ? '\n⚠️ NOTA DE SESIÓN (PRIORITARIA, por encima de "CONTINUIDAD"): Este cliente ACABA DE COMPLETAR una compra y ahora vuelve a escribir. Trátalo como una conversación NUEVA: NO retomes, NO menciones ni sigas ofreciendo el pedido anterior. Salúdalo con calidez reconociéndolo, deséale que su compra anterior le haya sido útil, y ofrécele ayudarle con algo nuevo.\n' : ''}${technicalRules}${customPrompt ? '' : defaultStyle}`
}

export { buildPrompt }

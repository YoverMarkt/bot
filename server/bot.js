const Anthropic = require('@anthropic-ai/sdk')
const OpenAI    = require('openai')
const axios     = require('axios')
const db        = require('./db')
const ycloud    = require('./ycloud')
const settings  = require('./settings')
const reports   = require('./reports')
const moneyCore = require('./money')      // núcleo de dinero: la IA conversa, el código calcula
const payments  = require('./payments')   // pasarelas (enchufable; hoy sin pasarela)
const { businessNeedsCalendar } = require('./calendar')
require('dotenv').config()

// ── ENVÍO DE MENSAJES WhatsApp ────────────────────────────
// Indicador "escribiendo…" real en WhatsApp (YCloud) usando el ID del mensaje entrante
async function sendTyping(biz, inboundId) {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'ycloud' && inboundId) {
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      await ycloud.showTyping(apiKey, inboundId)
    }
    // meta/kapso: sin indicador confiable → la pausa humana hace el efecto
  } catch(e) { /* best-effort, no romper el flujo */ }
}

async function sendText(biz, to, text) {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'meta') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${biz.meta_phone_id}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } },
        { headers: { 'Authorization': `Bearer ${biz.meta_token}`, 'Content-Type': 'application/json' } }
      )
    } else if (provider === 'kapso') {
      const kapsoKey = biz.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        { number_id: biz.kapso_number_id, to, type: 'text', text: { body: text } },
        { headers: { 'Authorization': `Bearer ${kapsoKey}`, 'Content-Type': 'application/json' } }
      )
    } else {
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      const from   = biz.ycloud_number  || biz.whatsapp_number
      await ycloud.sendText(apiKey, from, to, text)
    }
  } catch(e) {
    console.error(`❌ [${provider}] sendText:`, e.response?.data || e.message)
  }
}

async function sendImage(biz, to, imageUrl, caption = '') {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'meta') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${biz.meta_phone_id}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'image', image: { link: imageUrl, caption } },
        { headers: { 'Authorization': `Bearer ${biz.meta_token}`, 'Content-Type': 'application/json' } }
      )
    } else if (provider === 'kapso') {
      const kapsoKey = biz.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        { number_id: biz.kapso_number_id, to, type: 'image', image: { url: imageUrl, caption } },
        { headers: { 'Authorization': `Bearer ${kapsoKey}`, 'Content-Type': 'application/json' } }
      )
    } else {
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      const from   = biz.ycloud_number  || biz.whatsapp_number
      await ycloud.sendImage(apiKey, from, to, imageUrl, caption)
    }
  } catch(e) {
    console.error(`❌ [${provider}] sendImage:`, e.message)
  }
}

async function sendVideo(biz, to, videoUrl, caption = '') {
  const provider = biz.whatsapp_provider || 'ycloud'
  try {
    if (provider === 'meta') {
      await axios.post(
        `https://graph.facebook.com/v19.0/${biz.meta_phone_id}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'video', video: { link: videoUrl, caption } },
        { headers: { 'Authorization': `Bearer ${biz.meta_token}`, 'Content-Type': 'application/json' } }
      )
    } else if (provider === 'kapso') {
      const kapsoKey = biz.kapso_api_key || process.env.KAPSO_API_KEY
      await axios.post(
        'https://api.kapso.ai/v1/messages',
        { number_id: biz.kapso_number_id, to, type: 'video', video: { url: videoUrl, caption } },
        { headers: { 'Authorization': `Bearer ${kapsoKey}`, 'Content-Type': 'application/json' } }
      )
    } else {
      const apiKey = biz.ycloud_api_key || process.env.YCLOUD_API_KEY
      const from   = biz.ycloud_number  || biz.whatsapp_number
      await ycloud.sendVideo(apiKey, from, to, videoUrl, caption)
    }
  } catch(e) {
    console.error(`❌ [${provider}] sendVideo:`, e.message)
  }
}

// ── TRANSCRIPCIÓN DE AUDIO (funciona con cualquier IA configurada) ──
// Claude no transcribe audio → se usa automáticamente Groq/OpenAI/Gemini si están disponibles.
async function transcribeAudio(buffer, filename = 'audio.ogg') {
  const provider = await settings.get('ai_provider') || 'openai'
  const groqKey   = await settings.get('groq_api_key')
  const geminiKey = await settings.get('gemini_api_key')
  const openaiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY

  // Elegir motor de audio: el del proveedor activo si lo soporta, si no el primero disponible
  let engine = ['groq','gemini','openai'].includes(provider) ? provider : null
  if (engine === 'groq'   && !groqKey)   engine = null
  if (engine === 'gemini' && !geminiKey) engine = null
  if (engine === 'openai' && !openaiKey) engine = null
  if (!engine) engine = groqKey ? 'groq' : openaiKey ? 'openai' : geminiKey ? 'gemini' : null
  if (!engine) throw new Error('No hay una IA con transcripción de audio (configura Groq, OpenAI o Gemini)')

  if (engine === 'groq') {
    const groq = new OpenAI({ apiKey: groqKey, baseURL: 'https://api.groq.com/openai/v1' })
    const file = await OpenAI.toFile(buffer, filename)
    const r = await groq.audio.transcriptions.create({ file, model: 'whisper-large-v3', language: 'es' })
    return r.text?.trim() || ''
  }

  if (engine === 'gemini') {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      { contents: [{ parts: [
        { text: 'Transcribe este audio a texto en español. Devuelve SOLO la transcripción, sin comentarios ni comillas.' },
        { inline_data: { mime_type: 'audio/ogg', data: buffer.toString('base64') } }
      ]}] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    )
    return (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  // OpenAI Whisper
  const openai = new OpenAI({ apiKey: openaiKey })
  const file = await OpenAI.toFile(buffer, filename)
  const r = await openai.audio.transcriptions.create({ file, model: 'whisper-1', language: 'es' })
  return r.text?.trim() || ''
}

// ── VISIÓN: identificar un producto desde una foto (OpenAI o Gemini, gratis) ──
async function identifyImage(dataUrl) {
  const provider = await settings.get('ai_provider') || 'openai'
  const promptTxt = 'Eres experto en productos (perfumes, ropa, artículos). Identifica el producto principal de la imagen. Responde SOLO con la marca y el nombre (ejemplos: "Dior Sauvage", "Carolina Herrera 212 VIP", "Nike Air Force 1"). Si no puedes identificarlo con razonable certeza, responde EXACTAMENTE: NO_IDENTIFICADO'

  if (provider === 'groq') {
    const apiKey = await settings.get('groq_api_key')
    if (!apiKey) throw new Error('Falta Groq API Key para analizar imágenes')
    // Groq tiene visión con Llama 4 (compatible OpenAI → image_url)
    const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })
    const r = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: 60,
      messages: [{ role: 'user', content: [
        { type: 'text', text: promptTxt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]}]
    })
    return (r.choices[0].message.content || '').trim()
  }

  if (provider === 'gemini') {
    const apiKey = await settings.get('gemini_api_key')
    if (!apiKey) throw new Error('Falta Gemini API Key para analizar imágenes')
    // dataUrl = "data:image/jpeg;base64,XXXX" → separar mime y base64
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || []
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [ { text: promptTxt }, { inline_data: { mime_type: m[1] || 'image/jpeg', data: m[2] || '' } } ] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    )
    return (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  if (provider === 'claude') {
    const apiKey = await settings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Falta Anthropic API Key para analizar imágenes')
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl) || []
    const claude = new Anthropic({ apiKey })
    const r = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 60,
      messages: [{ role: 'user', content: [
        { type: 'text', text: promptTxt },
        { type: 'image', source: { type: 'base64', media_type: m[1] || 'image/jpeg', data: m[2] || '' } }
      ]}]
    })
    return (r.content[0].text || '').trim()
  }

  const apiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OpenAI API Key para analizar imágenes')
  const openai = new OpenAI({ apiKey })
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini', max_tokens: 60,
    messages: [{ role: 'user', content: [
      { type: 'text', text: promptTxt },
      { type: 'image_url', image_url: { url: dataUrl } }
    ]}]
  })
  return (r.choices[0].message.content || '').trim()
}

// ── EMBEDDINGS (RAG vectorial para catálogos grandes) ────
// Convierte texto en un vector de significado con OpenAI
async function embedText(text) {
  const apiKey = await settings.get('openai_api_key') || process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('Falta OpenAI API Key para generar embeddings')
  const openai = new OpenAI({ apiKey })
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000)
  })
  return r.data[0].embedding
}

// Texto representativo de un producto para su embedding
function productText(p) {
  return [p.name, p.brand, p.description, (p.tags || []).join(' ')].filter(Boolean).join(' — ')
}

// Genera y guarda el embedding de un producto
async function indexProduct(product) {
  try {
    const emb = await embedText(productText(product))
    await db.setProductEmbedding(product.id, emb)
    return true
  } catch(e) { console.error('❌ indexProduct:', e.message); return false }
}

// ── LLAMADA A IA (Claude o OpenAI según configuración) ────
async function callAI(systemPrompt, history, userMessage, bizAiProvider = null) {
  // Cliente tiene prioridad → luego config global → luego 'claude' por defecto
  const provider = bizAiProvider || await settings.get('ai_provider') || 'claude'

  // Normalizar roles: la API solo acepta 'user' y 'assistant'.
  // Los mensajes del dueño ('owner') cuentan como del lado del asistente.
  // NO agregamos fecha al contenido: el modelo la copiaba en sus respuestas.
  const normalize = h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.content
  })

  if (provider === 'groq') {
    const apiKey = await settings.get('groq_api_key')
    if (!apiKey) throw new Error('Falta Groq API Key en Configuración del servidor')
    // Groq es compatible con OpenAI → reutilizamos el SDK con otra baseURL
    const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' })
    const r = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(normalize),
        { role: 'user', content: userMessage }
      ]
    })
    return r.choices[0].message.content
  }

  if (provider === 'deepseek') {
    const apiKey = await settings.get('deepseek_api_key')
    if (!apiKey) throw new Error('Falta DeepSeek API Key en Configuración del servidor')
    // DeepSeek es compatible con OpenAI → reutilizamos el SDK con otra baseURL.
    // Solo texto: audio y visión los cubren los otros proveedores (sentidos automáticos).
    const deepseek = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' })
    const r = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: 800,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(normalize),
        { role: 'user', content: userMessage }
      ]
    })
    return r.choices[0].message.content
  }

  if (provider === 'gemini') {
    const apiKey = await settings.get('gemini_api_key')
    if (!apiKey) throw new Error('Falta Gemini API Key en Configuración del servidor')
    // API nativo de Google (Gemini usa role 'model' para el asistente, y system aparte)
    const contents = [
      ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] })),
      { role: 'user', parts: [{ text: userMessage }] }
    ]
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { maxOutputTokens: 800 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    )
    return (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim()
  }

  if (provider === 'openai') {
    const apiKey = await settings.get('openai_api_key')
    if (!apiKey) throw new Error('Falta OpenAI API Key en Configuración del servidor')
    const openai = new OpenAI({ apiKey })
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map(normalize),
        { role: 'user', content: userMessage }
      ]
    })
    return r.choices[0].message.content
  }

  // Claude (por defecto)
  const apiKey = await settings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('Falta Anthropic API Key')
  const claude = new Anthropic({ apiKey })
  const r = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: [
      ...history.map(normalize),
      { role: 'user', content: userMessage }
    ]
  })
  return r.content[0].text
}

// Convierte la configuración de Horarios (panel del dueño) a texto legible
function scheduleToText(schedule) {
  const DAYS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado']
  const active = (schedule || []).filter(s => s.is_active)
  if (!active.length) return null
  // Ordenar con Lunes primero (Domingo al final)
  const ordered = active.slice().sort((a, b) => ((a.day_of_week + 6) % 7) - ((b.day_of_week + 6) % 7))
  return ordered.map(s => `${DAYS[s.day_of_week]} de ${s.open_time.slice(0,5)} a ${s.close_time.slice(0,5)}`).join(', ')
}

// ¿El cliente escribe FUERA del horario de atención? (hora local de Ecuador)
// Sin horario configurado → false (no se avisa nada).
function isOutsideHours(schedule) {
  const active = (schedule || []).filter(s => s.is_active)
  if (!active.length) return false
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
  const dow = local.getDay()
  const mins = local.getHours() * 60 + local.getMinutes()
  const cfg = active.find(s => s.day_of_week === dow)
  if (!cfg) return true // hoy el negocio no atiende
  const [oh, om] = String(cfg.open_time).split(':').map(Number)
  const [ch, cm] = String(cfg.close_time).split(':').map(Number)
  return mins < (oh * 60 + om) || mins >= (ch * 60 + cm)
}

// ── PROMPT DEL BOT ────────────────────────────────────────
function buildPrompt(biz, products, policies, voiceMode = false, userQuery = '', availableSlots = null, schedule = null, preFiltered = false, postSale = false) {
  const allProducts = products || []
  let toShow
  if (preFiltered) {
    // Ya vienen filtrados por RAG vectorial (los más relevantes a la consulta)
    toShow = allProducts
  } else {
    // Catálogo chico: filtrar por palabras clave (ahorra tokens)
    const queryLow = userQuery.toLowerCase()
    const relevant = queryLow.length > 2
      ? allProducts.filter(p =>
          !p.name   || queryLow.includes(p.name.toLowerCase().slice(0,4))  ||
          !p.brand  || queryLow.includes(p.brand?.toLowerCase().slice(0,4)) ||
          !p.tags   || (p.tags || []).some(t => queryLow.includes(t.toLowerCase())) ||
          p.name?.toLowerCase().split(' ').some(w => w.length > 3 && queryLow.includes(w))
        )
      : []
    toShow = relevant.length > 0 ? relevant : allProducts.slice(0, 15)
  }

  const catalog = toShow.map(p => {
    // Precio 0 (o sin cargar) → "precio a consultar" para que el bot no diga "$0.00"
    const precio = parseFloat(p.price) > 0 ? `$${parseFloat(p.price).toFixed(2)}` : 'precio a consultar'
    let l = `- ${p.name}${p.brand ? ` (${p.brand})` : ''} — ${precio}`
    if (p.price_sale) l += ` (oferta: $${parseFloat(p.price_sale).toFixed(2)})`
    if (p.duration_minutes) l += ` — duración ${p.duration_minutes} min`
    else l += ` — ${p.stock}`
    if (p.description) l += `\n  ${p.description}`
    if (p.tags?.length)  l += ` | ${p.tags.join(', ')}`
    if (!voiceMode && p.image_url && p.image_url.startsWith('http')) l += `\n  (este producto tiene una foto disponible: si el cliente quiere verla, invítalo a pedirla y el sistema se la envía — NUNCA escribas el enlace)`
    if (!voiceMode && p.video_url && p.video_url.startsWith('http')) l += `\n  (este producto tiene un video disponible: si el cliente quiere verlo, invítalo a pedirlo y el sistema se lo envía — NUNCA escribas el enlace)`
    return l
  }).join('\n\n')
  const catalogNote = allProducts.length > toShow.length
    ? `\n(Mostrando ${toShow.length} de ${allProducts.length} productos relevantes a la consulta)`
    : ''

  // Slots disponibles para reservas propias (calendario a medida).
  // Solo se ofrecen reservas a negocios en modo "Con citas" (takes_bookings).
  // Una tienda/distribuidora (p. ej. venta de agua) puede tener horario de atención
  // sin que el bot ofrezca "citas". El interruptor manda; si aún no está definido
  // (BD sin migrar), se cae al tipo de negocio (businessNeedsCalendar) como respaldo.
  let calendarLine = ''
  const takesBookings = biz.takes_bookings ?? businessNeedsCalendar(biz.type)
  if (!voiceMode && availableSlots && Object.keys(availableSlots).length && takesBookings) {
    // Mostrar TODOS los horarios reales del panel del dueño (sin recortar)
    const slotLines = Object.entries(availableSlots).slice(0, 7).map(([date, { label, slots }]) =>
      `  ${label} (${date}): ${slots.join(', ')}`
    ).join('\n')
    calendarLine = `\nRESERVAS — HORARIOS DISPONIBLES (estos son los ÚNICOS horarios válidos, no inventes ni ofrezcas otros):\n${slotLines}\nCuando el cliente quiera reservar: pregunta su nombre, el servicio y la hora. Solo acepta horarios de la lista de arriba. NUNCA adivines ni asumas la hora: incluye la etiqueta de reserva SOLO después de que el cliente haya ELEGIDO y CONFIRMADO una hora exacta de la lista; si todavía no eligió hora, pregúntala y NO pongas la etiqueta todavía. Cuando tengas el nombre, la fecha, la hora y el servicio confirmados, incluye al FINAL de tu mensaje exactamente esta etiqueta:\n##BOOK:NOMBRE|YYYY-MM-DD|HH:MM|SERVICIO##\nUsa la fecha real del día elegido (el número entre paréntesis de la lista de arriba). Ejemplo correcto: ##BOOK:Carlos|2026-06-29|10:00|Corte de cabello##\nNO escribas la palabra FECHA ni paréntesis; pon la fecha tal cual (2026-06-29).`
  } else if (!voiceMode) {
    // Sin sistema de reservas configurado — el bot lo maneja sin derivar a un asesor
    calendarLine = `\nRESERVAS: Este negocio no maneja reservas ni citas en línea. Si el cliente pregunta por agendar, explícalo amablemente y ofrécele ayuda con productos, pedidos o información. NO derives a un asesor por esto.`
  }

  // Aviso "fuera de horario": si el cliente escribe fuera del horario de atención,
  // el bot lo menciona con amabilidad (sin gastar un mensaje aparte) y sigue atendiendo.
  const outsideHoursNote = (!voiceMode && isOutsideHours(schedule))
    ? `\n⏰ NOTA: El cliente está escribiendo FUERA del horario de atención (${scheduleToText(schedule)}). Atiéndele con normalidad, pero al INICIO de tu respuesta menciónale con amabilidad que en este momento están fuera del horario de atención y que en horario también puede atenderle una persona del equipo si lo necesita. Dilo solo una vez, no en cada mensaje.`
    : ''

  // Reemplaza variables del prompt con datos reales del negocio.
  // Soporta {{variable}} (recomendado) y [Variable] (compatibilidad anterior).
  let customPrompt = policies?.bot_prompt?.trim()
  if (customPrompt) {
    const vars = {
      'nombre_negocio': biz.name,
      'negocio': biz.name,
      'nombre_bot': 'Asistente',          // el dueño suele escribir el nombre real en el prompt
      'direccion': biz.address || '',
      'telefono': biz.phone || '',
      'horario': biz.hours || '',
      'slogan': biz.slogan || ''
    }
    // {{variable}}  (insensible a mayúsculas y espacios)
    customPrompt = customPrompt.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, k) => {
      const key = k.toLowerCase()
      return key in vars ? vars[key] : m   // si no la conocemos, la dejamos tal cual
    })
    // [Variable]  (formato anterior, se mantiene)
    customPrompt = customPrompt
      .replace(/\[Negocio\]/gi, biz.name)
      .replace(/\[Nombre del negocio\]/gi, biz.name)
      .replace(/\[Nombre\]/gi, 'Asistente')
  }

  // Reglas técnicas mínimas (mecánica de derivar) — NO imponen tono ni personalidad
  // Modo venta por negocio: true (default) = el bot cierra pedidos con ##PEDIDO##;
  // false = solo informativo → deriva al asesor si el cliente quiere comprar.
  const takesOrders = biz.takes_orders !== false
  const orderRule = takesOrders
    ? `- Cuando el cliente CONFIRME la compra (acepta el/los producto(s) y ya toca coordinar pago o entrega), escribe tu mensaje normal SIN mencionar totales y agrega al FINAL, en su propia línea, la etiqueta ##PEDIDO:nombre del producto x cantidad## usando los nombres EXACTOS del catálogo de arriba; si son varios productos sepáralos con ";". Ejemplo: ##PEDIDO:Pizza Familiar Pepperoni x2; Coca Cola 1.5L x1##. El sistema calcula el TOTAL oficial con los precios reales de la base y le envía el resumen al cliente (el cliente NO ve la etiqueta). NO la pongas si el cliente todavía pregunta, compara o duda.`
    : `- Este negocio NO gestiona ventas por el bot: si el cliente quiere comprar, cotizar o cerrar un pedido, NO lo gestiones tú — respóndele con amabilidad que un asesor del equipo continuará con él y agrega al FINAL ##HANDOFF## (el sistema deriva el chat). NUNCA pidas datos de pago ni confirmes pedidos.`

  const funcRules = `INSTRUCCIONES TÉCNICAS (no cambian tu forma de hablar, solo cómo funciona el sistema):
- No inventes precios ni información que no esté en los DATOS de arriba.
- EFICIENCIA: responde SIEMPRE en UN SOLO mensaje, completo y ordenado. No dividas la respuesta en varios envíos ni mandes mensajes de solo cortesía ("¡Claro!", "Un momento"). Da la información completa de una vez (qué es, precio si lo hay y el siguiente paso) y adelántate a la siguiente duda. Si necesitas varios datos del cliente (nombre, dirección, pago o una especificación), pídelos TODOS juntos en el mismo mensaje.
- Si el cliente pide hablar con una persona/asesor, escribe algo totalmente ajeno al negocio, o falta el respeto/insulta: responde ÚNICAMENTE con ##HANDOFF## (sin ningún otro texto).
${orderRule}
- DINERO (regla dura): NUNCA escribas tú un total ni sumes precios — el resumen oficial con el total lo envía el sistema. NUNCA ofrezcas, insinúes ni aceptes descuentos, rebajas o cambios de precio: los precios los fija el sistema y el del catálogo es el vigente.
- FOTOS Y VIDEOS: si el cliente pide ver una foto o un video de un producto, responde breve y natural (ej.: "Con gusto, permítame y se lo muestro 😊"). NO afirmes qué tipo de archivo es, NO des por hecho que exista y NUNCA escribas enlaces: el sistema se encarga de enviarle EXACTAMENTE la media que ese producto tenga (o de avisarle si no hay). Si no estás seguro de a cuál producto se refiere, pregúntaselo antes.`

  // Estilo por defecto SOLO si el dueño no definió su propio prompt
  const defaultStyle = `\n\nESTILO: Responde en español, amable y conciso.${voiceMode ? ' Es una llamada de voz: sin markdown ni emojis.' : ''} Si el cliente quiere comprar, pide nombre, dirección y método de pago.`

  return `${customPrompt || `Eres el asistente virtual de "${biz.name}" (${biz.type || 'negocio'}).`}

DATOS DEL NEGOCIO (usa SOLO esta información para responder):
Nombre: ${biz.name}${biz.slogan ? `\nSlogan: ${biz.slogan}` : ''}
Descripción: ${biz.description || ''}
Horario de atención: ${scheduleToText(schedule) || biz.hours || 'No especificado'}
Dirección: ${biz.address || 'No especificada'}
Teléfono: ${biz.phone || ''}
Redes sociales: ${biz.social || ''}
Métodos de pago: ${biz.payment_methods || ''}
${calendarLine}

CATÁLOGO (${toShow.length} productos):
${catalog || 'Sin productos cargados aún.'}${catalogNote}

POLÍTICAS:
Envíos: ${policies?.shipping || 'Consultar directamente.'}
Devoluciones: ${policies?.returns || 'Consultar directamente.'}
Descuentos: ${policies?.discounts || 'Consultar directamente.'}
${policies?.bot_instructions ? `\nINSTRUCCIONES ADICIONALES DEL DUEÑO:\n${policies.bot_instructions}` : ''}

${outsideHoursNote}${postSale ? '\n⚠️ NOTA DE SESIÓN (PRIORITARIA, por encima de "CONTINUIDAD"): Este cliente ACABA DE COMPLETAR una compra y ahora vuelve a escribir. Trátalo como una conversación NUEVA: NO retomes, NO menciones ni sigas ofreciendo el pedido anterior. Salúdalo con calidez reconociéndolo, deséale que su compra anterior le haya sido útil, y ofrécele ayudarle con algo nuevo.\n' : ''}${funcRules}${customPrompt ? '' : defaultStyle}`
}

// Devuelve el Buffer de la imagen de un producto (base64 o URL externa)
async function getImageBuffer(product) {
  if (!product?.image_url) return null
  if (product.image_url.startsWith('data:')) {
    const base64 = product.image_url.split(',')[1]
    return Buffer.from(base64, 'base64')
  }
  if (product.image_url.startsWith('http')) {
    const r = await axios.get(product.image_url, { responseType: 'arraybuffer', timeout: 8000 })
    return Buffer.from(r.data)
  }
  return null
}

// URL pública para WhatsApp (necesita BASE_URL o tunnel activo)
function getImageUrl(product) {
  if (!product?.image_url) return null
  if (product.image_url.startsWith('http')) return product.image_url
  const base = process.env.BASE_URL
  if (base) return `${base}/api/images/${product.id}`
  return null // Sin BASE_URL no hay URL pública para WhatsApp
}

const UNCERTAINTY_PHRASES = [
  'déjame verificar', 'dejame verificar', 'te confirmo en breve',
  'no tengo información', 'no tengo informacion', 'no cuento con esa información',
  'no está en mi información', 'no encuentro', 'no puedo confirmar',
  'consultar directamente', 'no lo sé', 'no lo se', 'no estoy seguro',
  'no tengo ese dato', 'no tengo ese detalle'
]

// Insultos por PALABRA COMPLETA (evita falsos positivos como "frasco"→"asco")
const INSULT_WORDS = new Set([
  'idiota','idiotas','imbecil','imbeciles','estupido','estupida','estupidos','estupidas','estupidez',
  'maldito','maldita','malditos','malditas','inutil','inutiles','pendejo','pendeja','pendejos',
  'cabron','cabrona','cabrones','puta','puto','putas','putos','hijueputa','hijoputa','hdp','hpta',
  'malparido','malparida','gonorrea','basura','porqueria','mierda','callate','tarado','tarada',
  'marica','maricon','maricón','verga','culero','culiao','joder','jodete','pinche','zorra','perra',
  'estafador','estafadores','estafa','ladron','ladrones','ratero','sinverguenza','asqueroso','asquerosa',
  'fuck','fucking','bitch','idiot','asshole','stupid','shit','wtf','damn'
])
// Frases ofensivas (varias palabras)
const INSULT_PHRASES = [
  'te odio','los odio','me fastidias','me tienes harto','me tienes harta','no sirves','no sirven',
  'son una estafa','son unos','eres un idiota','eres una','vete a la','andate a la','vayan a la',
  'que mierda','una mierda','de mierda'
]

// Frases que indican que el bot CERRÓ una venta (respaldo, además de la etiqueta ##VENTA##)
const SALE_PHRASES = [
  'gracias por tu compra','gracias por su compra','gracias por tu pedido','gracias por su pedido',
  'felicidades por tu compra','felicidades por su compra','felicitaciones por tu compra','felicitaciones por su compra',
  'coordinar la entrega','coordinaremos la entrega','para la entrega','su pedido está listo','tu pedido está listo',
  'confirmar su pedido','confirmar tu pedido','compra realizada','pedido confirmado',
  // Cierres inequívocos (post-confirmación). NO incluir frases que el bot use en preguntas
  // (ej. "¿desea proceder con la compra?") para evitar falsos positivos.
  'gracias por su pedido','queda anotado su pedido','queda apartado','tu compra quedó registrada','su compra quedó registrada'
]

// Normaliza: minúsculas, sin acentos, solo letras/números → array de palabras
function normalizeWords(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean)
}

// ¿El mensaje contiene un insulto? (palabra completa o frase)
function isInsultMessage(text) {
  const words = normalizeWords(text)
  if (words.some(w => INSULT_WORDS.has(w))) return true
  const norm = words.join(' ')
  return INSULT_PHRASES.some(p => norm.includes(p.normalize('NFD').replace(/[̀-ͯ]/g, '')))
}


// Envío "humanizado": muestra "escribiendo…" y manda con pausa natural (no de golpe)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function humanizedSend(text, sendFn, sendTyping) {
  // Divide en partes naturales por párrafos (máx 3) para que no llegue todo de golpe
  let parts = String(text || '').split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean)
  if (!parts.length) parts = [String(text || '')]
  if (parts.length > 3) parts = [parts.slice(0, parts.length - 2).join('\n\n'), parts[parts.length-2], parts[parts.length-1]]
  for (const part of parts) {
    if (sendTyping) { try { await sendTyping() } catch(e){} }
    // Pausa proporcional a la longitud (≈ velocidad de tecleo humano): entre 0.9s y 4.5s
    await sleep(Math.min(4500, 900 + part.length * 28))
    await sendFn(part)
  }
}

// ── LÓGICA CENTRAL ────────────────────────────────────────
async function processMessage(biz, from, text, sendFn, sendImageFn, sendTyping, sendVideoFn) {
  if (biz.suspended) {
    await sendFn('⚠️ Este servicio tiene un pago pendiente. Contacta al administrador para regularizar tu cuenta. Disculpa los inconvenientes.')
    return console.log(`⛔ [${biz.name}] suspendido — aviso enviado`)
  }
  if (!biz.bot_active) return console.log(`⏸️  [${biz.name}] bot inactivo`)

  // ── Reportes para el DUEÑO (capa previa) ──────────────────
  // Si quien escribe es el owner_phone y pide un reporte, se responde el
  // reporte y se corta (no toca el prompt de atención al cliente).
  // Si no es el dueño o no es un reporte → handled:false y sigue el flujo normal.
  const rep = await reports.handleOwnerMessage(biz, from, text)
  if (rep.handled) {
    await sendFn(rep.reply)
    console.log(`📊 [${biz.name}] reporte entregado al dueño (${from})`)
    return
  }

  // Verificar si esta conversación está en modo manual
  const session = await db.getSession(biz.id, from)
  if (session?.manual_mode) {
    // Solo guardar el mensaje, el dueño responde manualmente
    await db.saveMessage(biz.id, from, 'user', text)
    await db.upsertSession(biz.id, from, { manual_mode: true, last_message: text, last_message_at: new Date().toISOString(), unread_owner: true })
    console.log(`🤚 [${biz.name}] modo manual — mensaje de ${from} guardado para el dueño`)
    return
  }

  // Detectar insultos — disparo inmediato (capa rápida, sin depender de la IA)
  if (isInsultMessage(text)) {
    const insultHandoff = 'Entiendo que puede haber frustración 🙏 Permítame transferirle con un asesor de nuestro equipo que podrá ayudarle mejor.'
    await db.saveMessage(biz.id, from, 'user', text)
    await db.upsertSession(biz.id, from, { manual_mode: true, last_message: text, last_message_at: new Date().toISOString(), unread_owner: true })
    await db.saveMessage(biz.id, from, 'assistant', insultHandoff)
    await sendFn(insultHandoff)
    console.log(`🤚 [${biz.name}] handoff por insulto/falta de respeto — ${from}`)
    return
  }

  // Mostrar "escribiendo…" YA (mientras la IA piensa) — se quita al enviar la respuesta
  if (sendTyping) { try { await sendTyping() } catch(e){} }

  // Historial largo solo si el cliente hace referencia al pasado (ahorra tokens)
  const needsMemory = /vez pasada|anterior|última vez|last time|antes|pedí|ordené|compré/i.test(text)
  const historyLimit = needsMemory ? 24 : 8

  const [policies, history, availableSlots, schedule, totalProducts] = await Promise.all([
    db.getPolicies(biz.id),
    // Corte de historial: si el dueño cerró la venta, el bot ignora lo anterior a ese punto
    db.getContactHistory(biz.id, from, historyLimit, session?.closed_sale_at || null),
    db.getAvailableSlots(biz.id).catch(() => null),
    db.getSchedule(biz.id).catch(() => []),
    db.countProducts(biz.id).catch(() => 0)
  ])

  // Post-venta: hubo un cierre y el bot aún no ha saludado tras ese corte (primer mensaje nuevo)
  const postSale = !!(session?.closed_sale_at) && !history.some(m => m.role === 'assistant')

  // Selección de productos: RAG vectorial si el catálogo es grande, completo si es chico
  let products = []
  let preFiltered = false
  if (totalProducts > 40) {
    try {
      const emb = await embedText(text)
      const vec = await db.searchProductsByVector(biz.id, emb, 12)
      if (vec && vec.length) { products = vec; preFiltered = true; console.log(`🔎 [${biz.name}] RAG: ${vec.length} de ${totalProducts} productos relevantes`) }
    } catch(e) { console.error('RAG (usando fallback):', e.message) }
  }
  if (!products.length) products = await db.getProducts(biz.id) // catálogo chico o sin embeddings

  await db.saveMessage(biz.id, from, 'user', text)

  const textLow = text.toLowerCase()

  // Registrar consultas de productos: cuenta los productos que el cliente menciona
  // (coincidencia por nombre/marca/etiqueta, no todo el RAG → preciso). Async, no bloquea.
  try {
    const mentioned = (products || []).filter(p => {
      const n = (p.name || '').toLowerCase()
      if (n && textLow.includes(n)) return true
      if (n.split(/\s+/).some(w => w.length > 3 && textLow.includes(w))) return true
      if (p.brand && p.brand.length > 2 && textLow.includes(p.brand.toLowerCase())) return true
      if ((p.tags || []).some(t => t && t.length > 3 && textLow.includes(t.toLowerCase()))) return true
      return false
    }).slice(0, 5)
    if (mentioned.length) db.recordConsultations(biz.id, mentioned.map(p => p.id)).catch(() => {})
  } catch(e) {}

  // Detectar si el usuario pide ver una foto o un video de un producto — el servidor lo maneja
  const wantsImage   = /imagen|im[aá]genes|foto|fotos|mu[eé]strame|muestrame|ens[eé][ñn]ame|ensename|c[oó]mo se ve|como se ve/i.test(text)
  const wantsVideo   = /v[íi]deos?/i.test(text)

  let reply = ''
  try {
    reply = await callAI(buildPrompt(biz, products, policies, false, text, availableSlots, schedule, preFiltered, postSale), history, text, biz.ai_provider)
  } catch(e) {
    console.error('❌ IA:', e.message)
    reply = 'Disculpa, tuve un problema técnico. Intenta de nuevo 🙏'
  }

  // Limpiar etiquetas residuales que el modelo pueda generar
  let finalText = reply
    .replace(/##IMG##[\s\S]*?(##|$)/g, '')
    .replace(/##CATALOG##/g, '')
    // Red de seguridad: si el modelo filtró el marcador o el enlace de la media, se quitan
    // (la foto/video se envían aparte como archivo, el cliente no debe ver la URL)
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/https?:\/\/res\.cloudinary\.com\/\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  // Reserva nativa ##BOOK:nombre|fecha|hora|servicio##
  const bookMatch = finalText.match(/##BOOK:([^|]+)\|([^|]+)\|([^|]+)\|([^#]+)##/)
  if (bookMatch) {
    finalText = finalText.replace(bookMatch[0], '').trim()
    const [, contactName, bookingDateRaw, bookingTimeRaw, service] = bookMatch
    // Extraer fecha YYYY-MM-DD y hora HH:MM aunque el modelo agregue texto extra
    const dateM = bookingDateRaw.match(/\d{4}-\d{2}-\d{2}/)
    const timeM = bookingTimeRaw.match(/\d{1,2}:\d{2}/)
    try {
      if (!dateM || !timeM) throw new Error(`formato inválido: fecha="${bookingDateRaw}" hora="${bookingTimeRaw}"`)
      const bookingDate = dateM[0]
      const bookingTime = timeM[0]
      // Buscar la duración del servicio reservado (match por nombre)
      const svcLow = service.trim().toLowerCase()
      const matched = (products || []).find(p =>
        p.name && (svcLow.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(svcLow))
      )
      const duration = matched?.duration_minutes || null

      const { error: bkErr } = await db.createBooking({
        business_id: biz.id,
        contact_phone: from,
        contact_name: contactName.trim(),
        service: service.trim(),
        booking_date: bookingDate,
        booking_time: bookingTime,
        duration_minutes: duration,
        status: 'pending'
      })
      if (bkErr) throw new Error(bkErr.message)
      console.log(`📅 [${biz.name}] Reserva creada: ${contactName} — ${service} (${duration||'?'}min) — ${bookingDate} ${bookingTime}`)
    } catch(e) { console.error('❌ Error creando reserva:', e.message) }
  }

  // Cal.com fue retirado: si la etiqueta ##BOOKING## apareciera por un prompt viejo,
  // se limpia del texto (las reservas nativas usan ##BOOK:...## más arriba).
  finalText = finalText.replace('##BOOKING##', '').trim()

  // ── NÚCLEO DE DINERO: ##PEDIDO:producto x cantidad; ...## ──
  // La IA solo arma la LISTA del pedido; los precios y el TOTAL los calcula el
  // SERVIDOR leyendo la base (la IA jamás decide un monto). Aquí solo se captura
  // el payload; el pedido se procesa después de enviar la respuesta.
  let pedidoPayload = null
  const pedidoMatch = finalText.match(/##\s*PEDIDO\s*:\s*([^#]+)##/i)
  if (pedidoMatch) {
    pedidoPayload = pedidoMatch[1].trim()
    finalText = finalText.replace(pedidoMatch[0], '').trim()
  }

  // Venta cerrada → avisar al dueño (modo manual + alarma). Se detecta por:
  //  (a) etiqueta ##PEDIDO:...## (nueva, con detalle) o ##VENTA##/##PEDIDO## simples, o
  //  (b) frases típicas de cierre de venta (respaldo, funciona con prompts existentes)
  const saleTag = /##\s*(venta|pedido)\s*##/i.test(finalText)
  finalText = finalText.replace(/##\s*(venta|pedido)\s*##/gi, '').trim()
  const saleLow = finalText.toLowerCase()
  const hasSale = saleTag || !!pedidoPayload || SALE_PHRASES.some(p => saleLow.includes(p))

  // Detectar handoff → la IA emite ##HANDOFF## cuando no puede ayudar (detección confiable)
  // Respaldo: frases de incertidumbre por si el modelo no usa la etiqueta
  const replyLow = finalText.toLowerCase()
  const hasHandoffTag = /##\s*handoff\s*##/i.test(finalText)
  const isUncertain = hasHandoffTag || UNCERTAINTY_PHRASES.some(p => replyLow.includes(p))
  const wasManual = session?.manual_mode

  if (isUncertain && !wasManual) {
    const handoffMsg = 'Permítame un momento por favor 🙏 enseguida un asesor de nuestro equipo continuará con usted para ayudarle mejor ✨'
    const { error: sessErr } = await db.upsertSession(biz.id, from, { manual_mode: true, last_message: text, last_message_at: new Date().toISOString(), unread_owner: true })
    if (sessErr) console.error(`❌ upsertSession error:`, sessErr)
    else console.log(`🤚 [${biz.name}] manual_mode=true guardado para ${from}`)
    // Reporte de IA: guardar la pregunta que el bot no supo responder (async, no bloquea)
    db.recordAiGap(biz.id, from, text, hasHandoffTag ? 'handoff' : 'uncertain').catch(e => console.error('❌ recordAiGap:', e.message))
    await db.saveMessage(biz.id, from, 'assistant', handoffMsg)
    await sendFn(handoffMsg)
    return
  } else if (hasSale) {
    // Venta confirmada → pasar a manual y disparar la alarma para que el dueño coordine
    await db.upsertSession(biz.id, from, { manual_mode: true, last_message: text, last_message_at: new Date().toISOString(), unread_owner: true })
    console.log(`🛒 [${biz.name}] VENTA detectada — chat a manual para confirmar/coordinar — ${from}`)
  } else if (!isUncertain) {
    await db.upsertSession(biz.id, from, { manual_mode: false, last_message: text, last_message_at: new Date().toISOString(), unread_owner: false })
  }

  await humanizedSend(finalText, sendFn, sendTyping)

  // ── Procesar el pedido (##PEDIDO##): total oficial calculado por CÓDIGO ──
  // Resolución ESTRICTA contra el catálogo real: si UN solo ítem no se resuelve
  // con certeza (o no tiene precio), NO se envía ningún total — el chat ya quedó
  // en manual (hasSale) y el dueño lo cierra a mano. Con dinero no se adivina.
  // Blindaje modo informativo: si el negocio NO vende por bot (takes_orders=false),
  // se ignora cualquier ##PEDIDO## que el modelo emita por error (el chat igual
  // pasó a manual por hasSale → el dueño lo atiende; jamás se crea un pedido).
  if (pedidoPayload && biz.takes_orders === false) {
    console.log(`🚫 [${biz.name}] ##PEDIDO## ignorado — negocio en modo informativo (takes_orders=false)`)
    pedidoPayload = null
  }
  if (pedidoPayload) {
    try {
      const fullCatalog = preFiltered ? await db.getProducts(biz.id) : (products || [])
      const parsed = moneyCore.parseItems(pedidoPayload)
      const { resolved, unresolved } = moneyCore.resolveItems(parsed, fullCatalog)
      if (parsed.length && !unresolved.length) {
        const order = moneyCore.computeOrder(resolved)
        const { data: saved, error: ordErr } = await db.createOrder({
          business_id: biz.id,
          contact_phone: from,
          contact_name: session?.contact_name || null,
          status: 'pendiente',
          subtotal: order.subtotal,
          discount: order.discount,
          total: order.total
        }, order.items)
        if (ordErr) throw new Error(ordErr.message)
        const payLink = await payments.createPaymentLink(biz, saved)   // hoy null; mañana DeUna u otra
        if (payLink) await db.updateOrder(biz.id, saved.id, { payment_link: payLink })
        const summary = moneyCore.buildSummary(order, payLink)
        await sendFn(summary)
        await db.saveMessage(biz.id, from, 'assistant', summary)
        console.log(`🧾 [${biz.name}] Pedido #${saved.id.slice(0, 8)} — total oficial $${order.total.toFixed(2)} (${order.items.length} ítems) — ${from}`)
      } else {
        console.log(`⚠️ [${biz.name}] Pedido SIN total oficial — ítems no resueltos: ${unresolved.join(' | ') || '(vacío)'} — pasa al dueño`)
      }
    } catch(e) { console.error('❌ procesando pedido:', e.message) }
  }

  // — Envío de fotos/videos de producto (Cloudinary) — PRECISO Y ESTRICTO —
  // Identifica UN producto (el que se está hablando) y envía SOLO la media que ESE
  // producto realmente tiene, diferenciando imagen/video/ambos/ninguno. Nunca manda
  // media de un producto que no se pidió, ni afirma tener algo que no existe.
  // (Meta cobra por mensaje → jamás se vuelca el catálogo.)
  try {
    if ((wantsImage || wantsVideo) && sendFn) {
      const fullCatalog = preFiltered ? await db.getProducts(biz.id) : (products || [])
      const norm = s => (s || '').toLowerCase()
      // Qué tan claramente un texto se refiere a un producto:
      // nombre completo (100) > SKU (90) > marca (50) > nº de palabras distintivas (>=6 letras) presentes.
      const scoreOf = (p, hay) => {
        const h = norm(hay), name = norm(p.name)
        if (name.length > 4 && h.includes(name)) return 100
        if (p.external_sku && norm(p.external_sku).length >= 4 && h.includes(norm(p.external_sku))) return 90
        if (p.brand && norm(p.brand).length > 2 && h.includes(norm(p.brand))) return 50
        const toks = [...new Set(name.split(/[\s\-\/",()]+/).filter(w => w.length >= 6))]
        return toks.filter(w => h.includes(w)).length
      }
      // Busca el producto objetivo de lo MÁS reciente a lo más viejo (mensaje actual → respuesta → historial).
      // Exige match confiable (>= 2) para no adivinar y mandar el producto equivocado.
      const layers = [text, reply, ...(history || []).slice().reverse().slice(0, 8).map(h => h.content || '')]
      let target = null
      for (const layer of layers) {
        let best = null, bestScore = 0
        for (const p of fullCatalog) { const s = scoreOf(p, layer); if (s > bestScore) { bestScore = s; best = p } }
        if (bestScore >= 2) { target = best; break }
      }

      if (!target) {
        console.log(`ℹ️  [${biz.name}] pidió foto/video pero no identifiqué con certeza el producto → no se envía media`)
      } else {
        const hasImg = !!(target.image_url && String(target.image_url).startsWith('http'))
        const hasVid = !!(target.video_url && String(target.video_url).startsWith('http'))
        const sendImg = async () => { try { await sendImageFn(target.image_url, target.name); console.log(`🖼️  Imagen enviada: ${target.name}`) } catch(e){ console.error('❌ img:', e.message) } }
        const sendVid = async () => { try { await sendVideoFn(target.video_url, target.name); console.log(`🎬 Video enviado: ${target.name}`) } catch(e){ console.error('❌ video:', e.message) } }
        const sinMedia = 'De ese producto todavía no tengo foto ni video 🙏, pero con gusto le doy todos los detalles.'

        if (wantsImage && wantsVideo) {                 // pidió ambos
          if (hasImg && sendImageFn) await sendImg()
          if (hasVid && sendVideoFn) await sendVid()
          if (!hasImg && !hasVid) await sendFn(sinMedia)
          else if (!hasImg) await sendFn('De ese producto no tengo foto, solo el video 👆')
          else if (!hasVid) await sendFn('De ese producto no tengo video, solo la foto 👆')
        } else if (wantsImage) {                          // pidió foto
          if (hasImg && sendImageFn) await sendImg()
          else if (hasVid && sendVideoFn) { await sendFn('De ese producto no tengo foto, pero le comparto un video 👇'); await sendVid() }
          else await sendFn(sinMedia)
        } else if (wantsVideo) {                          // pidió video
          if (hasVid && sendVideoFn) await sendVid()
          else if (hasImg && sendImageFn) { await sendFn('De ese producto no tengo video, pero le comparto una foto 👇'); await sendImg() }
          else await sendFn(sinMedia)
        }
      }
    }
  } catch(e) { console.error('❌ envío de media:', e.message) }

  await db.saveMessage(biz.id, from, 'assistant', finalText)
  console.log(`🤖 [${biz.name}] respondido`)
}

// ── ENTRADA PRINCIPAL (con agrupador anti doble-respuesta) ──
// Si el cliente manda varios mensajes seguidos, se juntan y se responde UNA vez.
const msgBuffers = new Map()   // key -> { texts, timer, bizPhone, opts }
const DEBOUNCE_MS = 3000

async function handleMessage(from, text, bizPhone, opts = {}) {
  const key = (opts.slug || bizPhone || '') + '::' + from
  const buf = msgBuffers.get(key) || { texts: [] }
  buf.texts.push(text)
  buf.bizPhone = bizPhone
  buf.opts = opts                       // conserva el último contexto (inboundId, ctx, slug)
  clearTimeout(buf.timer)
  buf.timer = setTimeout(() => {
    msgBuffers.delete(key)
    const combined = buf.texts.join('\n').trim()
    runMessage(from, combined, buf.bizPhone, buf.opts)
      .catch(e => console.error('❌ handleMessage:', e.message))
  }, DEBOUNCE_MS)
  msgBuffers.set(key, buf)
}

async function runMessage(from, text, bizPhone, opts = {}) {
  if (opts.channel === 'telegram') {
    const biz = await db.getBusinessBySlug(opts.slug)
    if (!biz) return opts.ctx?.reply('❌ Negocio no encontrado')
    console.log(`\n📩 [TG:${opts.slug}] de ${from}: "${text}"`)
    return processMessage(
      biz, from, text,
      t => opts.ctx.reply(t),
      async (url, cap) => {
        try {
          const buf = await getImageBuffer({ image_url: url })
          if (buf) await opts.ctx.replyWithPhoto({ source: buf }, { caption: cap })
          else await opts.ctx.replyWithPhoto({ url }, { caption: cap })
        } catch(e) { console.error('❌ TG foto:', e.message) }
      },
      () => opts.ctx.sendChatAction('typing'),   // "escribiendo…" en Telegram
      async (url, cap) => { try { await opts.ctx.replyWithVideo({ url }, { caption: cap }) } catch(e) { console.error('❌ TG video:', e.message) } }
    )
  }

  console.log(`\n📩 [WA:${bizPhone}] de ${from}: "${text}"`)
  const biz = await db.getBusinessByPhone(bizPhone)
  if (!biz) return console.log('⚠️  Negocio no encontrado:', bizPhone)

  return processMessage(
    biz, from, text,
    t  => sendText(biz, from, t),
    (url, cap) => sendImage(biz, from, url, cap),
    () => sendTyping(biz, opts.inboundId),        // indicador real "escribiendo…" en WhatsApp (YCloud)
    (url, cap) => sendVideo(biz, from, url, cap)
  )
}

// ── ENTRADA: IMAGEN (foto de un producto) ────────────────
async function handleImage(from, imageBuffer, mimeType, bizPhone, opts = {}) {
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`
  let identified = 'NO_IDENTIFICADO'
  try { identified = await identifyImage(dataUrl) } catch(e) { console.error('❌ visión:', e.message) }
  const isId = !/NO_IDENTIFICADO/i.test(identified)
  console.log(`🖼️  imagen de ${from}: ${isId ? identified : 'no identificado'}`)

  // Convertimos la imagen en una consulta de texto → reusa todo el flujo (RAG, prompt, etc.)
  const query = isId
    ? `El cliente envió una FOTO de este producto: "${identified}". Dile si lo tenemos disponible (búscalo en el catálogo) y su precio; si no lo tenemos, ofrécele alternativas similares del catálogo.`
    : `El cliente envió una foto de un producto pero no se pudo identificar con claridad. Pídele amablemente el nombre o la marca para ayudarlo a buscarlo.`

  if (opts.channel === 'telegram') {
    const biz = await db.getBusinessBySlug(opts.slug)
    if (!biz) return opts.ctx?.reply('❌ Negocio no encontrado')
    return processMessage(
      biz, from, query,
      t => opts.ctx.reply(t),
      async (url, cap) => { try { const buf = await getImageBuffer({ image_url: url }); if (buf) await opts.ctx.replyWithPhoto({ source: buf }, { caption: cap }) } catch(e){} },
      () => opts.ctx.sendChatAction('typing'),
      async (url, cap) => { try { await opts.ctx.replyWithVideo({ url }, { caption: cap }) } catch(e) { console.error('❌ TG video:', e.message) } }
    )
  }

  const biz = await db.getBusinessByPhone(bizPhone)
  if (!biz) return console.log('⚠️  Negocio no encontrado:', bizPhone)
  return processMessage(
    biz, from, query,
    t => sendText(biz, from, t),
    (url, cap) => sendImage(biz, from, url, cap),
    () => sendTyping(biz, opts.inboundId),
    (url, cap) => sendVideo(biz, from, url, cap)
  )
}

const sendWhatsAppMessage = (biz, to, text) => sendText(biz, to, text)
module.exports = { handleMessage, handleImage, processMessage, buildPrompt, callAI, sendWhatsAppMessage, transcribeAudio, embedText, indexProduct }

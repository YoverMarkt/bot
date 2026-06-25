const Anthropic = require('@anthropic-ai/sdk')
const db        = require('./db')

// Retell AI — Custom LLM endpoint
// Configura en retell.ai: LLM → Custom LLM → URL = https://tu-dominio/api/retell/llm

async function handleRetellLLM(req, res) {
  const { interaction_type, transcript, response_id, call } = req.body

  // Ping inicial de Retell
  if (interaction_type === 'call_details' || interaction_type === 'ping_pong') {
    return res.json({ response_type: 'ping_pong', timestamp: Date.now() })
  }

  const toNumber   = (call?.to_number || '').replace(/\D/g, '')
  const fromNumber = (call?.from_number || '').replace(/\D/g, '')

  try {
    // Buscar el negocio por el número destino (número del bot)
    const biz = toNumber ? await db.getBusinessByPhone(toNumber) : null

    if (!biz) {
      return res.json({
        response_type: 'response',
        response_id: response_id || 1,
        content: 'Lo siento, no pude identificar el negocio. Por favor intenta de nuevo.',
        content_complete: true
      })
    }

    if (biz.suspended) {
      return res.json({
        response_type: 'response',
        response_id: response_id || 1,
        content: 'Este servicio tiene un pago pendiente. Contacta al administrador.',
        content_complete: true
      })
    }

    const [products, policies] = await Promise.all([
      db.getProducts(biz.id),
      db.getPolicies(biz.id)
    ])

    const systemPrompt = buildVoicePrompt(biz, products, policies)

    const messages = (transcript || [])
      .filter(t => t.content)
      .map(t => ({ role: t.role === 'agent' ? 'assistant' : 'user', content: t.content }))

    if (!messages.length) {
      messages.push({ role: 'user', content: 'Hola' })
    }

    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const r = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages
    })

    let content = r.content[0].text
      .replace(/##IMG##[^#]+##/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/##BOOKING##/g, 'Puedes agendar en línea. ¿Quieres que te dé el enlace?')
      .trim()

    await db.saveMessage(biz.id, `voice_${fromNumber}`, 'user', transcript?.at(-1)?.content || '')
    await db.saveMessage(biz.id, `voice_${fromNumber}`, 'assistant', content)

    console.log(`📞 [Retell] ${biz.name} — respondido`)
    return res.json({
      response_type: 'response',
      response_id: response_id || 1,
      content,
      content_complete: true
    })
  } catch(e) {
    console.error('❌ Retell LLM:', e.message)
    return res.json({
      response_type: 'response',
      response_id: response_id || 1,
      content: 'Disculpa el inconveniente. ¿Puedes repetir tu consulta?',
      content_complete: true
    })
  }
}

function buildVoicePrompt(biz, products, policies) {
  const catalog = (products || []).slice(0, 10).map(p =>
    `- ${p.name}${p.brand ? ` (${p.brand})` : ''}: $${parseFloat(p.price).toFixed(2)} — ${p.stock}`
  ).join('\n')

  return `Eres el asistente telefónico de "${biz.name}" (${biz.type || 'negocio'}).
Estás respondiendo una LLAMADA DE VOZ.

DATOS:
Horario: ${biz.hours || 'No especificado'}
Dirección: ${biz.address || 'No especificada'}
Métodos de pago: ${biz.payment_methods || ''}

PRODUCTOS (primeros 10):
${catalog || 'Sin productos cargados.'}

POLÍTICAS: ${policies?.bot_instructions || ''}

REGLAS ESTRICTAS PARA VOZ:
1. Respuestas MUY cortas (1-2 oraciones máximo).
2. Sin markdown, sin asteriscos, sin emojis, sin listas.
3. Habla natural, como si fuera una conversación real.
4. Si no sabes algo, di: "Permíteme verificar eso."
5. Si quieren comprar: pide nombre y dirección.`
}

// Webhook de eventos de llamadas (opcional)
function handleRetellCallEvent(req, res) {
  const { event, call } = req.body
  console.log(`📞 [Retell] Evento: ${event} — ${call?.call_id}`)
  if (event === 'call_ended') {
    console.log(`📞 [Retell] Llamada terminada: duración ${call?.call_duration}s`)
  }
  res.json({ ok: true })
}

module.exports = { handleRetellLLM, handleRetellCallEvent }

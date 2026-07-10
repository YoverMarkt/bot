const { Telegraf, Markup } = require('telegraf')
const db = require('./db')

// Cache en memoria — se restaura desde BD si el servidor reinicia
const sessions = new Map() // chatId → businessSlug

// Restaurar sesión desde el historial de conversaciones
async function restoreSession(chatId) {
  const from = `tg_${chatId}`
  try {
    const { createClient } = require('@supabase/supabase-js')
    require('dotenv').config({ path: require('path').join(__dirname, '.env') })
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY)
    const { data } = await sb
      .from('conversation_history')
      .select('business_id')
      .eq('contact_phone', from)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (data?.business_id) {
      const biz = await db.getBusinessById(data.business_id)
      if (biz?.active && biz?.slug) {
        sessions.set(chatId, biz.slug)
        return biz.slug
      }
    }
  } catch(_) {}
  return null
}

async function showBusinessList(ctx) {
  const businesses = await db.getAllBusinesses()
  const active = businesses.filter(b => b.active)
  if (!active.length) return ctx.reply('No hay negocios activos disponibles.')

  const buttons = active.map(b =>
    [Markup.button.callback(`🏪 ${b.name}`, `select_${b.slug}`)]
  )
  return ctx.reply(
    '👋 *BotPanel — Modo pruebas*\n\nElige un negocio para chatear:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  )
}

let handleFnRef = null
let botInstance  = null

async function setupTelegram(app, handleFn) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || token.length < 10) {
    console.log('ℹ️  Telegram: configura TELEGRAM_BOT_TOKEN en .env para activarlo')
    return null
  }

  handleFnRef = handleFn
  const bot = new Telegraf(token)
  botInstance = bot

  // Manejador global de errores de Telegraf — evita que un error tumbe el server
  bot.catch((err, ctx) => {
    console.error(`❌ [Telegram] error en ${ctx?.updateType}:`, err.description || err.message)
  })

  // /start — mostrar negocios con botones
  bot.start(async ctx => {
    const slug = ctx.startPayload
    if (slug) {
      const biz = await db.getBusinessBySlug(slug)
      if (biz?.active) {
        sessions.set(ctx.chat.id, slug)
        return ctx.reply(`✅ Conectado a *${biz.name}*\n\nEscríbeme lo que necesitas.`, { parse_mode: 'Markdown' })
      }
    }
    showBusinessList(ctx)
  })

  // Botón de selección de negocio
  bot.action(/^select_(.+)$/, async ctx => {
    const slug = ctx.match[1]
    const biz = await db.getBusinessBySlug(slug)
    if (!biz?.active) return ctx.answerCbQuery('Negocio no disponible')
    sessions.set(ctx.chat.id, slug)
    await ctx.answerCbQuery()
    try {
      await ctx.editMessageText(
        `✅ Conectado a *${biz.name}*\n\nEscríbeme lo que necesitas.`,
        { parse_mode: 'Markdown' }
      )
    } catch(e) {
      // Ignora "message is not modified" (clic repetido en el mismo botón)
      if (!/not modified/.test(e.description || e.message || '')) throw e
    }
  })

  // /negocios — cambiar de negocio
  bot.command('negocios', ctx => showBusinessList(ctx))

  // /salir
  bot.command('salir', ctx => {
    sessions.delete(ctx.chat.id)
    ctx.reply('👋 Desconectado. Usa /negocios para elegir otro.')
  })

  // Mensajes de texto
  bot.on('text', async ctx => {
    const chatId = ctx.chat.id
    let slug = sessions.get(chatId)

    // Intentar restaurar sesión desde BD si no hay en memoria
    if (!slug) slug = await restoreSession(chatId)

    if (!slug) return showBusinessList(ctx)

    const from = `tg_${chatId}`
    await handleFnRef(from, ctx.message.text, null, { channel: 'telegram', ctx, slug })
  })

  // Notas de voz y audios → transcribir y procesar como texto
  const handleVoice = async ctx => {
    const chatId = ctx.chat.id
    let slug = sessions.get(chatId)
    if (!slug) slug = await restoreSession(chatId)
    if (!slug) return showBusinessList(ctx)

    const from = `tg_${chatId}`
    try {
      const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id
      if (!fileId) return
      const link = await ctx.telegram.getFileLink(fileId)
      const resp = await require('axios').get(link.href, { responseType: 'arraybuffer', timeout: 20000 })
      const buffer = Buffer.from(resp.data)
      const text = await require('./bot').transcribeAudio(buffer, 'voz.ogg')
      if (!text) return ctx.reply('No pude entender el audio 🙏 ¿Puedes escribirlo o enviarlo de nuevo?')
      console.log(`🎙️  [TG] audio de ${from} transcrito: "${text}"`)
      await handleFnRef(from, text, null, { channel: 'telegram', ctx, slug })
    } catch(e) {
      console.error('❌ TG audio:', e.message)
      ctx.reply('Tuve un problema procesando tu audio 🙏 ¿Puedes escribirlo?')
    }
  }
  bot.on('voice', handleVoice)
  bot.on('audio', handleVoice)

  // Fotos → identificar el producto con visión y responder
  bot.on('photo', async ctx => {
    const chatId = ctx.chat.id
    let slug = sessions.get(chatId) || await restoreSession(chatId)
    if (!slug) return showBusinessList(ctx)
    const from = `tg_${chatId}`
    try {
      const photos = ctx.message.photo
      const fileId = photos[photos.length - 1].file_id // la de mayor resolución
      const link = await ctx.telegram.getFileLink(fileId)
      const resp = await require('axios').get(link.href, { responseType: 'arraybuffer', timeout: 20000 })
      await require('./bot').handleImage(from, Buffer.from(resp.data), 'image/jpeg', null, { channel: 'telegram', ctx, slug })
    } catch(e) {
      console.error('❌ TG imagen:', e.message)
      ctx.reply('No pude procesar la imagen 🙏 ¿Puedes decirme el nombre del producto?')
    }
  })

  const baseUrl = process.env.BASE_URL
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/webhook/telegram`
    await bot.telegram.setWebhook(webhookUrl)
    app.use(bot.webhookCallback('/webhook/telegram'))
    console.log(`🤖 Telegram webhook activo: ${webhookUrl}`)
  } else {
    bot.launch()
    console.log('🤖 Telegram bot activo (polling — modo local)')
    process.once('SIGINT',  () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
  }

  return bot
}

const getBotInstance = () => botInstance
module.exports = { setupTelegram, getBotInstance }

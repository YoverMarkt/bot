const { Telegraf } = require('telegraf')
const db = require('./db')

const sessions = new Map() // chatId → businessSlug

async function registerCommands(bot) {
  bot.start(async ctx => {
    const slug = ctx.startPayload
    if (slug) {
      const biz = await db.getBusinessBySlug(slug)
      if (biz && biz.active) {
        sessions.set(ctx.chat.id, slug)
        return ctx.reply(`✅ Conectado a *${biz.name}*\n\nYa puedes escribirle al bot de este negocio.`, { parse_mode: 'Markdown' })
      }
      return ctx.reply('❌ Negocio no encontrado o inactivo.')
    }
    const list = (await db.getAllBusinesses())
      .filter(b => b.active)
      .map(b => `/start ${b.slug}  →  ${b.name}`)
      .join('\n')
    ctx.reply(`👋 *BotPanel – Modo pruebas*\n\nElige un negocio:\n\n${list}`, { parse_mode: 'Markdown' })
  })

  bot.command('negocios', async ctx => {
    const businesses = await db.getAllBusinesses()
    const list = businesses.filter(b => b.active).map(b => `• *${b.name}* — /start ${b.slug}`).join('\n')
    ctx.reply(list ? `Negocios disponibles:\n\n${list}` : 'No hay negocios activos.', { parse_mode: 'Markdown' })
  })

  bot.command('salir', ctx => {
    sessions.delete(ctx.chat.id)
    ctx.reply('👋 Desconectado. Usa /start para elegir otro negocio.')
  })

  bot.on('text', async ctx => {
    const chatId = ctx.chat.id
    const slug = sessions.get(chatId)
    if (!slug) return ctx.reply('Primero elige un negocio. Escribe /start para ver la lista.')
    const from = `tg_${chatId}`
    await handleFnRef(from, ctx.message.text, null, { channel: 'telegram', ctx, slug })
  })

  bot.on('photo', ctx => ctx.reply('Por ahora solo proceso texto. Escríbeme tu consulta 😊'))
}

let handleFnRef = null

async function setupTelegram(app, handleFn) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || token.length < 10) {
    console.log('ℹ️  Telegram: configura TELEGRAM_BOT_TOKEN en .env para activarlo')
    return null
  }

  handleFnRef = handleFn
  const bot = new Telegraf(token)
  await registerCommands(bot)

  const baseUrl = process.env.BASE_URL

  if (baseUrl) {
    // Producción: webhook mode
    const webhookUrl = `${baseUrl}/webhook/telegram`
    await bot.telegram.setWebhook(webhookUrl)
    app.use(bot.webhookCallback('/webhook/telegram'))
    console.log(`🤖 Telegram webhook activo: ${webhookUrl}`)
  } else {
    // Desarrollo: long polling
    bot.launch()
    console.log('🤖 Telegram bot activo (polling — modo local)')
    process.once('SIGINT',  () => bot.stop('SIGINT'))
    process.once('SIGTERM', () => bot.stop('SIGTERM'))
  }

  return bot
}

module.exports = { setupTelegram }

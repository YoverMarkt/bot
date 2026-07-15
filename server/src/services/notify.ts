export type BusinessRecord = Record<string, unknown>

interface TelegramBot {
  telegram: {
    sendMessage(chatId: string, message: string): Promise<unknown>
  }
}

export interface ContactNotifierDependencies {
  getTelegramBot(): TelegramBot | null | undefined
  sendWhatsAppMessage(business: BusinessRecord, phone: string, message: string): Promise<unknown>
}

export function createContactNotifier(dependencies: ContactNotifierDependencies) {
  return async function sendToContact(
    business: BusinessRecord,
    phone: string,
    message: string,
  ): Promise<void> {
    if (phone.startsWith('tg_')) {
      const chatId = phone.replace('tg_', '')
      const telegramBot = dependencies.getTelegramBot()
      if (!telegramBot) throw new Error('El canal de Telegram no está conectado')
      await telegramBot.telegram.sendMessage(chatId, message)
      return
    }

    await dependencies.sendWhatsAppMessage(business, phone, message)
  }
}

// Las cargas siguen siendo diferidas para evitar ciclos durante el arranque del bot.
export const sendToContact = createContactNotifier({
  getTelegramBot() {
    return require('../integrations/telegram').getBotInstance() as TelegramBot | null | undefined
  },
  async sendWhatsAppMessage(business, phone, message) {
    const bot = require('./bot-entry') as {
      sendWhatsAppMessage(
        currentBusiness: BusinessRecord,
        currentPhone: string,
        currentMessage: string,
      ): Promise<unknown>
    }
    await bot.sendWhatsAppMessage(business, phone, message)
  },
})

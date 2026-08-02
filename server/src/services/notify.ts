// Un solo `BusinessRecord` en todo el proyecto: el de `db/types`, con las
// columnas reales. Aquí era `Record<string, unknown>` y por eso quien recibía
// un negocio podía leer cualquier campo inventado sin que nadie se quejara.
export type { BusinessRecord } from '../db/types'
import type { BusinessRecord } from '../db/types'

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
    interface ModuloBot {
      sendWhatsAppMessage(
        currentBusiness: BusinessRecord,
        currentPhone: string,
        currentMessage: string,
      ): Promise<unknown>
    }
    const bot: ModuloBot = require('./bot-entry') as typeof import('./bot-entry')
    await bot.sendWhatsAppMessage(business, phone, message)
  },
})

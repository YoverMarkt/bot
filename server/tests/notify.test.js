import { describe, expect, it, vi } from 'vitest'
import notify from '../dist/services/notify.js'

const BUSINESS = { id: 'business-1', name: 'Demo' }

function setup({ telegramBot = null } = {}) {
  const getTelegramBot = vi.fn(() => telegramBot)
  const sendWhatsAppMessage = vi.fn().mockResolvedValue(undefined)
  const sendToContact = notify.createContactNotifier({ getTelegramBot, sendWhatsAppMessage })
  return { getTelegramBot, sendWhatsAppMessage, sendToContact }
}

describe('notificaciones al contacto', () => {
  it('envía contactos tg_ mediante Telegram y limpia el prefijo', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const telegramBot = { telegram: { sendMessage } }
    const context = setup({ telegramBot })

    await context.sendToContact(BUSINESS, 'tg_123456', 'Reserva confirmada')

    expect(context.getTelegramBot).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith('123456', 'Reserva confirmada')
    expect(context.sendWhatsAppMessage).not.toHaveBeenCalled()
  })

  it('reporta que Telegram no está conectado sin cambiar silenciosamente de canal', async () => {
    const context = setup()

    await expect(
      context.sendToContact(BUSINESS, 'tg_123456', 'Hola'),
    ).rejects.toThrow('Telegram no está conectado')

    expect(context.getTelegramBot).toHaveBeenCalledOnce()
    expect(context.sendWhatsAppMessage).not.toHaveBeenCalled()
  })

  it('envía el resto de contactos mediante el flujo actual de WhatsApp', async () => {
    const context = setup()

    await context.sendToContact(BUSINESS, '+593999000001', 'Pedido listo')

    expect(context.sendWhatsAppMessage).toHaveBeenCalledWith(
      BUSINESS,
      '+593999000001',
      'Pedido listo',
    )
    expect(context.getTelegramBot).not.toHaveBeenCalled()
  })

  it('propaga el error del canal para que la ruta aplique su manejo actual', async () => {
    const expected = new Error('canal no disponible')
    const context = setup()
    context.sendWhatsAppMessage.mockRejectedValue(expected)

    await expect(
      context.sendToContact(BUSINESS, '+593999000001', 'Hola'),
    ).rejects.toBe(expected)
  })
})

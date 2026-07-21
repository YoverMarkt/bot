import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const menu = require('../dist/services/bot-menu')

describe('menú guiado de bienvenida', () => {
  it('detecta saludos y pedidos de menú sin contenido útil para la IA', () => {
    const saludos = [
      'Hola', 'hola!!', 'Holaaa 👋', 'Buenas tardes 😊', 'buenos días',
      'hola buenas', 'menú', 'Menú principal', 'opciones', 'info', 'qué tal', '👋',
    ]
    for (const text of saludos) {
      expect(menu.wantsWelcomeMenu(text), text).toBe(true)
    }
  })

  it('deja pasar al flujo normal cualquier mensaje con contenido', () => {
    const mensajes = [
      'Quiero 2 pizzas hawaianas', 'hola, quiero una pizza', '¿tienen pizza familiar?',
      'precio del perfume árabe', 'la quiero', 'si por favor',
      'Necesito ayuda con mi pedido', '   ',
    ]
    for (const text of mensajes) {
      expect(menu.wantsWelcomeMenu(text), text).toBe(false)
    }
  })

  it('arma las opciones desde las capacidades reales del negocio, nunca inventadas', () => {
    const pizzeria = menu.buildWelcomeMenu({ name: 'Pizzería Don Luigi', takes_orders: true }, 12)
    expect(pizzeria.text).toContain('Pizzería Don Luigi')
    expect(pizzeria.options).toEqual([
      '🛒 Hacer un pedido', '📋 Ver productos y precios', '💬 Otra consulta',
    ])

    const hostal = menu.buildWelcomeMenu({ name: 'Hostal Vista Andina', lodging_enabled: true }, 0)
    expect(hostal.options).toEqual(['🛏️ Cotizar hospedaje', '💬 Otra consulta'])

    const barberia = menu.buildWelcomeMenu({ name: 'Barbería', takes_bookings: true }, 3)
    expect(barberia.options).toEqual([
      '📅 Agendar una cita', '📋 Ver productos y precios', '💬 Otra consulta',
    ])

    // Modo informativo sin catálogo: siempre queda la conversación libre
    expect(menu.buildWelcomeMenu({}, 0).options).toEqual(['💬 Otra consulta'])
  })

  it('guarda en el historial el menú con sus opciones para el siguiente turno de la IA', () => {
    const welcome = menu.buildWelcomeMenu({ name: 'Demo', takes_orders: true }, 1)
    const saved = menu.menuAsHistory(welcome)
    expect(saved).toContain(welcome.text)
    expect(saved).toContain('• 🛒 Hacer un pedido')
  })
})

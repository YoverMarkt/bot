import { describe, expect, it } from 'vitest'
import { cuantoFalta } from '../src/lib/bloqueo'

// ═══════════════════════════════════════════════════════════════════════════
// EL PLAZO DE UN BLOQUEO TEMPORAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace del 2026-08-29: estando bloqueado en un local, el dueño abrió un enlace
// viejo, recorrió la carta entera y creó un pedido que nadie podía pagar. La
// mini app no miraba el bloqueo en ningún sitio.
//
// Ahora hay pantalla, y lo único con reglas de esa pantalla es esto: cuánto
// falta. El resto es maquetación.

const AHORA = new Date('2026-08-29T06:00:00Z').getTime()
const dentroDe = (minutos: number) =>
  new Date(AHORA + minutos * 60000).toISOString()

describe('cuánto falta para poder pedir', () => {
  it('un bloqueo PERMANENTE no promete nada', () => {
    // El del dueño no caduca. Prometer una hora que no se cumple es peor que
    // no decir hora — es cómo nació el fallo del número del 2026-08-23.
    expect(cuantoFalta(null, AHORA)).toBeNull()
  })

  it('dice los minutos que quedan', () => {
    expect(cuantoFalta(dentroDe(30), AHORA)).toBe('faltan 30 minutos')
    expect(cuantoFalta(dentroDe(12), AHORA)).toBe('faltan 12 minutos')
  })

  it('el singular está bien escrito', () => {
    expect(cuantoFalta(dentroDe(1), AHORA)).toBe('falta 1 minuto')
  })

  it('redondea HACIA ARRIBA, para no mandar a nadie antes de tiempo', () => {
    // Quedan 20 segundos. «faltan 0 minutos» invita a intentarlo ya, y la
    // persona se encuentra la misma pantalla otra vez.
    const veinteSegundos = new Date(AHORA + 20000).toISOString()
    expect(cuantoFalta(veinteSegundos, AHORA)).toBe('falta 1 minuto')
  })

  it('pasa a horas cuando el bloqueo es largo, sin redondear a ciegas', () => {
    // El dueño puede poner hasta 7 días (`block_minutes`).
    expect(cuantoFalta(dentroDe(60), AHORA)).toBe('falta 1 hora')
    expect(cuantoFalta(dentroDe(120), AHORA)).toBe('faltan 2 horas')

    // ⚠️ 3 h 20 min NO se dice «3 horas» ni «4 horas»: lo primero manda a la
    // persona 20 minutos antes de tiempo, lo segundo la hace esperar 40 de
    // más y puede que no vuelva. Con las dos unidades no hay que elegir cuál
    // de los dos errores cometer.
    expect(cuantoFalta(dentroDe(200), AHORA)).toBe('faltan 3 h 20 min')
    expect(cuantoFalta(dentroDe(61), AHORA)).toBe('faltan 1 h 1 min')
  })

  it('cumplido el plazo devuelve null: es la señal de «ya puedes entrar»', () => {
    // No es un caso de borde: ese nulo es lo que hace aparecer el botón de
    // volver a entrar. Sin él habría que cerrar la app y abrirla de nuevo
    // para saber si el castigo terminó.
    expect(cuantoFalta(dentroDe(-1), AHORA)).toBeNull()
    expect(cuantoFalta(new Date(AHORA).toISOString(), AHORA)).toBeNull()
  })

  it('una fecha con basura no rompe la pantalla', () => {
    expect(cuantoFalta('mañana', AHORA)).toBeNull()
    expect(cuantoFalta('', AHORA)).toBeNull()
  })
})

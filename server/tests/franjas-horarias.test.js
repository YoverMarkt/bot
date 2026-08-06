import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scheduleSlots, isValidSlot } = require('../dist/services/schedule')

// ═══════════════════════════════════════════════════════════════════════════
// LAS HORAS A LAS QUE SE PUEDE PROGRAMAR UN PEDIDO
// ═══════════════════════════════════════════════════════════════════════════
//
// «Quiero mi almuerzo a la 1». Hasta ahora la tienda solo aceptaba pedidos
// inmediatos, así que fuera de horario no se podía pedir nada — y ese es justo
// el momento en que alguien decide qué va a comer.
//
// Ofrecer una hora a la que el local está cerrado es peor que no ofrecer nada:
// el cliente programa, espera, y su comida no llega. Por eso todo se calcula
// contra el horario REAL y en hora de Ecuador, no la del teléfono.

/** Un lunes a las 10:00 de Ecuador (UTC-5). */
const LUNES_10 = new Date('2026-08-10T15:00:00Z')

/** Horario de lunes a viernes, de 09:00 a 18:00. */
const LABORAL = [1, 2, 3, 4, 5].map(day => ({
  day_of_week: day, open_time: '09:00', close_time: '18:00', is_active: true,
}))

const horaEcuador = (iso) => new Date(iso).toLocaleTimeString('es-EC', {
  timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false,
})

const diaEcuador = (iso) => new Date(iso).toLocaleDateString('en-CA', {
  timeZone: 'America/Guayaquil',
})

describe('franjas para programar', () => {
  it('sin horario configurado no se ofrece nada', () => {
    // Mejor no ofrecer programar que ofrecer las 24 horas de un local que
    // abre seis.
    expect(scheduleSlots([], {}, LUNES_10)).toEqual([])
    expect(scheduleSlots(null, {}, LUNES_10)).toEqual([])
  })

  it('un horario sin días activos tampoco', () => {
    const apagado = LABORAL.map(day => ({ ...day, is_active: false }))
    expect(scheduleSlots(apagado, {}, LUNES_10)).toEqual([])
  })

  it('todas las franjas caen dentro del horario del negocio', () => {
    for (const franja of scheduleSlots(LABORAL, {}, LUNES_10)) {
      const hora = horaEcuador(franja)
      expect(hora >= '09:00', `${hora} es antes de abrir`).toBe(true)
      // La hora de cierre EXACTA no vale: a las 18:00 el local ya cerró.
      expect(hora < '18:00', `${hora} es a la hora de cierre o después`).toBe(true)
    }
  })

  it('no ofrece nada antes del tiempo de preparación', () => {
    // A las 10:00 con 30 minutos de preparación, la primera es a las 10:30.
    const [primera] = scheduleSlots(LABORAL, { preparationMinutes: 30 }, LUNES_10)
    expect(horaEcuador(primera)).toBe('10:30')
  })

  it('una preparación larga empuja la primera franja', () => {
    // Programar para dentro de cinco minutos una pizza que tarda dos horas es
    // prometer lo imposible.
    const [primera] = scheduleSlots(LABORAL, { preparationMinutes: 120 }, LUNES_10)
    expect(horaEcuador(primera)).toBe('12:00')
  })

  it('salta los días en los que el negocio no abre', () => {
    const soloLunes = [{
      day_of_week: 1, open_time: '09:00', close_time: '18:00', is_active: true,
    }]
    // Con 7 días desde un lunes solo cabe UN lunes; con 8, dos.
    const unaSemana = new Set(scheduleSlots(soloLunes, { daysAhead: 7 }, LUNES_10).map(diaEcuador))
    expect(unaSemana.size).toBe(1)
    const ocho = new Set(scheduleSlots(soloLunes, { daysAhead: 8, limit: 200 }, LUNES_10).map(diaEcuador))
    expect(ocho.size).toBe(2)
  })

  it('fuera de horario ofrece el día siguiente, no horas de hoy', () => {
    // Las 22:00 de un lunes: el local cerró a las 18:00.
    const lunesNoche = new Date('2026-08-11T03:00:00Z')
    const [primera] = scheduleSlots(LABORAL, {}, lunesNoche)
    expect(horaEcuador(primera)).toBe('09:00')
    expect(diaEcuador(primera)).not.toBe(diaEcuador(lunesNoche.toISOString()))
  })

  it('las horas salen en punto, no a las 13:07', () => {
    const raro = new Date('2026-08-10T15:07:00Z')  // 10:07 en Ecuador
    for (const franja of scheduleSlots(LABORAL, { stepMinutes: 30 }, raro)) {
      expect(['00', '30']).toContain(horaEcuador(franja).slice(3))
    }
  })

  it('nunca devuelve una lista infinita', () => {
    expect(scheduleSlots(LABORAL, { daysAhead: 14, limit: 10 }, LUNES_10)).toHaveLength(10)
  })
})

describe('validar la hora que manda el cliente', () => {
  // La lista de franjas es una comodidad para elegir. Quien mande una hora a
  // mano no puede colarse: lo comprueba el servidor.
  const valida = (iso, opciones = {}) =>
    isValidSlot(LABORAL, new Date(iso), opciones, LUNES_10)

  it('acepta una hora dentro del horario y con margen suficiente', () => {
    expect(valida('2026-08-10T18:00:00Z')).toBe(true)  // 13:00 en Ecuador
  })

  it('rechaza una hora que ya pasó', () => {
    expect(valida('2026-08-10T13:00:00Z')).toBe(false)  // 08:00, antes de ahora
  })

  it('rechaza una hora sin tiempo para prepararlo', () => {
    // 10:05 con 30 minutos de preparación: no da tiempo.
    expect(valida('2026-08-10T15:05:00Z', { preparationMinutes: 30 })).toBe(false)
  })

  it('rechaza una hora con el local cerrado', () => {
    expect(valida('2026-08-11T04:00:00Z')).toBe(false)  // 23:00 del lunes
  })

  it('rechaza un día en el que no se abre', () => {
    // Domingo: no está en el horario laboral.
    expect(valida('2026-08-16T18:00:00Z')).toBe(false)
  })

  it('rechaza la hora de cierre exacta', () => {
    expect(valida('2026-08-10T23:00:00Z')).toBe(false)  // 18:00 clavadas
  })

  it('rechaza una fecha demasiado lejana', () => {
    expect(valida('2026-12-25T18:00:00Z', { daysAhead: 7 })).toBe(false)
  })

  it('rechaza una fecha inválida en vez de dejarla pasar', () => {
    expect(isValidSlot(LABORAL, new Date('no soy una fecha'), {}, LUNES_10)).toBe(false)
  })

  it('sin horario no se puede programar nada', () => {
    expect(isValidSlot([], new Date('2026-08-10T18:00:00Z'), {}, LUNES_10)).toBe(false)
  })

  // Entre que la app pinta la franja y el cliente confirma pasa tiempo:
  // rechazar por segundos sería absurdo.
  it('deja un minuto de margen para confirmar', () => {
    const justo = new Date(LUNES_10.getTime() + 30 * 60_000)
    expect(isValidSlot(LABORAL, justo, { preparationMinutes: 30 }, LUNES_10)).toBe(true)
  })

  it('lo que ofrece scheduleSlots lo acepta isValidSlot', () => {
    // Si no coincidieran, el cliente elegiría una franja de la lista y el
    // servidor la rechazaría al confirmar.
    for (const franja of scheduleSlots(LABORAL, { preparationMinutes: 45 }, LUNES_10)) {
      expect(
        isValidSlot(LABORAL, new Date(franja), { preparationMinutes: 45 }, LUNES_10),
        `la franja ofrecida ${franja} fue rechazada`,
      ).toBe(true)
    }
  })
})

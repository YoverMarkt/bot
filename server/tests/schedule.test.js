import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const scheduleService = require('../dist/services/schedule')

const monday = {
  day_of_week: 1,
  open_time: '09:00:00',
  close_time: '17:00:00',
  is_active: true,
}

describe('servicio de horarios del bot', () => {
  it('no marca fuera de horario cuando no existe configuración activa', () => {
    expect(scheduleService.isOutsideHours([], new Date('2026-07-13T15:00:00Z'))).toBe(false)
    expect(scheduleService.isOutsideHours([
      { ...monday, is_active: false },
    ], new Date('2026-07-13T15:00:00Z'))).toBe(false)
  })

  it('evalúa apertura, cierre y día cerrado en hora de Ecuador', () => {
    expect(scheduleService.isOutsideHours([monday], new Date('2026-07-13T13:59:00Z'))).toBe(true)
    expect(scheduleService.isOutsideHours([monday], new Date('2026-07-13T14:00:00Z'))).toBe(false)
    expect(scheduleService.isOutsideHours([monday], new Date('2026-07-13T21:59:00Z'))).toBe(false)
    expect(scheduleService.isOutsideHours([monday], new Date('2026-07-13T22:00:00Z'))).toBe(true)
    expect(scheduleService.isOutsideHours([monday], new Date('2026-07-14T15:00:00Z'))).toBe(true)
  })

  it('ordena el texto desde lunes y construye el mensaje con días cerrados', () => {
    const sunday = {
      day_of_week: 0,
      open_time: '10:00:00',
      close_time: '14:00:00',
      is_active: true,
    }

    expect(scheduleService.scheduleToText([sunday, monday])).toBe(
      'Lunes de 09:00 a 17:00, Domingo de 10:00 a 14:00',
    )
    const message = scheduleService.buildScheduleMessage({ id: 'business-a' }, [monday])
    expect(message).toContain('🕐 *Lunes:* 09:00 – 17:00')
    expect(message).toContain('🚫 *Martes:* cerrado')
    expect(message).toContain('fuera de nuestro horario de atención')
  })

  it('mantiene una implementación TypeScript única para horarios', () => {
    const service = fs.readFileSync(new URL('../src/services/schedule.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('export interface ScheduleRecord')
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./schedule')")
  })
})

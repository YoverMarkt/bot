import { describe, expect, it } from 'vitest'
import calendar from '../dist/lib/calendar.js'

describe('tipos de negocio con calendario', () => {
  it.each(['Barbería premium', 'CLÍNICA dental', 'Hotel y restaurante', 'Estudio de yoga'])(
    'reconoce %s',
    (businessType) => expect(calendar.businessNeedsCalendar(businessType)).toBe(true),
  )

  it.each([null, undefined, '', 'tienda de ropa', 'perfumería', 'ferretería'])(
    'rechaza un negocio sin citas: %s',
    (businessType) => expect(calendar.businessNeedsCalendar(businessType)).toBe(false),
  )
})

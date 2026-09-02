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

  it('devuelve el horario vigente para la portada de la tienda', () => {
    // Lunes 09:00–17:00. A media tarde de Ecuador se enseña ese tramo.
    expect(scheduleService.todaysHours([monday], new Date('2026-07-13T18:00:00Z')))
      .toEqual({ open: '09:00', close: '17:00' })
    // Martes: ese día no se abre y la portada calla en vez de inventar.
    expect(scheduleService.todaysHours([monday], new Date('2026-07-14T18:00:00Z'))).toBe(null)
    expect(scheduleService.todaysHours([], new Date('2026-07-13T18:00:00Z'))).toBe(null)
  })

  it('en la madrugada enseña el turno de la VÍSPERA, no el del día nuevo', () => {
    // El caso que motivó la función: un negocio de 09:00 a 01:00 que a las
    // 00:30 sigue abierto. Enseñar el tramo del día nuevo diría «abre a las
    // 09:00» junto a una píldora verde de «Abierto»: no pueden ser ciertas las
    // dos cosas a la vez.
    const cruzaMedianoche = {
      day_of_week: 1, open_time: '09:00:00', close_time: '01:00:00', is_active: true,
    }
    // Martes 00:30 en Ecuador = martes 05:30 UTC. Manda el turno del lunes.
    expect(scheduleService.todaysHours([cruzaMedianoche], new Date('2026-07-14T05:30:00Z')))
      .toEqual({ open: '09:00', close: '01:00' })
    // Y una vez pasado el cierre real, ese martes ya no abre.
    expect(scheduleService.todaysHours([cruzaMedianoche], new Date('2026-07-14T06:30:00Z')))
      .toBe(null)
    // El negocio sigue marcado como abierto a las 00:30: las dos funciones
    // tienen que contar la misma historia o la portada se contradice sola.
    expect(scheduleService.isOutsideHours([cruzaMedianoche], new Date('2026-07-14T05:30:00Z')))
      .toBe(false)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CUANDO HOY Y AYER ESTÁN VIVOS A LA VEZ, MANDA HOY
  //
  // Lo reportó el dueño el 2026-09-02 con el horario REAL de Monster Pizza:
  // martes 09:00–01:00 y miércoles 00:00–03:00. A las 00:08 de un miércoles la
  // portada decía «Abierto» con el horario «09:00 – 01:00» al lado — el del
  // martes, que seguía vivo hasta la una.
  //
  // No era cosmético: el cliente leía que cerraba a la 01:00 cuando quedaban
  // dos horas de servicio. Quien entrara a las 00:50 se iba creyendo que le
  // quedaban diez minutos.
  // ═══════════════════════════════════════════════════════════════════════
  describe('dos turnos vivos a la vez', () => {
    // El horario real, tal cual estaba en producción.
    const monsterPizza = [
      { day_of_week: 2, open_time: '09:00:00', close_time: '01:00:00', is_active: true },
      { day_of_week: 3, open_time: '00:00:00', close_time: '03:00:00', is_active: true },
    ]
    // Miércoles 2026-09-02 en Ecuador (UTC−5).
    const miercoles = hora => new Date(`2026-09-02T${hora}:00Z`)

    it('a las 00:08 enseña el turno de HOY, no la cola del de ayer', () => {
      expect(scheduleService.todaysHours(monsterPizza, miercoles('05:08')))
        .toEqual({ open: '00:00', close: '03:00' })
    })

    it('y lo sigue enseñando después de que el de ayer muere', () => {
      // 01:30: el martes ya cerró; el miércoles sigue hasta las 03:00.
      expect(scheduleService.todaysHours(monsterPizza, miercoles('06:30')))
        .toEqual({ open: '00:00', close: '03:00' })
    })

    it('el estado y el horario cuentan la MISMA historia a cada hora', () => {
      // ⚠️ Es la raíz del fallo: `isOutsideHours` miraba hoy primero y
      // `todaysHours` miraba la víspera primero, así que respondían sobre
      // turnos distintos. Ahora las dos salen de `turnoVigente`.
      for (const [hora, abierto] of [
        ['05:08', true], ['06:30', true], ['07:59', true], ['08:05', false],
      ]) {
        const cuando = miercoles(hora)
        expect(scheduleService.isOutsideHours(monsterPizza, cuando), hora).toBe(!abierto)
        // Mientras esté abierto, el horario mostrado tiene que ser el que está
        // corriendo de verdad.
        if (abierto) {
          expect(scheduleService.todaysHours(monsterPizza, cuando), hora)
            .toEqual({ open: '00:00', close: '03:00' })
        }
      }
    })
  })

  // ⚠️ El otro lado de la misma moneda, y por eso no basta con invertir el
  // orden de comprobación: aquí la cola SÍ es de ayer.
  describe('la cola de un cruce pertenece al día anterior', () => {
    it('un negocio que abre a las 09:00 NO está abierto a las 00:30', () => {
      // Jueves 09:00–01:00 y el miércoles CERRADO. A las 00:30 del jueves no
      // hay nadie abierto: el turno del jueves no empieza hasta las 09:00.
      // Antes decía «abierto» y aceptaba pedidos nueve horas antes de abrir,
      // porque la comprobación solo miraba minutos y no días.
      const soloJueves = [
        { day_of_week: 4, open_time: '09:00:00', close_time: '01:00:00', is_active: true },
      ]
      expect(scheduleService.isOutsideHours(soloJueves, new Date('2026-09-03T05:30:00Z')))
        .toBe(true)
      // Pero a su hora sí abre, y su cola llega al viernes de madrugada.
      expect(scheduleService.isOutsideHours(soloJueves, new Date('2026-09-03T14:30:00Z')))
        .toBe(false)
      expect(scheduleService.isOutsideHours(soloJueves, new Date('2026-09-04T05:30:00Z')))
        .toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CON DOS TURNOS VIVOS MANDA EL QUE CIERRA MÁS TARDE
  // ═══════════════════════════════════════════════════════════════════════
  describe('turnos que se solapan', () => {
    // El dueño PUEDE solapar turnos, y es su decisión: «el lunes de 9 de la
    // mañana a 2 de la madrugada» y «el miércoles de 00:00 a 5». El horario es
    // suyo; aquí solo se respeta.
    const lunesLargo = [
      { day_of_week: 1, open_time: '09:00:00', close_time: '06:00:00', is_active: true },
      { day_of_week: 2, open_time: '00:00:00', close_time: '02:00:00', is_active: true },
    ]

    it('enseña el turno que de verdad decide hasta cuándo se puede pedir', () => {
      // Martes 00:30: viven el lunes (hasta las 06:00) y el martes (hasta las
      // 02:00). Antes se enseñaba el más corto y el cliente creía que le
      // quedaba media hora teniendo cuatro y media.
      expect(scheduleService.todaysHours(lunesLargo, new Date('2026-09-01T05:30:00Z')))
        .toEqual({ open: '09:00', close: '06:00' })
    })

    it('y sigue siendo el mismo cuando el corto ya cerró', () => {
      // 02:30: el martes cerró a las 02:00, el lunes sigue.
      expect(scheduleService.todaysHours(lunesLargo, new Date('2026-09-01T07:30:00Z')))
        .toEqual({ open: '09:00', close: '06:00' })
      expect(scheduleService.isOutsideHours(lunesLargo, new Date('2026-09-01T07:30:00Z')))
        .toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // LA INVARIANTE: EL CIERRE QUE SE ENSEÑA ES EL CIERRE DE VERDAD
  //
  // ⚠️ Esta prueba no comprueba un caso: recorre la SEMANA ENTERA minuto a
  // minuto sobre varias configuraciones y exige dos cosas en todas ellas.
  // Existe porque esta familia de fallos ya se ha manifestado por dos lados
  // distintos —enseñar el turno de ayer teniendo el de hoy vivo, y enseñar el
  // más corto de dos solapados— y ninguno lo cazó una prueba de caso.
  // ═══════════════════════════════════════════════════════════════════════
  describe('estado y horario nunca se contradicen', () => {
    const escenarios = {
      'el del dueño (lunes 9–2, miércoles 0–5)': [
        { day_of_week: 1, open_time: '09:00:00', close_time: '02:00:00', is_active: true },
        { day_of_week: 3, open_time: '00:00:00', close_time: '05:00:00', is_active: true },
      ],
      'Monster Pizza': [
        { day_of_week: 0, open_time: '09:00:00', close_time: '05:00:00', is_active: true },
        { day_of_week: 1, open_time: '08:00:00', close_time: '05:00:00', is_active: true },
        { day_of_week: 2, open_time: '09:00:00', close_time: '01:00:00', is_active: true },
        { day_of_week: 3, open_time: '00:00:00', close_time: '03:00:00', is_active: true },
        { day_of_week: 4, open_time: '09:00:00', close_time: '01:00:00', is_active: true },
        { day_of_week: 5, open_time: '08:00:00', close_time: '01:00:00', is_active: true },
        { day_of_week: 6, open_time: '08:00:00', close_time: '05:00:00', is_active: true },
      ],
      'turnos solapados (lunes 9–6, martes 0–2)': [
        { day_of_week: 1, open_time: '09:00:00', close_time: '06:00:00', is_active: true },
        { day_of_week: 2, open_time: '00:00:00', close_time: '02:00:00', is_active: true },
      ],
      'un solo día, sin vecinos': [
        { day_of_week: 4, open_time: '09:00:00', close_time: '01:00:00', is_active: true },
      ],
    }
    // Domingo 2026-08-30, 00:00 en Ecuador (UTC−5).
    const DOMINGO = Date.UTC(2026, 7, 30, 5)
    const minutosDe = hhmm => {
      const [h, m] = hhmm.split(':').map(Number)
      return h * 60 + (m || 0)
    }
    const horaLocal = (t) => {
      const l = new Date(t.toLocaleString('en-US', { timeZone: 'America/Guayaquil' }))
      return l.getHours() * 60 + l.getMinutes()
    }

    for (const [nombre, horario] of Object.entries(escenarios)) {
      it(`${nombre}: mientras diga abierto, el horario contiene la hora`, () => {
        for (let m = 0; m < 7 * 24 * 60; m += 5) {
          const t = new Date(DOMINGO + m * 60e3)
          if (scheduleService.isOutsideHours(horario, t)) continue
          const v = scheduleService.todaysHours(horario, t)
          expect(v, `${nombre} @ minuto ${m}`).not.toBe(null)
          const ahora = horaLocal(t)
          const abre = minutosDe(v.open)
          const cierra = minutosDe(v.close)
          const dentro = cierra < abre
            ? (ahora >= abre || ahora < cierra)
            : (ahora >= abre && ahora < cierra)
          expect(dentro, `${nombre} @ minuto ${m}: abierto pero enseña ${v.open}–${v.close}`)
            .toBe(true)
        }
      })

      it(`${nombre}: el cierre que enseña es el minuto en que cierra`, () => {
        // ⚠️ Esto es lo que cazaba el fallo de los turnos solapados: enseñar un
        // cierre ANTES del real deja al cliente creyendo que no le da tiempo.
        for (let m = 5; m < 7 * 24 * 60; m += 5) {
          const antes = new Date(DOMINGO + (m - 5) * 60e3)
          const ahora = new Date(DOMINGO + m * 60e3)
          const cerrabaAntes = scheduleService.isOutsideHours(horario, antes)
          const cierraAhora = scheduleService.isOutsideHours(horario, ahora)
          if (cerrabaAntes || !cierraAhora) continue
          // Justo cerró: lo que se enseñaba un momento antes tiene que ser el
          // turno que acaba de terminar.
          const v = scheduleService.todaysHours(horario, antes)
          expect(minutosDe(v.close), `${nombre}: cerró en el minuto ${horaLocal(ahora)} enseñando ${v.open}–${v.close}`)
            .toBe(horaLocal(ahora))
        }
      })
    }
  })

  it('mantiene una implementación TypeScript única para horarios', () => {
    const service = fs.readFileSync(new URL('../src/services/schedule.ts', import.meta.url), 'utf8')
    const entry = fs.readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(service).toContain('export interface ScheduleRecord')
    expect(service).not.toContain('@ts-nocheck')
    expect(entry).toContain("require('./schedule')")
  })
})

import { describe, expect, it } from 'vitest'
import { redactarParte, semaforo } from '../../.github/scripts/parte-diario.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// EL PARTE DIARIO
// ═══════════════════════════════════════════════════════════════════════════
//
// Existe por una frase del dueño: «me llegan muchas notificaciones, pero todas
// de errores y ninguna de OK». Los vigías avisan fallando, así que con todo en
// orden no llega nada — y «nada» no se distingue de «el workflow murió».
//
// Lo que se prueba aquí es lo único que puede salir mal en un parte: que diga
// que todo va bien cuando no va bien.

const SANA = {
  ok: true,
  version: 'b92ca7a',
  canario: { at: '2026-09-19T12:06:31.508Z', revisados: 2, locales: 2, cerrados: 0, fallos: 0 },
  webhook_inbox: { running: true, ready: true, in_flight: 0 },
  inbound_channel: { last_inbound_at: '2026-09-19T22:12:15Z', hours_since_last_inbound: 1.7, recent_failures: 0, last_failure: null },
}

const EL_DIA = new Date('2026-09-20T12:30:00Z')

const parte = (extra = {}) => redactarParte({
  salud: SANA,
  detalle: { ok: true, problemas: [] },
  sano: true,
  caida: false,
  motivos: [],
  fecha: EL_DIA,
  ...extra,
})

describe('el semáforo', () => {
  it('en verde cuando no hay nada que decir', () => {
    expect(semaforo({ sano: true, caida: false }).emoji).toBe('🟢')
  })

  it('distingue «hay que atender» de «está caída»', () => {
    // Un saldo bajo y un bot muerto no son la misma noticia, y el parte se lee
    // de un vistazo por el emoji.
    expect(semaforo({ sano: false, caida: false }).emoji).toBe('🟠')
    expect(semaforo({ sano: false, caida: true }).emoji).toBe('🔴')
  })
})

describe('el parte que se publica', () => {
  it('un día bueno dice que todo está en orden', () => {
    const texto = parte()
    expect(texto).toContain('🟢 Todo en orden')
    expect(texto).toContain('b92ca7a')
    expect(texto).toContain('✅ respondiendo')
    expect(texto).not.toContain('Qué hay que mirar')
  })

  it('va fechado en hora de Ecuador, que es donde se lee', () => {
    // 12:30 UTC son las 7:30 a.m. en Guayaquil. Un parte con la hora de
    // Londres se lee como si fuera del día siguiente.
    const texto = parte()
    expect(texto).toContain('2026')
    expect(texto).toMatch(/07:30|7:30/)
  })

  it('con problemas los lista y NO dice que todo va bien', () => {
    const texto = parte({
      sano: false,
      motivos: ['Registro [canal] saldo_bajo: 220 vez(ces), la última el 2026-09-19T18:05:27Z.'],
    })
    expect(texto).toContain('🟠 Hay algo que atender')
    expect(texto).toContain('saldo_bajo')
    expect(texto).not.toContain('Nada que hacer')
  })

  it('una caída se ve como caída', () => {
    const texto = parte({ sano: false, caida: true, motivos: ['Producción no contesta.'] })
    expect(texto).toContain('🔴 Producción caída')
  })

  it('sin respuesta de producción no se inventa un estado', () => {
    const texto = parte({ salud: null, sano: false, caida: true, motivos: ['no contesta'] })
    expect(texto).toContain('no contestó')
    expect(texto).not.toContain('✅ respondiendo')
  })

  it('avisa de que sin token el parte va incompleto', () => {
    // Sin `HEALTH_DETAIL_TOKEN` no se ve el saldo. Un parte en verde que no
    // miró el saldo tiene que decirlo, o promete más de lo que comprobó.
    expect(parte({ detalle: null })).toContain('no se ven el saldo')
    expect(parte()).not.toContain('no se ven el saldo')
  })

  it('el bot que no puede trabajar no sale como ✅', () => {
    const texto = parte({ salud: { ...SANA, ok: false }, sano: false, caida: true, motivos: ['x'] })
    expect(texto).toContain('❌ no puede trabajar')
  })

  it('el canario con fallos se marca en rojo en la tabla', () => {
    const texto = parte({
      salud: { ...SANA, canario: { ...SANA.canario, fallos: 3 } },
      sano: false,
      motivos: ['el canario encontró 3'],
    })
    expect(texto).toContain('❌ 3 fallo(s)')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE NO SE PUBLICA EN UN REPOSITORIO PÚBLICO
// ═══════════════════════════════════════════════════════════════════════════
//
// `YoverMarkt/bot` es PÚBLICO. Un issue diario contando que al canal le queda
// saldo para dos mensajes, que lleva 30 h sin un pedido o que producción está
// caída es un informe operativo del negocio —indexable y permanente— para
// cualquiera que pase por ahí. El semáforo sí se puede decir: es justo lo que
// este parte existe para dar, y no se puede aprovechar.

describe('el parte en un repositorio público', () => {
  const conProblemas = {
    salud: { ...SANA, inbound_channel: { ...SANA.inbound_channel, hours_since_last_inbound: 31 } },
    detalle: { ok: true, problemas: [] },
    sano: false,
    caida: false,
    motivos: [
      'Registro [canal] saldo_bajo: 220 vez(ces), la última el 2026-09-19T18:05:27Z.',
      'Canal en silencio: 31 h sin un solo mensaje entrante (el límite son 24 h).',
    ],
    fecha: EL_DIA,
  }

  it('NO publica el saldo, ni el silencio, ni cuántas horas lleva', () => {
    const texto = redactarParte({ ...conProblemas, publico: true })
    expect(texto).not.toContain('saldo_bajo')
    expect(texto).not.toContain('31 h')
    expect(texto).not.toContain('Canal en silencio')
  })

  it('pero sí dice que hay algo, y dónde mirarlo', () => {
    const texto = redactarParte({ ...conProblemas, publico: true })
    expect(texto).toContain('🟠 Hay algo que atender')
    expect(texto).toContain('2 cosa(s)')
    expect(texto).toContain('Actions')
  })

  it('un día bueno se ve igual de bien', () => {
    const texto = redactarParte({ ...conProblemas, sano: true, motivos: [], publico: true })
    expect(texto).toContain('🟢 Todo en orden')
    expect(texto).toContain('con normalidad')
  })

  it('en privado sí va el detalle entero', () => {
    const texto = redactarParte({ ...conProblemas, publico: false })
    expect(texto).toContain('saldo_bajo')
    expect(texto).toContain('Canal en silencio')
  })
})

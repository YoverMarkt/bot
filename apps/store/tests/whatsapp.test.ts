import { describe, expect, it } from 'vitest'
import { enlaceWhatsApp, textoComprobante } from '../src/lib/whatsapp'

// El enlace a WhatsApp es, desde el 2026-08-12, la única salida del pedido con
// transferencia: por ahí va el comprobante. Antes era un atajo cómodo y un
// fallo se notaba poco; ahora un enlace roto deja al cliente sin pagar.

describe('el enlace al WhatsApp del negocio', () => {
  it('se queda solo con los dígitos: wa.me no admite «+», espacios ni guiones', () => {
    // Tal como lo tiene guardado Monster Pizza en producción.
    expect(enlaceWhatsApp('+593 99 171-6574')).toBe('https://wa.me/593991716574')
  })

  it('sin teléfono no inventa un enlace: quien llame decide qué pintar', () => {
    expect(enlaceWhatsApp(null)).toBeNull()
    expect(enlaceWhatsApp('')).toBeNull()
    // Un teléfono que no tiene un solo dígito tampoco vale como enlace.
    expect(enlaceWhatsApp('sin número')).toBeNull()
  })

  it('codifica el mensaje, que lleva acentos y emoji', () => {
    const enlace = enlaceWhatsApp('593991716574', textoComprobante(12))
    expect(enlace).toBe(
      'https://wa.me/593991716574?text='
      + encodeURIComponent('Hola, te envío el comprobante de mi pedido #12 🙂'),
    )
    // Ni un espacio ni un «#» crudos: romperían la query del enlace.
    expect(enlace).not.toContain(' ')
    expect(enlace?.split('?text=')[1]).not.toContain('#')
  })

  it('sin texto abre el chat limpio, sin un ?text= vacío colgando', () => {
    expect(enlaceWhatsApp('593991716574')).toBe('https://wa.me/593991716574')
    expect(enlaceWhatsApp('593991716574', '   ')).toBe('https://wa.me/593991716574')
  })
})

describe('el mensaje del comprobante', () => {
  it('nombra el pedido cuando tiene número: es de lo único que el dueño se agarra', () => {
    expect(textoComprobante(7)).toBe('Hola, te envío el comprobante de mi pedido #7 🙂')
    expect(textoComprobante('7')).toBe('Hola, te envío el comprobante de mi pedido #7 🙂')
  })

  // ⚠️ El fallo que este test caza es REAL y estaba en producción: el código
  // anterior pegaba el «#» siempre y lo intentaba limpiar con
  // `.replace(' #  ', ' ')`, que busca dos espacios que nunca están ahí.
  // Comprobado ejecutándolo: salía «Hola, te envío el comprobante de mi pedido
  // # 🙂», con una almohadilla suelta que no identifica ningún pedido.
  it('sin número no deja una almohadilla suelta', () => {
    for (const vacio of [null, undefined, '']) {
      expect(textoComprobante(vacio)).toBe('Hola, te envío el comprobante de mi pedido 🙂')
      expect(textoComprobante(vacio)).not.toContain('#')
    }
  })
})

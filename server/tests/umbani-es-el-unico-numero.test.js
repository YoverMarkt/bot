import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { pedidoCreado } = require('../dist/services/marketplace-checkout')
const { publicBusiness } = require('../dist/services/storefront')

// ═══════════════════════════════════════════════════════════════════════════
// EL CLIENTE HABLA CON UN SOLO NÚMERO: EL DE UMBANI
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Corrección del dueño, 2026-09-07: «todo se envía al marketplace, solo
// existe un número, el de Umbani, donde se envían comprobantes, ubicación,
// etc., y ya por detrás le llega a cada local. El campo de número del dueño es
// solo para que él pida reportes.»
//
// Dos sitios se saltaban esa regla:
//
//   · El checkout, cuando el local no tenía datos bancarios, respondía
//     «Escríbeles al {teléfono} para coordinar el pago». Eso parte la
//     conversación en dos: el comprobante, la ubicación y el seguimiento
//     viajan por Umbani, y el cliente se llevaría el pedido a un número que no
//     los recibe.
//   · La mini app tenía a `businesses.phone` como respaldo del canal. Estaba
//     LATENTE —con el campo vacío caía al número de la plataforma y parecía
//     correcto— y se habría disparado el día que alguien rellenara la ficha.
//
// La distinción que importa: `whatsapp_number` es un CANAL propio del local
// (legítimo, hay negocios que lo tienen); `phone` es un dato de CONTACTO del
// dueño, el mismo con el que pide sus reportes.

const transferencia = {
  code: 'transferencia', label: 'Transferencia bancaria',
  help_text: null, is_prepaid: true, requires_proof: true,
}

describe('el checkout nunca manda al cliente fuera de Umbani', () => {
  it('sin datos bancarios avisa, y NO da un teléfono al que escribir', () => {
    const r = pedidoCreado({
      orderNumber: 7, total: 17.6, metodo: transferencia, cuenta: null,
    })
    expect(r.reply).toContain('todavía no cargó sus datos de pago')
    expect(r.reply).toContain('te escribimos por aquí')
    // Ni un teléfono, ni una invitación a salirse de esta conversación.
    expect(r.reply).not.toMatch(/\d{7,}/)
    expect(r.reply.toLowerCase()).not.toContain('escríbeles')
  })

  it('con datos bancarios pide el comprobante POR AQUÍ', () => {
    const r = pedidoCreado({
      orderNumber: 8, total: 3.85, metodo: transferencia,
      cuenta: {
        bank_name: 'Pichincha', account_type: 'ahorros',
        account_number: '2200123456', holder_name: 'La Abuelita',
      },
    })
    expect(r.reply).toContain('2200123456')
    expect(r.reply).toContain('Valor exacto: *$3.85*')
    expect(r.reply).toContain('envíame la foto del comprobante por aquí')
  })
})

describe('la mini app enseña el número de la PLATAFORMA, no el del dueño', () => {
  const base = {
    id: 'b1', slug: 'la-abuelita', name: 'La Abuelita', active: true,
    takes_orders: true, storefront_enabled: true,
  }

  it('`businesses.phone` NO se usa como canal: cae al de la plataforma', () => {
    // El caso que se habría disparado al rellenar la ficha del local.
    const app = publicBusiness(
      { ...base, phone: '0978619700', whatsapp_number: null },
      null,
      '+593991716574',
    )
    expect(app.phone).toBe('+593991716574')
    expect(app.phone).not.toContain('0978619700')
    // Y la app tiene que saber que es el de Umbani, o dará la instrucción
    // equivocada: «escríbele a Umbani y elige tu local».
    expect(app.phoneIsPlatform).toBe(true)
  })

  it('un local CON canal propio sigue usando el suyo', () => {
    // No todo local pasa por Umbani: el que tiene su número atiende por él, y
    // esta regla no se lo quita.
    const app = publicBusiness(
      { ...base, phone: '0978619700', whatsapp_number: '+593987654321' },
      null,
      '+593991716574',
    )
    expect(app.phone).toBe('+593987654321')
    expect(app.phoneIsPlatform).toBe(false)
  })
})

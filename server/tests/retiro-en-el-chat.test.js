import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ck = require('../dist/services/marketplace-checkout')

// ═══════════════════════════════════════════════════════════════════════════
// «¿TE LO LLEVAMOS O LO RECOGES?» EN EL CHAT
// ═══════════════════════════════════════════════════════════════════════════
//
// La mini app ofrecía retiro desde siempre; el chat mandaba SIEMPRE `delivery`.
// Un cliente que quería pasar a recoger su almuerzo tenía que dar una dirección
// a la que nadie iba a ir.
//
// ⚠️ Es la única parte de esta tanda que AHORRA un mensaje en vez de gastarlo:
// quien recoge no tiene dirección que dar, así que se salta la pregunta de la
// ubicación entera. Y el pedido nace sin envío que cobrar.

const CON_PUNTO = {
  name: 'La Abuelita',
  address: 'Av. del Ejército, frente a Portocentro, Portoviejo',
  latitude: -1.0546, longitude: -80.4547,
}

describe('cuándo se pregunta', () => {
  it('con punto en el mapa, se ofrecen las dos formas', () => {
    const paso = ck.pedirTipoDeEntrega(CON_PUNTO)
    expect(paso).not.toBeNull()
    expect(paso.options).toEqual(['🛵 A domicilio', '🛍️ Lo recojo yo'])
  })

  // ⚠️ Sin punto NO se pregunta, y esa es la regla que evita repetir el
  // agujero del 2026-09-10: ofrecer «pasa a retirarlo» a quien solo sabe el
  // nombre del negocio. El local sin punto vende a domicilio igual que antes.
  it('SIN punto no se ofrece retiro: no habría a dónde ir', () => {
    expect(ck.pedirTipoDeEntrega({ name: 'Sin Punto' })).toBeNull()
    expect(ck.pedirTipoDeEntrega({ latitude: -1.05 })).toBeNull()
    expect(ck.pedirTipoDeEntrega({})).toBeNull()
  })
})

describe('leer la respuesta', () => {
  it('acepta el botón, el número y el texto suelto', () => {
    expect(ck.elegirEntrega('🛵 A domicilio')).toBe('delivery')
    expect(ck.elegirEntrega('🛍️ Lo recojo yo')).toBe('pickup')
    expect(ck.elegirEntrega('1')).toBe('delivery')
    expect(ck.elegirEntrega('2')).toBe('pickup')
    // WhatsApp recorta los títulos: se compara también sin el emoji.
    expect(ck.elegirEntrega('a domicilio')).toBe('delivery')
    expect(ck.elegirEntrega('lo recojo')).toBe('pickup')
    expect(ck.elegirEntrega('yo lo retiro')).toBe('pickup')
  })

  it('lo que no entiende devuelve null, no adivina', () => {
    // Adivinar aquí manda un pedido a domicilio a alguien que iba a pasar, o
    // al revés: mejor repreguntar que repartir a donde nadie espera.
    for (const texto of ['', 'hola', 'quizás', '9']) {
      expect(ck.elegirEntrega(texto), texto).toBeNull()
    }
  })
})

describe('lo que lee quien va a retirar', () => {
  it('lleva el local, la dirección y el enlace, todo en UN mensaje', () => {
    const texto = ck.confirmarRetiro(CON_PUNTO)
    expect(texto).toContain('La Abuelita')
    expect(texto).toContain('Av. del Ejército')
    expect(texto).toContain('https://www.google.com/maps/dir/?api=1&destination=-1.0546,-80.4547')
    expect(texto).toContain('cuando esté listo')
  })

  it('sin dirección escrita no deja la frase coja', () => {
    const texto = ck.confirmarRetiro({ name: 'Solo Punto', latitude: -1.05, longitude: -80.45 })
    expect(texto).toContain('Solo Punto')
    expect(texto).toContain('Cómo llegar')
    expect(texto).not.toContain('undefined')
  })
})

describe('el retiro está CONECTADO al flujo', () => {
  // ⚠️ El fallo de las ocho veces: lógica correcta y sin llamador. Estas
  // pruebas leen el código del flujo y exigen que el paso exista de verdad.
  const { readFileSync } = require('node:fs')
  const { fileURLToPath } = require('node:url')
  const entry = readFileSync(fileURLToPath(new URL('../src/services/marketplace-entry.ts', import.meta.url)), 'utf8')
  const webhook = readFileSync(fileURLToPath(new URL('../src/services/inbound-webhook.ts', import.meta.url)), 'utf8')

  it('el estado nuevo entra en el despacho del checkout', () => {
    expect(entry).toMatch(/current_state === 'esperando_entrega'/)
  })

  it('se pregunta al confirmar el carrito, antes de la ubicación', () => {
    expect(entry).toMatch(/checkout\.pedirTipoDeEntrega\(/)
    expect(entry).toMatch(/state: entrega \? 'esperando_entrega' : 'esperando_ubicacion'/)
  })

  it('el RETIRO salta la ubicación y va directo al pago', () => {
    expect(entry).toMatch(/state: 'esperando_metodo_pago'[\s\S]{0,400}confirmarRetiro/)
  })

  // ⚠️ Lo que de verdad decide: que el pedido NAZCA como retiro. Sin esto el
  // cliente elegiría «lo recojo» y la base crearía un domicilio con envío.
  it('el pedido nace con el fulfillment ELEGIDO, no con una constante', () => {
    expect(entry).toMatch(/fulfillment: pendiente\.fulfillment === 'pickup' \? 'pickup' : 'delivery'/)
    expect(webhook).toMatch(/fulfillment: entrada\.fulfillment === 'pickup' \? 'pickup' : 'delivery'/)
    // Y ya NO existe la constante que había antes.
    expect(webhook).not.toMatch(/fulfillment: 'delivery',/)
  })

  it('en retiro NO se exige dirección: sería un bucle sin salida', () => {
    expect(entry).toMatch(/pendiente\.fulfillment !== 'pickup' && !pendiente\.addressId/)
  })
})

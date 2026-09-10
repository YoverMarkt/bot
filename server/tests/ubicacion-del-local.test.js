import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { leerUbicacion, tieneUbicacion, comoLlegar } = require('../dist/lib/ubicacion')
const { publicBusiness } = require('../dist/services/storefront')

// ═══════════════════════════════════════════════════════════════════════════
// EL PUNTO DEL LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// El sistema tenía el punto de UNA sola punta del reparto. El del CLIENTE está
// desde siempre: lo captura la mini app con el GPS del navegador, lo captura el
// chat cuando comparte su ubicación de WhatsApp, y el pedido lo CONGELA en
// `delivery_latitude`/`delivery_longitude`. El del LOCAL no existía.
//
// Sin él no se puede decirle a quien retira a dónde ir —hoy el aviso dice
// «pasa a retirarlo por Monster Pizza» y NO dice dónde— ni darle a un
// repartidor su punto de recogida.

describe('leer un punto de un formulario', () => {
  it('acepta un par válido y lo redondea a lo que guarda la columna', () => {
    // `numeric(10,7)` son ~1 cm. Redondear aquí y no dejárselo a PostgreSQL
    // evita que lo que se lee de vuelta no sea lo que se mandó.
    const r = leerUbicacion({ latitude: -1.06614341234, longitude: -80.46701298765 })
    expect(r.ok).toBe(true)
    expect(r.punto).toEqual({ latitude: -1.0661434, longitude: -80.467013 })
  })

  it('vaciar las dos borra el punto: un local que se muda no tiene', () => {
    for (const body of [{}, { latitude: null, longitude: null }, { latitude: '', longitude: '' }]) {
      const r = leerUbicacion(body)
      expect(r.ok, JSON.stringify(body)).toBe(true)
      expect(r.punto).toEqual({ latitude: null, longitude: null })
    }
  })

  // ⚠️ Media coordenada NO es media ubicación: una latitud sin longitud apunta
  // al meridiano de Greenwich; una longitud sin latitud, al ecuador. En los dos
  // casos el repartidor sale hacia el Atlántico.
  it('rechaza media coordenada, en las dos direcciones', () => {
    for (const body of [{ latitude: -1.066 }, { longitude: -80.467 }]) {
      const r = leerUbicacion(body)
      expect(r.ok, JSON.stringify(body)).toBe(false)
      expect(r.error).toMatch(/latitud Y longitud/i)
    }
  })

  it('rechaza lo que está fuera del planeta', () => {
    expect(leerUbicacion({ latitude: 91, longitude: 0 }).ok).toBe(false)
    expect(leerUbicacion({ latitude: 0, longitude: 181 }).ok).toBe(false)
    expect(leerUbicacion({ latitude: 'aquí', longitude: 'allá' }).ok).toBe(false)
  })

  // ⚠️ El (0,0) es un punto REAL —el golfo de Guinea— pero nunca es una
  // tienda: es lo que sale cuando un formulario manda ceros por defecto o un
  // parseo falla. Dejarlo pasar manda al repartidor a 5.000 km de Ghana.
  it('rechaza el (0,0), que siempre es un formulario roto', () => {
    const r = leerUbicacion({ latitude: 0, longitude: 0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Atlántico/i)
  })
})

describe('llegar al local', () => {
  const local = { latitude: -1.0661434, longitude: -80.467013 }

  it('arma el enlace de «cómo llegar», sin API key ni coste', () => {
    // Es una URL normal de Google Maps: la abre la app nativa del teléfono.
    // Lo que se paga es DIBUJAR un mapa dentro de nuestra app, no llegar.
    expect(comoLlegar(local)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-1.0661434,-80.467013',
    )
  })

  it('sin punto no inventa un enlace: devuelve null', () => {
    expect(comoLlegar({})).toBeNull()
    expect(comoLlegar({ latitude: -1.06 })).toBeNull()
    expect(tieneUbicacion({ latitude: -1.06 })).toBe(false)
    expect(tieneUbicacion(local)).toBe(true)
  })
})

describe('el punto viaja a la mini app', () => {
  const base = {
    id: 'b1', slug: 'la-abuelita', name: 'La Abuelita',
    active: true, takes_orders: true, storefront_enabled: true,
  }

  it('la tienda recibe el punto del local para poder pintarlo', () => {
    const app = publicBusiness({ ...base, latitude: -1.0661434, longitude: -80.467013 }, null, null)
    expect(app.latitude).toBe(-1.0661434)
    expect(app.longitude).toBe(-80.467013)
  })

  it('un local sin punto lo manda en null, no en 0', () => {
    // Un 0 se pinta como un pin en el golfo de Guinea; un null se esconde.
    const app = publicBusiness(base, null, null)
    expect(app.latitude).toBeNull()
    expect(app.longitude).toBeNull()
  })

  // ⚠️ El punto del local es público —la dirección de un comercio está en su
  // fachada—, pero el teléfono del dueño NO sale nunca: eso es un dato
  // personal, y por eso `phone` es siempre el de la plataforma.
  it('el punto es público, el teléfono del dueño sigue sin salir', () => {
    const app = publicBusiness(
      { ...base, latitude: -1.0661434, longitude: -80.467013, phone: '0978619700' },
      null, '+593991716574',
    )
    expect(app.latitude).toBe(-1.0661434)
    expect(app.phone).toBe('+593991716574')
    expect(JSON.stringify(app)).not.toContain('0978619700')
  })
})

describe('el aviso de «listo para retirar» ya dice DÓNDE', () => {
  const { textoDelAviso, crearNotificadorDePedidos } = require('../dist/services/order-notify')
  const local = {
    name: 'La Abuelita',
    address: 'Av. del Ejército, frente a Portocentro, Portoviejo',
    latitude: -1.0546, longitude: -80.4547,
  }
  const pedido = { order_number: 12, contact_phone: '593999111222', total: 7.7 }

  // ⚠️ Hasta el 2026-09-10 este aviso decía «pasa a retirarlo por La Abuelita»
  // y se acababa ahí: le daba el NOMBRE a quien tiene que salir de casa. Es el
  // mensaje donde más falta hace el dato, y era justo el que no lo daba.
  it('lleva la dirección y el enlace DENTRO del mismo mensaje', () => {
    const texto = textoDelAviso(local, pedido, 'listo_para_retiro')
    expect(texto).toContain('está listo')
    expect(texto).toContain('Av. del Ejército')
    expect(texto).toContain('https://www.google.com/maps/dir/?api=1&destination=-1.0546,-80.4547')
  })

  it('un local sin punto no deja la frase coja', () => {
    const texto = textoDelAviso({ name: 'Sin Punto' }, pedido, 'listo_para_retiro')
    expect(texto).toContain('está listo')
    expect(texto).not.toContain('Cómo llegar')
    expect(texto).not.toContain('undefined')
  })

  it('manda el mapa nativo SOLO al retirar, y solo con punto', async () => {
    const mapas = []
    const notificar = crearNotificadorDePedidos({
      enviar: async () => true,
      registrarError: async () => {},
      enviarUbicacion: async (_n, tel, u) => { mapas.push({ tel, u }); return true },
    })

    // ⚠️ El mapa es un mensaje MÁS —WhatsApp no deja adjuntarlo a un texto— así
    // que se gasta en el ÚNICO momento en que el cliente sale a la calle.
    await notificar(local, pedido, 'listo_para_retiro')
    expect(mapas).toHaveLength(1)
    expect(mapas[0].u).toMatchObject({ latitude: -1.0546, longitude: -80.4547, name: 'La Abuelita' })

    // En los demás hitos NO se gasta: el texto ya dice lo que hace falta.
    for (const hito of ['preparacion', 'en_camino', 'completado', 'cancelado']) {
      await notificar(local, pedido, hito)
    }
    expect(mapas, 'solo el de retirar gasta un mensaje de mapa').toHaveLength(1)

    // Y un local sin punto tampoco lo gasta.
    await notificar({ name: 'Sin Punto' }, pedido, 'listo_para_retiro')
    expect(mapas).toHaveLength(1)
  })

  it('si el mapa falla, el aviso ya se mandó igual', async () => {
    // El texto va PRIMERO y lleva la dirección: el mapa es la guinda.
    let textoEnviado = null
    const notificar = crearNotificadorDePedidos({
      enviar: async (_n, _t, m) => { textoEnviado = m; return true },
      registrarError: async () => {},
      enviarUbicacion: async () => { throw new Error('YCloud caído') },
    })
    const ok = await notificar(local, pedido, 'listo_para_retiro')
    expect(ok).toBe(true)
    expect(textoEnviado).toContain('Av. del Ejército')
  })
})

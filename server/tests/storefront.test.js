import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  buildStorefrontCatalog,
  canOrder,
  publicBusiness,
  storefrontCapabilities,
  storefrontStatus,
} = require('../dist/services/storefront')

const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Pizzería Roma',
  slug: 'pizza-roma',
  active: true,
  suspended: false,
  storefront_enabled: true,
  takes_orders: true,
  whatsapp_number: '+593991716574',
  ...extra,
})

describe('la tienda del negocio', () => {
  describe('cuándo se puede pedir', () => {
    it('abierta si el negocio tiene tienda y está en horario', () => {
      const estado = storefrontStatus({ business: negocio(), outsideHours: false })
      expect(estado).toBe('abierta')
      expect(canOrder(estado)).toBe(true)
    })

    // Se puede mirar el menú de madrugada; encargar una pizza que nadie hará, no.
    it('cerrada fuera de horario: se ve, pero no se pide', () => {
      const estado = storefrontStatus({ business: negocio(), outsideHours: true })
      expect(estado).toBe('cerrada')
      expect(canOrder(estado)).toBe(false)
    })

    it('no disponible si el negocio no tiene tienda activada', () => {
      const estado = storefrontStatus({
        business: negocio({ storefront_enabled: false }),
        outsideHours: false,
      })
      expect(estado).toBe('no_disponible')
      expect(canOrder(estado)).toBe(false)
    })

    it('suspendida si el negocio está suspendido', () => {
      expect(storefrontStatus({
        business: negocio({ suspended: true }),
        outsideHours: false,
      })).toBe('suspendida')
    })

    it('no disponible si el negocio no existe o está inactivo', () => {
      expect(storefrontStatus({ business: null, outsideHours: false })).toBe('no_disponible')
      expect(storefrontStatus({
        business: negocio({ active: false }),
        outsideHours: false,
      })).toBe('no_disponible')
    })

    // El caso de la barbería: enciende la tienda sin vender ni alojar nada y
    // el cliente abriría una app vacía. Mejor no existir que existir rota.
    it('no disponible si el negocio no vende ni aloja, aunque tenga la tienda activada', () => {
      const barberia = negocio({ takes_orders: false, lodging_enabled: false })
      expect(storefrontStatus({ business: barberia, outsideHours: false })).toBe('no_disponible')
    })

    it('un hostal sin catálogo sí tiene tienda: aloja', () => {
      const hostal = negocio({ takes_orders: false, lodging_enabled: true })
      expect(storefrontStatus({ business: hostal, outsideHours: false })).toBe('abierta')
    })
  })

  // La app NO puede adivinar el flujo por el tipo de negocio: un carrito con
  // "+/− habitaciones" no es una estadía. Manda la bandera, no el `type`.
  describe('qué sabe hacer la tienda', () => {
    it('una pizzería solo hace pedidos', () => {
      expect(storefrontCapabilities(negocio())).toEqual({ orders: true, lodging: false })
    })

    it('un hostal solo hace estadías', () => {
      expect(storefrontCapabilities(negocio({
        type: 'hotel', takes_orders: false, lodging_enabled: true,
      }))).toEqual({ orders: false, lodging: true })
    })

    // Un hostal con restaurante: las dos cosas conviven en la misma tienda.
    it('un hostal con restaurante hace las dos', () => {
      expect(storefrontCapabilities(negocio({
        takes_orders: true, lodging_enabled: true,
      }))).toEqual({ orders: true, lodging: true })
    })

    it('el tipo de negocio no decide nada por su cuenta', () => {
      // Tipo hotel pero sin la bandera: no aloja. El dueño manda.
      expect(storefrontCapabilities(negocio({
        type: 'hotel', lodging_enabled: false,
      })).lodging).toBe(false)
    })

    it('sin negocio no hay capacidades', () => {
      expect(storefrontCapabilities(null)).toEqual({ orders: false, lodging: false })
    })

    it('la portada le dice a la app qué flujo pintar', () => {
      const publico = publicBusiness(negocio({ lodging_enabled: true }))
      expect(publico.capabilities).toEqual({ orders: true, lodging: true })
    })
  })

  describe('el catálogo que ve el cliente', () => {
    const entrada = {
      categories: [
        { id: 'cat-1', name: 'Pizzas', image_url: 'https://cdn/pizzas.jpg', sort: 1 },
        { id: 'cat-2', name: 'Vacía', sort: 2 },
      ],
      products: [
        {
          id: 'prod-1', name: 'Pizza Pepperoni', price: '12.50',
          category_id: 'cat-1', stock: 'disponible', tags: ['pizzas'],
          image_url: 'https://cdn/pepperoni.jpg',
        },
        {
          id: 'prod-2', name: 'Gaseosa', price: '2.00',
          category_id: null, stock: 'agotado', tags: [],
        },
      ],
      variants: [
        { id: 'v-1', product_id: 'prod-1', name: 'Personal', price: '8.50', sort: 1 },
        { id: 'v-2', product_id: 'prod-1', name: 'Mediana', price: '12.50', sort: 2 },
        { id: 'v-3', product_id: 'prod-1', name: 'Familiar', price: '16.50', sort: 3 },
        { id: 'v-4', product_id: 'prod-1', name: 'Agotada', price: '20.00', stock: 'agotado', sort: 4 },
      ],
      extras: [
        { id: 'e-1', product_id: 'prod-1', group_label: 'Extras', name: 'Queso extra', price_delta: '1.00' },
        { id: 'e-2', product_id: null, category_tag: 'pizzas', group_label: 'Extras', name: 'Orégano', price_delta: '0.50' },
      ],
    }

    it('arma cada producto con sus variantes y extras', () => {
      const catalogo = buildStorefrontCatalog(entrada)
      const pizza = catalogo.products.find(p => p.id === 'prod-1')
      expect(pizza.hasVariants).toBe(true)
      expect(pizza.variants.map(v => `${v.name} $${v.price}`)).toEqual([
        'Personal $8.5', 'Mediana $12.5', 'Familiar $16.5',
      ])
    })

    it('no ofrece variantes agotadas', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.variants.map(v => v.name)).not.toContain('Agotada')
    })

    it('el precio del producto con variantes es "desde" la más barata', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.priceFrom).toBe(8.5)
    })

    it('suma los extras del producto y los de su categoría, sin repetir', () => {
      const pizza = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-1')
      expect(pizza.extras.map(e => e.name).sort()).toEqual(['Orégano', 'Queso extra'])
    })

    it('marca como no disponible el producto agotado', () => {
      const gaseosa = buildStorefrontCatalog(entrada).products.find(p => p.id === 'prod-2')
      expect(gaseosa.available).toBe(false)
      expect(gaseosa.hasVariants).toBe(false)
    })

    // Una categoría vacía en la tienda parece un error del negocio.
    it('esconde las categorías sin productos', () => {
      const catalogo = buildStorefrontCatalog(entrada)
      expect(catalogo.categories.map(c => c.name)).toEqual(['Pizzas'])
    })

    it('cuenta los productos sin categoría para que la app los agrupe', () => {
      expect(buildStorefrontCatalog(entrada).uncategorized).toBe(1)
    })

    it('respeta el precio de oferta cuando no hay variantes', () => {
      const catalogo = buildStorefrontCatalog({
        ...entrada,
        products: [{ id: 'p', name: 'Combo', price: '20.00', price_sale: '15.00', stock: 'disponible' }],
        variants: [],
        extras: [],
      })
      expect(catalogo.products[0].priceFrom).toBe(15)
    })
  })

  describe('lo que se publica del negocio', () => {
    it('expone lo justo para pintar la portada', () => {
      const publico = publicBusiness(negocio({ slogan: 'La mejor pizza' }))
      expect(publico).toEqual({
        id: 'biz-1',
        name: 'Pizzería Roma',
        slug: 'pizza-roma',
        type: null,
        slogan: 'La mejor pizza',
        description: null,
        address: null,
        phone: '+593991716574',
        capabilities: { orders: true, lodging: false },
      })
    })

    // La tienda es pública: una credencial filtrada aquí sería un incidente.
    it('nunca filtra credenciales del negocio', () => {
      const publico = publicBusiness(negocio({
        ycloud_api_key: 'clave-secreta',
        ycloud_webhook_secret: 'whsec_secreto',
        telegram_bot_token: 'token-secreto',
        meta_token: 'meta-secreto',
      }))
      const texto = JSON.stringify(publico)
      expect(texto).not.toMatch(/secreta|secreto|whsec/)
      expect(Object.keys(publico)).not.toContain('ycloud_api_key')
    })
  })
})

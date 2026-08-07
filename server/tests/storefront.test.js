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

    // ── El mismo grupo NO puede salir dos veces ──────────────────────────
    //
    // Los extras vienen de `menu_modifiers` (la tabla vieja, que el bot sigue
    // usando) y los grupos de opciones del motor nuevo. Al construir el motor
    // se COPIARON los modificadores sin retirar los originales, así que un
    // negocio con las dos cosas mandaba las mismas opciones por los dos campos
    // y la ficha las pintaba DOS VECES: pasó con los 19 sabores de pizza.
    it('un grupo que ya sirve el motor de opciones no se repite como extra', () => {
      const conAmbos = {
        ...entrada,
        extras: [
          ...entrada.extras,
          { id: 'e-3', product_id: null, category_tag: 'pizzas', group_label: 'Sabor', name: 'Hawaiana', price_delta: '0' },
          { id: 'e-4', product_id: null, category_tag: 'pizzas', group_label: 'Sabor', name: 'Mexicana', price_delta: '0' },
        ],
        optionGroups: [
          { id: 'g-1', name: 'Sabor', category_id: 'cat-1', selection_type: 'multiple', max_selectable: 1 },
        ],
        options: [
          { id: 'o-1', option_group_id: 'g-1', name: 'Hawaiana', stock: 'disponible' },
          { id: 'o-2', option_group_id: 'g-1', name: 'Mexicana', stock: 'disponible' },
        ],
      }
      const pizza = buildStorefrontCatalog(conAmbos).products.find(p => p.id === 'prod-1')

      // El sabor sale UNA vez, y por el motor nuevo: es el que sabe de
      // obligatorios, mínimos y estrategias de precio.
      expect(pizza.optionGroups.map(g => g.name)).toEqual(['Sabor'])
      expect(pizza.extras.map(e => e.group)).not.toContain('Sabor')
      // Y los extras que NO chocan con ningún grupo siguen saliendo.
      expect(pizza.extras.map(e => e.name).sort()).toEqual(['Orégano', 'Queso extra'])
    })

    // Un negocio que solo tenga la tabla vieja no puede perder sus extras.
    it('sin grupos del motor, los extras salen tal cual', () => {
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
        brandColor: null,
        logoUrl: null,
        deliveryFee: 0,
        // Sin valor en la base se cae al defecto en vez de publicar `null`:
        // la portada tiene que poder decir un tiempo siempre.
        prepTimeMinutes: 25,
        deliveryExtraMinutes: 0,
      })
    })

    // Este número no solo se pinta: es el mismo con el que el servidor calcula
    // las franjas programables. Si la portada dijera 15 y las franjas usaran
    // 40, el cliente elegiría una hora que su propio pedido va a rechazar.
    it('publica el tiempo del negocio, saneado', () => {
      expect(publicBusiness(negocio({ prep_time_minutes: 40 })).prepTimeMinutes).toBe(40)
      expect(publicBusiness(negocio({ delivery_extra_minutes: 15 })).deliveryExtraMinutes).toBe(15)
      // Un cero de preparación prometería el pedido en el acto.
      expect(publicBusiness(negocio({ prep_time_minutes: 0 })).prepTimeMinutes).toBe(25)
      expect(publicBusiness(negocio({ prep_time_minutes: -5 })).prepTimeMinutes).toBe(1)
      // El del envío SÍ puede ser cero: hay quien entrega en su cuadra.
      expect(publicBusiness(negocio({ delivery_extra_minutes: 0 })).deliveryExtraMinutes).toBe(0)
    })

    // El color acaba dentro de un estilo de la mini app: solo sale de aquí si
    // es un hex de 6 dígitos. Cualquier otra cosa se descarta.
    it('solo publica un color de marca con forma de hex', () => {
      expect(publicBusiness(negocio({ brand_color: '#d9f950' })).brandColor).toBe('#D9F950')
      expect(publicBusiness(negocio({ brand_color: 'rojo' })).brandColor).toBeNull()
      expect(publicBusiness(negocio({ brand_color: '#fff' })).brandColor).toBeNull()
      expect(
        publicBusiness(negocio({ brand_color: 'red;background:url(x)' })).brandColor,
      ).toBeNull()
    })

    // El logo acaba en un <img> de una app pública: nada de http ni javascript:.
    it('solo publica un logo servido por https', () => {
      expect(publicBusiness(negocio({ logo_url: 'https://res.cloudinary.com/x/logo.png' })).logoUrl)
        .toBe('https://res.cloudinary.com/x/logo.png')
      expect(publicBusiness(negocio({ logo_url: 'http://inseguro.test/logo.png' })).logoUrl).toBeNull()
      expect(publicBusiness(negocio({ logo_url: 'javascript:alert(1)' })).logoUrl).toBeNull()
    })

    it('publica el costo de envío como número, nunca negativo', () => {
      expect(publicBusiness(negocio({ delivery_fee: '2.50' })).deliveryFee).toBe(2.5)
      expect(publicBusiness(negocio({ delivery_fee: -5 })).deliveryFee).toBe(0)
      expect(publicBusiness(negocio({ delivery_fee: null })).deliveryFee).toBe(0)
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

// Arma la tienda tal y como la ve el cliente: negocio, estado abierto/cerrado,
// categorías, productos con sus variantes y sus extras.
//
// Dos reglas que se aplican aquí y no en la app:
//
//  1. Si el negocio está CERRADO se puede mirar, pero no pedir. Que el cliente
//     vea el menú a las 3 de la mañana es bueno —vuelve cuando abras—; que
//     pueda encargar una pizza que nadie va a hacer, no.
//  2. Los precios salen SIEMPRE de la base. La app manda ids, nunca importes.
//     Lo que se pinte en pantalla es informativo; lo que se cobra lo decide el
//     servidor (regla inviolable #8).

// El tipo vive con el motor que lo usa, y se reexporta para que quien arma el
// catálogo no tenga que saber de dónde sale.
import { calculateProductPrice, type PricingStrategy } from './pricing'
export type { PricingStrategy }

export interface StorefrontBusiness {
  id: string
  name?: string | null
  slug?: string | null
  type?: string | null
  description?: string | null
  address?: string | null
  phone?: string | null
  whatsapp_number?: string | null
  slogan?: string | null
  active?: boolean | null
  suspended?: boolean | null
  storefront_enabled?: boolean | null
  takes_orders?: boolean | null
  lodging_enabled?: boolean | null
  delivery_fee?: number | string | null
  brand_color?: string | null
  logo_url?: string | null
  /** Minutos hasta tenerlo listo. Manda también en las franjas programables. */
  prep_time_minutes?: number | string | null
  /** Minutos que suma llevarlo a domicilio. Solo se muestra. */
  delivery_extra_minutes?: number | string | null
}

// El color lo escribe el dueño en su panel y acaba pintando la mini app, así
// que se vuelve a comprobar aquí: solo un hex de 6 dígitos sale del servidor.
// Cualquier otra cosa se descarta y la tienda usa su color por defecto.
const HEX = /^#[0-9a-fA-F]{6}$/
export const safeBrandColor = (valor?: string | null) => (
  typeof valor === 'string' && HEX.test(valor.trim()) ? valor.trim().toUpperCase() : null
)

export interface CatalogCategory {
  id: string
  name: string
  description?: string | null
  image_url?: string | null
  sort?: number
}

export interface CatalogProduct {
  id: string
  name: string
  description?: string | null
  price?: string | number | null
  price_sale?: string | number | null
  stock?: string | null
  image_url?: string | null
  video_url?: string | null
  tags?: string[] | null
  category_id?: string | null
  /** simple · configurable · combo · daily_menu · weighted. */
  product_type?: string | null
}

export type ProductType = 'simple' | 'configurable' | 'combo' | 'daily_menu' | 'weighted'

export interface CatalogVariant {
  id: string
  product_id: string
  name: string
  price: string | number
  price_sale?: string | number | null
  stock?: string | null
  sort?: number
}

export interface CatalogExtra {
  id: string
  product_id?: string | null
  category_tag?: string | null
  group_label?: string | null
  name: string
  description?: string | null
  price_delta: string | number
  max_selectable?: number | null
  sort?: number
}

/**
 * Un grupo de opciones tal y como sale de la base. Cuelga de un producto o de
 * una categoría —nunca de ambos— y es lo que sustituye a `CatalogExtra` en la
 * mini app: aquí la obligatoriedad y los mínimos existen de verdad, y sin ellos
 * no se puede armar un almuerzo ni una parrillada.
 */
export interface CatalogOptionGroup {
  id: string
  product_id?: string | null
  category_id?: string | null
  name: string
  description?: string | null
  selection_type?: string | null
  required?: boolean | null
  min_selectable?: number | null
  max_selectable?: number | null
  pricing_strategy?: string | null
  free_selections?: number | null
  sort?: number
}

export interface CatalogOption {
  id: string
  option_group_id: string
  name: string
  description?: string | null
  image_url?: string | null
  price_adjustment: string | number
  references_product_id?: string | null
  default_selected?: boolean | null
  stock?: string | null
  sort?: number
}

/**
 * Qué se ofrece «además» y desde dónde. Ambos orígenes nulos = de todo el
 * negocio, que es el caso del carrito.
 */
export interface CatalogRecommendation {
  id: string
  source_product_id?: string | null
  source_category_id?: string | null
  recommended_product_id: string
  section?: string | null
  sort?: number
}

export type StorefrontStatus = 'abierta' | 'cerrada' | 'no_disponible' | 'suspendida'

/**
 * Qué sabe hacer esta tienda. NO es lo mismo vender comida que alojar gente, y
 * la app no puede adivinarlo: un hostal con carrito de "+/− habitaciones" sería
 * un producto roto, porque una estadía se pide por fechas, no por unidades.
 *
 * Manda la bandera del negocio, nunca su `type`: el tipo solo recomienda
 * valores al crearlo y el dueño puede cambiarlos a mano.
 */
export interface StorefrontCapabilities {
  /** Catálogo con carrito: comida, bebidas, retail. */
  orders: boolean
  /** Estadías por fechas: hotel, hostal, alojamiento. */
  lodging: boolean
}

export function storefrontCapabilities(
  business: StorefrontBusiness | null,
): StorefrontCapabilities {
  return {
    orders: business?.takes_orders === true,
    lodging: business?.lodging_enabled === true,
  }
}

const money = (value: unknown): number | null => {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null
}

const disponible = (stock?: string | null): boolean => String(stock || 'disponible') !== 'agotado'

/**
 * ¿Puede este negocio tener tienda, y está abierta ahora?
 *
 * `cerrada` no es un error: la tienda se ve igual, solo que sin pedir.
 */
export function storefrontStatus(input: {
  business: StorefrontBusiness | null
  outsideHours: boolean
}): StorefrontStatus {
  const { business } = input
  if (!business || business.active === false) return 'no_disponible'
  if (business.suspended === true) return 'suspendida'
  if (business.storefront_enabled !== true) return 'no_disponible'
  // Una tienda que no vende ni aloja no tiene nada que mostrar. Es el caso de
  // la barbería: enciende la tienda por error y el cliente abre una app vacía.
  // Mejor no existir que existir rota; la barbería se queda con el agente.
  const capacidades = storefrontCapabilities(business)
  if (!capacidades.orders && !capacidades.lodging) return 'no_disponible'
  return input.outsideHours ? 'cerrada' : 'abierta'
}

/** Solo se puede pedir con la tienda abierta. */
export const canOrder = (status: StorefrontStatus): boolean => status === 'abierta'

/**
 * Junta catálogo, variantes y extras en la forma que consume la app: cada
 * producto ya trae lo suyo, para que la tienda no tenga que cruzar nada.
 */
export function buildStorefrontCatalog(input: {
  categories: CatalogCategory[]
  products: CatalogProduct[]
  variants: CatalogVariant[]
  extras: CatalogExtra[]
  optionGroups?: CatalogOptionGroup[]
  options?: CatalogOption[]
  recommendations?: CatalogRecommendation[]
}) {
  const variantesPorProducto = new Map<string, CatalogVariant[]>()
  for (const variante of input.variants) {
    const lista = variantesPorProducto.get(variante.product_id) || []
    lista.push(variante)
    variantesPorProducto.set(variante.product_id, lista)
  }

  // ── Los grupos de opciones, por sus dos destinos ────────────────────────
  const opcionesPorGrupo = new Map<string, CatalogOption[]>()
  for (const opcion of input.options || []) {
    const lista = opcionesPorGrupo.get(opcion.option_group_id) || []
    lista.push(opcion)
    opcionesPorGrupo.set(opcion.option_group_id, lista)
  }

  const gruposPorProducto = new Map<string, CatalogOptionGroup[]>()
  const gruposPorCategoria = new Map<string, CatalogOptionGroup[]>()
  for (const grupo of input.optionGroups || []) {
    if (grupo.product_id) {
      const lista = gruposPorProducto.get(grupo.product_id) || []
      lista.push(grupo)
      gruposPorProducto.set(grupo.product_id, lista)
    } else if (grupo.category_id) {
      const lista = gruposPorCategoria.get(grupo.category_id) || []
      lista.push(grupo)
      gruposPorCategoria.set(grupo.category_id, lista)
    }
  }

  const extrasPorProducto = new Map<string, CatalogExtra[]>()
  const extrasPorEtiqueta = new Map<string, CatalogExtra[]>()
  for (const extra of input.extras) {
    if (extra.product_id) {
      const lista = extrasPorProducto.get(extra.product_id) || []
      lista.push(extra)
      extrasPorProducto.set(extra.product_id, lista)
    } else if (extra.category_tag) {
      const clave = extra.category_tag.toLowerCase()
      const lista = extrasPorEtiqueta.get(clave) || []
      lista.push(extra)
      extrasPorEtiqueta.set(clave, lista)
    }
  }

  // Los combos: una opción puede SER un producto del catálogo. Se indexan para
  // que la opción herede su foto y su descripción cuando no tenga las suyas —
  // el dueño no debería subir dos veces la misma imagen de la Hawaiana.
  const productosPorId = new Map(input.products.map(producto => [producto.id, producto]))

  // ── «Agrega algo más» ───────────────────────────────────────────────────
  const recoPorProducto = new Map<string, CatalogRecommendation[]>()
  const recoPorCategoria = new Map<string, CatalogRecommendation[]>()
  const recoGlobales: CatalogRecommendation[] = []
  for (const reco of input.recommendations || []) {
    if (reco.source_product_id) {
      recoPorProducto.set(reco.source_product_id, [
        ...recoPorProducto.get(reco.source_product_id) || [], reco,
      ])
    } else if (reco.source_category_id) {
      recoPorCategoria.set(reco.source_category_id, [
        ...recoPorCategoria.get(reco.source_category_id) || [], reco,
      ])
    } else {
      recoGlobales.push(reco)
    }
  }

  const productos = input.products.map((producto) => {
    const variantes = (variantesPorProducto.get(producto.id) || [])
      .filter(variante => disponible(variante.stock))
      .map(variante => ({
        id: variante.id,
        name: variante.name,
        price: money(variante.price) ?? 0,
        priceSale: money(variante.price_sale),
      }))

    // Los extras del producto y los de sus etiquetas, sin repetir.
    const porEtiqueta = (producto.tags || [])
      .flatMap(tag => extrasPorEtiqueta.get(String(tag).toLowerCase()) || [])
    const extras = [...extrasPorProducto.get(producto.id) || [], ...porEtiqueta]
    const vistos = new Set<string>()

    const precioBase = money(producto.price)
    const precioOferta = money(producto.price_sale)
    // Con variantes, el precio del producto es solo una referencia: "desde X".
    const desde = variantes.length
      ? Math.min(...variantes.map(v => v.priceSale ?? v.price))
      : (precioOferta && precioOferta > 0 ? precioOferta : precioBase)

    // Los grupos del producto y los de su categoría. Los del producto van
    // primero: son los específicos, y el cliente los espera arriba.
    //
    // Una opción AGOTADA se cae de la lista, pero su grupo sigue existiendo: si
    // se quedara sin ninguna y fuese obligatorio, el producto no se podría
    // pedir, así que en ese caso se retira el grupo entero y el plato se sigue
    // vendiendo con lo que quede.
    const gruposDelProducto = [
      ...gruposPorProducto.get(producto.id) || [],
      ...(producto.category_id ? gruposPorCategoria.get(producto.category_id) || [] : []),
    ]
    const optionGroups = gruposDelProducto
      .map((grupo) => {
        const opciones = (opcionesPorGrupo.get(grupo.id) || [])
          .filter(opcion => disponible(opcion.stock))
          .map((opcion) => {
            // Si la opción ES un producto, hereda lo que no tenga propio.
            const referido = opcion.references_product_id
              ? productosPorId.get(opcion.references_product_id)
              : undefined
            return {
              id: opcion.id,
              name: opcion.name,
              description: opcion.description || referido?.description || null,
              imageUrl: opcion.image_url || referido?.image_url || null,
              price: money(opcion.price_adjustment) ?? 0,
              referencesProductId: opcion.references_product_id || null,
              defaultSelected: opcion.default_selected === true,
            }
          })
        const maximo = Math.max(1, grupo.max_selectable ?? 1)
        const minimo = Math.max(0, grupo.min_selectable ?? 0)
        return {
          id: grupo.id,
          name: grupo.name,
          description: grupo.description || null,
          selectionType: (grupo.selection_type || 'single') as 'single' | 'multiple' | 'quantity',
          // Cómo cobra el grupo. La app pinta con esto y la base cobra con lo
          // mismo, así que el cliente ve el número que va a pagar.
          pricingStrategy: (grupo.pricing_strategy || 'sum') as PricingStrategy,
          freeSelections: Math.max(0, grupo.free_selections ?? 0),
          required: grupo.required === true,
          // Un mínimo mayor que las opciones que quedan vivas sería imposible
          // de cumplir: se recorta a lo que de verdad se puede elegir.
          minSelectable: Math.min(minimo, opciones.length),
          maxSelectable: maximo,
          options: opciones,
        }
      })
      .filter(grupo => grupo.options.length > 0)

    // Lo que se ofrece con ESTE producto: lo suyo primero, después lo de su
    // categoría. Se resuelve aquí contra el catálogo para que la app no tenga
    // que cruzar nada, y se cae lo agotado: ofrecer lo que no hay es peor que
    // no ofrecer.
    const suyas = [
      ...recoPorProducto.get(producto.id) || [],
      ...(producto.category_id ? recoPorCategoria.get(producto.category_id) || [] : []),
    ]
    const vistosReco = new Set<string>()
    const recommendations = suyas
      .map((reco) => {
        const ofrecido = productosPorId.get(reco.recommended_product_id)
        if (!ofrecido || ofrecido.id === producto.id) return null
        if (!disponible(ofrecido.stock)) return null
        if (vistosReco.has(ofrecido.id)) return null
        vistosReco.add(ofrecido.id)
        return {
          section: reco.section || 'Agrega algo más',
          productId: ofrecido.id,
          name: ofrecido.name,
          description: ofrecido.description || null,
          imageUrl: ofrecido.image_url || null,
          price: money(ofrecido.price_sale) || money(ofrecido.price) || 0,
        }
      })
      .filter(Boolean)

    return {
      id: producto.id,
      name: producto.name,
      description: producto.description || null,
      imageUrl: producto.image_url || null,
      videoUrl: producto.video_url || null,
      categoryId: producto.category_id || null,
      tags: producto.tags || [],
      available: disponible(producto.stock),
      // La app no pregunta «¿es pizza?»: pregunta si este producto se arma
      // eligiendo otros. Un combo se pinta por pasos; el resto, de corrido.
      productType: (producto.product_type || 'simple') as ProductType,
      priceFrom: desde,
      hasVariants: variantes.length > 0,
      variants: variantes,
      optionGroups,
      recommendations,
      extras: extras
        .filter((extra) => {
          if (vistos.has(extra.id)) return false
          vistos.add(extra.id)
          return true
        })
        .map(extra => ({
          id: extra.id,
          group: extra.group_label || 'Extras',
          name: extra.name,
          description: extra.description || null,
          price: money(extra.price_delta) ?? 0,
          maxSelectable: extra.max_selectable ?? null,
        })),
    }
  })

  // Solo se muestran las categorías que tienen algo dentro: una categoría vacía
  // en la tienda parece un error del negocio.
  const conProductos = new Set(productos.map(producto => producto.categoryId).filter(Boolean))
  const categorias = input.categories
    .filter(categoria => conProductos.has(categoria.id))
    .map(categoria => ({
      id: categoria.id,
      name: categoria.name,
      description: categoria.description || null,
      imageUrl: categoria.image_url || null,
    }))

  return {
    categories: categorias,
    products: productos,
    // Los que no tienen categoría no se pierden: la app los agrupa aparte.
    uncategorized: productos.filter(producto => !producto.categoryId).length,
  }
}

/** Lo que la app necesita saber del negocio. Nunca credenciales. */
export function publicBusiness(business: StorefrontBusiness) {
  return {
    id: business.id,
    name: business.name || '',
    slug: business.slug || '',
    type: business.type || null,
    slogan: business.slogan || null,
    description: business.description || null,
    address: business.address || null,
    phone: business.whatsapp_number || business.phone || null,
    // Con esto la app elige el flujo. Sin esto tendría que adivinar por el
    // `type`, que es exactamente lo que el proyecto decidió no hacer.
    capabilities: storefrontCapabilities(business),
    // El color con el que se pinta la tienda. Nulo = el de la plataforma.
    brandColor: safeBrandColor(business.brand_color),
    // Solo https: acaba en un <img> de una app pública.
    logoUrl: typeof business.logo_url === 'string' && business.logo_url.startsWith('https://')
      ? business.logo_url
      : null,
    // Informativo: el importe oficial lo vuelve a calcular la base al pedir.
    deliveryFee: Math.max(0, Number(business.delivery_fee) || 0),
    // Los dos tiempos que ve el cliente en la portada. `prepTimeMinutes` es
    // además el que decide las franjas programables, así que sale del mismo
    // sitio que usa el servidor para calcularlas: uno solo puede mentir.
    prepTimeMinutes: Math.max(1, Number(business.prep_time_minutes) || 25),
    deliveryExtraMinutes: Math.max(0, Number(business.delivery_extra_minutes) || 0),
  }
}

// ── Cotizar un carrito sin crear el pedido ──────────────────────────────────
//
// El total EXACTO que se va a cobrar, con su desglose, resuelto contra el
// catálogo del negocio. Lo pide el checkout justo antes de confirmar: la app
// calcula mientras el cliente elige —para que la pantalla responda al
// instante— pero el número que se enseña antes de pagar sale de aquí.
//
// Aplica el MISMO `pricing.ts` cuya lógica replica `create_storefront_order`.
// Si la cotización y el cobro difirieran, el cliente vería un número al
// confirmar y otro en el pedido.
//
// ⚠️ No es la autoridad: sigue siéndolo la RPC (regla inviolable #8). Esto no
// escribe ni reserva nada, así que un desajuste aquí se nota antes de cobrar.

export interface QuoteItemInput {
  productId?: unknown
  variantId?: unknown
  quantity?: unknown
  options?: unknown
}

export interface QuoteLine {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
  options: { name: string; groupName: string; quantity: number; price: number }[]
}

export interface CartQuote {
  error?: string
  lines: QuoteLine[]
  subtotal: number
  shipping: number
  total: number
}

const vacia = (error: string): CartQuote => ({ error, lines: [], subtotal: 0, shipping: 0, total: 0 })

export function quoteCart(input: {
  items: QuoteItemInput[]
  products: CatalogProduct[]
  variants: CatalogVariant[]
  optionGroups: CatalogOptionGroup[]
  options: CatalogOption[]
  deliveryFee: number
  fulfillment: string
}): CartQuote {
  const porProducto = new Map(input.products.map(producto => [producto.id, producto]))
  const porVariante = new Map(input.variants.map(variante => [variante.id, variante]))
  const porGrupo = new Map(input.optionGroups.map(grupo => [grupo.id, grupo]))
  const porOpcion = new Map(input.options.map(opcion => [opcion.id, opcion]))

  const lines: QuoteLine[] = []
  let subtotal = 0

  for (const bruto of input.items) {
    const producto = porProducto.get(String(bruto.productId || ''))
    if (!producto) return vacia('Uno de los productos ya no está disponible')
    if (!disponible(producto.stock)) return vacia(`${producto.name} está agotado`)

    const cantidad = Math.trunc(Number(bruto.quantity) || 0)
    if (cantidad < 1 || cantidad > 99) return vacia('La cantidad no es válida')

    // El precio base sale de la variante si la hay; si no, del producto.
    let base = money(producto.price_sale) || money(producto.price) || 0
    const variante = bruto.variantId ? porVariante.get(String(bruto.variantId)) : null
    if (bruto.variantId && !variante) return vacia('Esa presentación ya no existe')
    if (variante) {
      if (variante.product_id !== producto.id) return vacia('Esa presentación no es de este producto')
      base = money(variante.price_sale) || money(variante.price) || 0
    }

    // Lo elegido, agrupado: cada grupo cobra con SU estrategia y para eso hay
    // que verlo entero, no opción por opción.
    const elegidasPorGrupo = new Map<string, { price: number; quantity: number }[]>()
    const detalle: QuoteLine['options'] = []

    for (const cruda of Array.isArray(bruto.options) ? bruto.options.slice(0, 30) : []) {
      const dato = (cruda || {}) as Record<string, unknown>
      const opcion = porOpcion.get(String(dato.optionId || dato.option_id || ''))
      if (!opcion) return vacia('Una de las opciones ya no está disponible')
      const grupo = porGrupo.get(opcion.option_group_id)
      if (!grupo) return vacia('Una de las opciones ya no está disponible')
      // La opción tiene que ser de un grupo de ESTE producto: suyo o de su
      // categoría. Es la misma frontera que aplica la RPC.
      const aplica = grupo.product_id === producto.id
        || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id)
      if (!aplica) return vacia(`Una opción no corresponde a ${producto.name}`)
      if (!disponible(opcion.stock)) return vacia(`${opcion.name} ya no está disponible`)

      const porciones = Math.min(100, Math.max(1, Math.trunc(Number(dato.quantity) || 1)))
      const precio = money(opcion.price_adjustment) ?? 0
      elegidasPorGrupo.set(grupo.id, [
        ...elegidasPorGrupo.get(grupo.id) || [],
        { price: precio, quantity: porciones },
      ])
      detalle.push({
        name: opcion.name,
        groupName: grupo.name,
        quantity: porciones,
        price: precio,
      })
    }

    // Los obligatorios se exigen aquí también: cotizar algo que la RPC va a
    // rechazar dejaría al cliente pagando una pantalla que no existe.
    for (const grupo of input.optionGroups) {
      const aplica = grupo.product_id === producto.id
        || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id)
      if (!aplica) continue
      const elegidas = elegidasPorGrupo.get(grupo.id) || []
      const cuenta = grupo.selection_type === 'quantity'
        ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
        : elegidas.length
      const minimo = Math.max(grupo.required ? 1 : 0, grupo.min_selectable ?? 0)
      if (cuenta < minimo) return vacia(`Falta elegir ${grupo.name} en ${producto.name}`)
    }

    const unitPrice = calculateProductPrice({
      basePrice: base,
      groups: [...elegidasPorGrupo.entries()].map(([groupId, selections]) => ({
        strategy: (porGrupo.get(groupId)?.pricing_strategy || 'sum') as PricingStrategy,
        freeSelections: porGrupo.get(groupId)?.free_selections ?? 0,
        selections,
      })),
    })
    if (!(unitPrice > 0)) return vacia(`${producto.name} quedaría sin precio válido`)

    const lineTotal = Math.round(unitPrice * cantidad * 100) / 100
    subtotal += lineTotal
    lines.push({
      productId: producto.id,
      name: producto.name,
      quantity: cantidad,
      unitPrice,
      lineTotal,
      options: detalle,
    })
  }

  // Quien retira en el local no paga envío, igual que en la RPC.
  const shipping = input.fulfillment === 'delivery'
    ? Math.max(0, Math.round(input.deliveryFee * 100) / 100)
    : 0
  subtotal = Math.round(subtotal * 100) / 100

  return { lines, subtotal, shipping, total: Math.round((subtotal + shipping) * 100) / 100 }
}

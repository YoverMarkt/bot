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
import { calculatePlatformMarkup, type MarkupRule } from './platform-pricing'
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
  delivery_fee?: number | string | null
  brand_color?: string | null
  logo_url?: string | null
  cover_url?: string | null
  /** Minutos hasta tenerlo listo. Manda también en las franjas programables. */
  prep_time_minutes?: number | string | null
  /** Minutos que suma llevarlo a domicilio. Solo se muestra. */
  delivery_extra_minutes?: number | string | null
  /** 0 = sin mínimo. Lo pone el dueño según su producto más barato. */
  min_order_amount?: number | string | null
}

// El color lo escribe el dueño en su panel y acaba pintando la mini app, así
// que se vuelve a comprobar aquí: solo un hex de 6 dígitos sale del servidor.
// Cualquier otra cosa se descarta y la tienda usa su color por defecto.
/** Una URL de imagen que puede salir a una app pública, o nada. */
const httpsOnly = (valor?: string | null): string | null =>
  typeof valor === 'string' && valor.startsWith('https://') ? valor : null

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
 * Qué sabe hacer esta tienda.
 *
 * Manda la bandera del negocio, nunca su `type`: el tipo solo recomienda
 * valores al crearlo y el dueño puede cambiarlos a mano.
 */
export interface StorefrontCapabilities {
  /** Catálogo con carrito: comida, bebidas, retail. */
  orders: boolean
}

export function storefrontCapabilities(
  business: StorefrontBusiness | null,
): StorefrontCapabilities {
  return {
    orders: business?.takes_orders === true,
  }
}

/**
 * La regla de margen tal como llega de `business_pricing_view`, normalizada a
 * lo que espera `platform-pricing.ts`. Devuelve `null` si no hay regla.
 */
export const reglaDeMargen = (crudo: unknown): MarkupRule | null => {
  if (!crudo || typeof crudo !== 'object') return null
  const r = crudo as Record<string, unknown>
  const estrategia = String(r.strategy || '')
  if (!estrategia) return null
  return {
    id: r.rule_id ? String(r.rule_id) : undefined,
    strategy: estrategia as MarkupRule['strategy'],
    percentage: r.percentage == null ? null : Number(r.percentage),
    fixedAmount: r.fixed_amount == null ? null : Number(r.fixed_amount),
    tiers: Array.isArray(r.tiers)
      ? (r.tiers as { up_to?: number | null; amount?: number }[]).map(t => ({
        upTo: t.up_to ?? null, amount: Number(t.amount) || 0,
      }))
      : null,
    minAmount: r.min_amount == null ? null : Number(r.min_amount),
    maxAmount: r.max_amount == null ? null : Number(r.max_amount),
    markupMode: (r.mode === 'on_top' ? 'on_top' : 'absorbed'),
    version: r.version == null ? undefined : Number(r.version),
  }
}

/**
 * El precio que VE el cliente: el del comercio más el margen de la plataforma.
 *
 * ⚠️ Solo se pinta con `percentage` y sin topes de pedido. `fixed` y `tiered`
 * —y cualquier regla con `min_amount`/`max_amount`— son cantidades del PEDIDO
 * ENTERO: repartirlas por producto daría un precio unitario que no existe, y
 * al sumar el carrito no cuadraría con el cobro. En esos casos el precio se
 * enseña tal cual y el margen aparece en la cotización, que es donde el
 * importe del pedido ya está resuelto.
 *
 * ⚠️ Y solo con `on_top`. Con `absorbed` el margen sale del precio del
 * comercio, así que el cliente ya está viendo lo que paga.
 */
export const precioDeVitrina = (
  precio: number | null,
  regla: MarkupRule | null,
): number | null => {
  if (precio == null) return precio
  if (!regla || regla.markupMode !== 'on_top') return precio
  if (regla.strategy !== 'percentage') return precio
  if (regla.minAmount != null || regla.maxAmount != null) return precio
  const pct = Number(regla.percentage) || 0
  if (pct <= 0) return precio
  return Math.round((precio * (1 + pct / 100) + Number.EPSILON) * 100) / 100
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
  // Una tienda que no vende no tiene nada que mostrar: se enciende por error y
  // el cliente abre una app vacía. Mejor no existir que existir rota.
  const capacidades = storefrontCapabilities(business)
  if (!capacidades.orders) return 'no_disponible'
  return input.outsideHours ? 'cerrada' : 'abierta'
}

/** Solo se puede pedir con la tienda abierta. */
export const canOrder = (status: StorefrontStatus): boolean => status === 'abierta'

/**
 * Las formas con las que un nombre de grupo puede estar escrito.
 *
 * «Sabor», «sabores» y «SABOR » son el mismo grupo escrito por dos manos
 * distintas: la pestaña vieja del panel y la nueva. Sin esto el duplicado se
 * cuela por una tilde o por un plural.
 *
 * ⚠️ NO se reduce a una única forma canónica, y no es por comodidad: en español
 * no se puede sin diccionario. «sabores» sale de «sabor» (+es) y «bordes» de
 * «borde» (+s) — las dos acaban en consonante + «es», así que cualquier regla
 * fija acierta una y rompe la otra. Se probó: quitar «es» daba «bord», y quitar
 * solo la «s» daba «sabore».
 *
 * Se generan las formas posibles y se pregunta si dos nombres comparten alguna.
 * Es más barato que acertar el singular y no se equivoca en ninguno de los dos.
 */
const formasDelNombre = (valor: string): Set<string> => {
  const base = valor
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  return new Set([base, base.replace(/s$/, ''), base.replace(/es$/, '')])
}

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
  /**
   * La regla de margen vigente. Con `on_top` los precios que salen de aquí ya
   * son los que paga el cliente — que es la condición que `pricing_rules`
   * exigía antes de permitir ese modo.
   */
  pricing?: MarkupRule | null
}) {
  const regla = input.pricing ?? null
  /** Atajo: el precio de vitrina de esta tienda. */
  const vit = (precio: number | null): number | null => precioDeVitrina(precio, regla)
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
        price: vit(money(variante.price)) ?? 0,
        priceSale: vit(money(variante.price_sale)),
      }))

    // Los extras del producto y los de sus etiquetas, sin repetir.
    const porEtiqueta = (producto.tags || [])
      .flatMap(tag => extrasPorEtiqueta.get(String(tag).toLowerCase()) || [])
    const extras = [...extrasPorProducto.get(producto.id) || [], ...porEtiqueta]
    const vistos = new Set<string>()

    const precioBase = vit(money(producto.price))
    const precioOferta = vit(money(producto.price_sale))
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
              price: vit(money(opcion.price_adjustment)) ?? 0,
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

    // Con qué nombres ya responde el motor nuevo para ESTE producto. Sirve para
    // no repetir abajo un grupo que ya salió arriba.
    const formasDeGrupo = new Set(
      optionGroups.flatMap(grupo => [...formasDelNombre(grupo.name)]),
    )

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
          price: vit(money(ofrecido.price_sale) || money(ofrecido.price)) || 0,
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
      // ⚠️ Un grupo NO puede salir dos veces.
      //
      // Los extras vienen de `menu_modifiers`, la tabla heredada que aún
      // conserva catálogos antiguos; los grupos de opciones son el motor
      // nuevo. Al construirlo se COPIARON los modificadores existentes sin
      // retirar los originales, así que un negocio con las dos cosas mandaba las mismas
      // opciones por los dos campos y la ficha las pintaba dos veces: los 19
      // sabores de Monster Pizza salían repetidos, una vez con radio y otra
      // con casillas.
      //
      // Gana el motor nuevo, que es el que sabe de obligatorios, mínimos y
      // estrategias de precio. Se compara por NOMBRE de grupo normalizado
      // porque es lo único que comparten las dos tablas. Un negocio que solo
      // tenga la tabla vieja no pierde nada: sus extras no chocan con ningún
      // grupo y siguen saliendo igual.
      extras: extras
        .filter((extra) => {
          if (vistos.has(extra.id)) return false
          vistos.add(extra.id)
          return ![...formasDelNombre(extra.group_label || 'Extras')]
            .some(forma => formasDeGrupo.has(forma))
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

/**
 * Lo que la app necesita saber del negocio. Nunca credenciales.
 *
 * `platformPhone` es el número del marketplace, y llega por parámetro en vez
 * de leerse aquí porque esta función es SÍNCRONA y pura: se prueba sin base y
 * sin ajustes. Quien la llama ya está en una ruta `async`.
 */
export function publicBusiness(
  business: StorefrontBusiness,
  pricing?: MarkupRule | null,
  platformPhone?: string | null,
) {
  return {
    id: business.id,
    name: business.name || '',
    slug: business.slug || '',
    type: business.type || null,
    slogan: business.slogan || null,
    description: business.description || null,
    address: business.address || null,
    /**
     * El WhatsApp al que el cliente escribe para ESTE local.
     *
     * ⚠️ El orden importa y el último eslabón es nuevo (2026-08-27). Desde que
     * «todos los locales viven en el marketplace» (2026-08-23), el panel dejó
     * de pedir el número propio y un disparador impide que un local se quede
     * el de la plataforma — así que las dos primeras columnas son **null para
     * todos los negocios, siempre**. El resultado: la app recibía
     * `phone: null` y CUATRO salidas desaparecían calladas:
     *
     *   · «Volver a WhatsApp» del pedido recibido, que es por donde se manda
     *     el comprobante — la única vía desde el 2026-08-12.
     *   · «Llamar al local» de un pedido cancelado.
     *   · «Pedir mi enlace por WhatsApp» de `Gate`, que deja sin salida a
     *     quien recibió un enlace reenviado y nunca habló con el marketplace.
     *   · «No es mi enlace, quiero el mío» de `Confirmar`.
     *
     * El resto del camino ya estaba construido: hay un buzón entero
     * (`payment-proof-inbox`) dedicado a cazar el comprobante que llega al
     * número del marketplace. La puerta existía; la app no sabía decir dónde
     * estaba. Es la misma clase de fallo que este proyecto lleva cinco veces
     * pagando — código correcto al que la configuración real no llega.
     *
     * ⚠️ Es el número de la PLATAFORMA, no el del dueño: por ahí escriben los
     * clientes de todos los locales. Que aquí salga el mismo para varios
     * negocios es correcto, y el pedido no se desambigua por el número — sale
     * del PEDIDO. Ver `pedidosEsperandoComprobante`.
     */
    phone: business.whatsapp_number || business.phone || platformPhone || null,
    /**
     * Si ese WhatsApp es el del MARKETPLACE y no el del local.
     *
     * La app necesita saberlo porque las instrucciones son distintas, y darle
     * la equivocada deja a la persona escribiendo a donde no debe:
     *
     *   · Número de Umbani → «escríbele a Umbani y elige tu local». El enlace
     *     nace de ESA elección: el bot enseña las categorías, la persona elige,
     *     y `mandarElEnlace` emite su sesión.
     *   · Número propio del local → «escríbele al negocio», que es el flujo de
     *     siempre para quien tiene su propio canal.
     *
     * ⚠️ Se manda un booleano y no el número comparado en la app: el cliente
     * no tiene por qué recibir el número de la plataforma para compararlo, y
     * comparar teléfonos en dos sitios acaba en dos normalizaciones distintas.
     */
    phoneIsPlatform: Boolean(
      !business.whatsapp_number && !business.phone && platformPhone,
    ),
    // Con esto la app elige el flujo. Sin esto tendría que adivinar por el
    // `type`, que es exactamente lo que el proyecto decidió no hacer.
    capabilities: storefrontCapabilities(business),
    // El color con el que se pinta la tienda. Nulo = el de la plataforma.
    brandColor: safeBrandColor(business.brand_color),
    // Solo https: acaban en un <img> de una app pública. Se comprueba aquí
    // además del CHECK de la base porque este es el último punto antes del
    // navegador, y una fila vieja podría haber entrado antes del constraint.
    logoUrl: httpsOnly(business.logo_url),
    coverUrl: httpsOnly(business.cover_url),
    // Informativo: el importe oficial lo vuelve a calcular la base al pedir.
    deliveryFee: Math.max(0, Number(business.delivery_fee) || 0),
    // Los dos tiempos que ve el cliente en la portada. `prepTimeMinutes` es
    // además el que decide las franjas programables, así que sale del mismo
    // sitio que usa el servidor para calcularlas: uno solo puede mentir.
    prepTimeMinutes: Math.max(1, Number(business.prep_time_minutes) || 25),
    deliveryExtraMinutes: Math.max(0, Number(business.delivery_extra_minutes) || 0),
    // ⚠️ El mínimo viaja al CATÁLOGO, no solo al confirmar. La base lo exige
    // igualmente en `orders_enforce_min_amount` —eso es lo que manda—, pero si
    // el cliente solo se enterara ahí, habría armado el carrito entero para
    // que se lo rechacen al final. Es el mismo error que ya se corrigió con el
    // bloqueo y el enlace: decirlo cuando aún se puede hacer algo.
    //
    // `?? 0` y no `|| 0`: cero es «sin mínimo», un valor que el dueño elige.
    //
    // ⚠️ VIAJA EN LA MONEDA DEL CLIENTE, con el mismo margen que los precios.
    // El dueño fija su mínimo sobre SU precio y la base lo exige así
    // (`orders_enforce_min_amount` mira `orders.subtotal`), pero la app compara
    // contra un carrito ya con margen: sin inflarlo igual, un carrito de $4,80
    // del comercio —$5,28 para el cliente— parecería llegar a un mínimo de $5
    // y la base lo rechazaría al confirmar. Inflar los dos lados mantiene la
    // comparación equivalente y el rechazo imposible.
    minOrderAmount: precioDeVitrina(
      Math.max(0, Number(business.min_order_amount ?? 0) || 0),
      pricing ?? null,
    ) ?? 0,
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
  /** Lo que recibe el comercio por sus productos: su precio, entero. */
  merchantSubtotal: number
  /** Lo que gana la plataforma sobre este pedido. */
  platformMarkup: number
  /** Lo que paga el cliente por los productos: con `on_top` incluye el margen. */
  customerSubtotal: number
  /** El porcentaje aplicado, para poder explicarlo después. */
  markupPercentage: number | null
  shipping: number
  total: number
}

const vacia = (error: string): CartQuote => ({
  error, lines: [], subtotal: 0, shipping: 0, total: 0,
  merchantSubtotal: 0, platformMarkup: 0, customerSubtotal: 0, markupPercentage: null,
})

export function quoteCart(input: {
  items: QuoteItemInput[]
  products: CatalogProduct[]
  variants: CatalogVariant[]
  optionGroups: CatalogOptionGroup[]
  options: CatalogOption[]
  deliveryFee: number
  fulfillment: string
  /** La regla de margen vigente, la misma que sella el pedido. */
  pricing?: MarkupRule | null
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

    // Los topes del grupo se exigen aquí también: cotizar algo que la RPC va a
    // rechazar dejaría al cliente pagando una pantalla que no existe.
    //
    // ⚠️ Los DOS, mínimo y máximo, y con las mismas cuentas que la RPC. Hasta
    // el 2026-08-09 solo se comprobaba el mínimo: una pizza con tres sabores
    // teniendo el tope en dos se cotizaba sin queja, con su precio y todo, y
    // reventaba al confirmar con «Demasiadas opciones». La app bloquea al
    // llegar al máximo, pero la app no es la defensa — este endpoint se llama
    // igual sin pasar por ella.
    for (const grupo of input.optionGroups) {
      const aplica = grupo.product_id === producto.id
        || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id)
      if (!aplica) continue
      const elegidas = elegidasPorGrupo.get(grupo.id) || []
      // En los contadores cuentan las PORCIONES; en el resto, cuántas se
      // marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      const cuenta = grupo.selection_type === 'quantity'
        ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
        : elegidas.length
      const minimo = Math.max(grupo.required ? 1 : 0, grupo.min_selectable ?? 0)
      if (cuenta < minimo) return vacia(`Falta elegir ${grupo.name} en ${producto.name}`)
      // Mismo texto que la RPC a propósito: el cliente lee lo mismo venga el
      // rechazo de donde venga.
      const maximo = Math.max(1, grupo.max_selectable ?? 1)
      if (cuenta > maximo) return vacia(`Demasiadas opciones en ${grupo.name}`)
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

  // ⚠️ UN SOLO REDONDEO, sobre el subtotal completo y nunca por línea: diez
  // líneas redondeadas por separado se desvían del porcentaje pactado. Es el
  // mismo cálculo que sella `orders_stamp_pricing`, así que la cotización y el
  // cobro no pueden divergir.
  //
  // ⚠️ `subtotal` es y sigue siendo lo del COMERCIO. Lo que sube con `on_top`
  // es lo que paga el cliente.
  const margen = calculatePlatformMarkup(subtotal, input.pricing ?? null)
  const total = Math.round((margen.customerSubtotal + shipping) * 100) / 100

  return {
    lines,
    subtotal,
    shipping,
    total,
    merchantSubtotal: margen.merchantSubtotal,
    platformMarkup: margen.markup,
    customerSubtotal: margen.customerSubtotal,
    markupPercentage: input.pricing?.strategy === 'percentage'
      ? (Number(input.pricing.percentage) || 0)
      : null,
  }
}

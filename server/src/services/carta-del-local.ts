// ═══════════════════════════════════════════════════════════════════════════
// LA CARTA DEL LOCAL, LEÍDA DE SU FOTO
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño (2026-09-24): subir el menú de los locales que venda sin
// teclearlo producto a producto. En el SUPERADMIN, al dar de alta el local:
//
//   foto(s) de la carta → la IA PROPONE → una persona REVISA → el alta la carga
//
// Aquí viven las dos mitades del servidor:
//   · `leerCarta`   — mira las fotos y devuelve una propuesta. NO guarda nada.
//   · `validarCarta` — revisa lo que la persona aprobó antes de que el alta lo
//                      cargue con `apply_business_menu`.
//
// ⚠️ LA IA LEE LO IMPRESO; NO INVENTA LAS REGLAS. Entran categorías, productos,
// precios, tamaños con su precio y las listas impresas para elegir (sopas,
// segundos, bebidas). NO entran qué parte del plato se vende suelta, qué va
// gratis, mínimos y máximos: la carta no los dice, y si la IA se los inventa
// cobra mal sin que nadie lo note. Esos los pone el dueño en el panel.
//
// ⚠️ NADA SE GUARDA SIN REVISIÓN HUMANA. Es un catálogo de PRECIOS: un $3.50
// leído donde dice $8.50 es vender a pérdida hasta que alguien lo note.
//
// ⚠️ `gpt-4o`, NO `gpt-4o-mini` (el de los comprobantes). Medido el 2026-09-24
// con la carta real de La Abuelita: gpt-4o acertó 9 de 9 lecturas —también con
// la foto torcida, con reflejo y con poca luz—; gpt-4o-mini leyó bien los
// nombres pero convirtió «Sopas» en un producto de $3, que es justo el error
// peligroso. Y ni siquiera era más barato: gasta 37.000 tokens por imagen
// contra 1.400.

import OpenAI from 'openai'
import { normalizarMonto } from '../lib/montos'
import type { BusinessMenu, MenuCategory, MenuProduct, TemplateGroup } from '../db/types'

// ── La propuesta (lo que la IA leyó, ya saneado) ────────────────────────────

export interface ListaPropuesta {
  titulo: string
  opciones: string[]
}

export interface VariantePropuesta {
  nombre: string
  /** Nulo cuando no se leía con claridad: se rellena en la revisión. */
  precio: number | null
}

export interface ProductoPropuesto {
  nombre: string
  precio: number | null
  descripcion: string | null
  variantes: VariantePropuesta[]
  listas: ListaPropuesta[]
}

export interface CategoriaPropuesta {
  nombre: string
  productos: ProductoPropuesto[]
}

export interface CartaPropuesta {
  categorias: CategoriaPropuesta[]
  /**
   * Precios impresos que NO son el del producto ni un tamaño: «Para llevar
   * $3,50». Se enseñan en la revisión como aviso y no se usan — el dueño lo
   * pidió así con la carta de La Abuelita.
   */
  otrosPrecios: { producto: string; texto: string }[]
}

export type ResultadoLectura =
  | { ok: true; propuesta: CartaPropuesta }
  | { ok: false; motivo: 'sin_credencial' | 'sin_productos' | 'respuesta_vacia' | 'json_invalido' | 'fallo_del_modelo' }

// ── Los topes de la base, para no llegar a ella con algo que rechace ────────

export const LIMITES = {
  categoria: 60,
  producto: 120,
  descripcion: 300,
  variante: 60,
  lista: 120,
  opcion: 120,
  precioMaximo: 100_000,
  categorias: 50,
  productos: 400,
  variantesPorProducto: 20,
  listasPorProducto: 10,
  opcionesPorLista: 60,
  fotos: 4,
} as const

const texto = (valor: unknown, maximo: number): string => (
  typeof valor === 'string' ? valor.replace(/\s+/g, ' ').trim().slice(0, maximo) : ''
)

const precio = (valor: unknown): number | null => {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor > 0 && valor <= LIMITES.precioMaximo
      ? Math.round(valor * 100) / 100
      : null
  }
  const normalizado = normalizarMonto(valor)
  if (normalizado === null) return null
  return precio(Number(normalizado))
}

const lista = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : [])

/**
 * Deja lo que devolvió el modelo con la forma exacta de la propuesta. Descarta
 * lo que no tiene nombre y pone `null` en los precios que no son un número
 * razonable: un precio dudoso se rellena en la revisión, nunca se adivina.
 */
export function sanearPropuesta(crudo: unknown): CartaPropuesta {
  const raiz = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>

  const categorias = lista(raiz.categorias).slice(0, LIMITES.categorias).flatMap((c) => {
    const categoria = (c || {}) as Record<string, unknown>
    const productos = lista(categoria.productos).flatMap((p) => {
      const producto = (p || {}) as Record<string, unknown>
      const nombre = texto(producto.nombre, LIMITES.producto)
      if (!nombre) return []
      return [{
        nombre,
        precio: precio(producto.precio),
        descripcion: texto(producto.descripcion, LIMITES.descripcion) || null,
        variantes: lista(producto.variantes).slice(0, LIMITES.variantesPorProducto).flatMap((v) => {
          const variante = (v || {}) as Record<string, unknown>
          const nombreVariante = texto(variante.nombre, LIMITES.variante)
          return nombreVariante ? [{ nombre: nombreVariante, precio: precio(variante.precio) }] : []
        }),
        listas: lista(producto.listas).slice(0, LIMITES.listasPorProducto).flatMap((l) => {
          const impresa = (l || {}) as Record<string, unknown>
          const opciones = lista(impresa.opciones)
            .map(o => texto(o, LIMITES.opcion))
            .filter(Boolean)
            .slice(0, LIMITES.opcionesPorLista)
          return opciones.length
            ? [{ titulo: texto(impresa.titulo, LIMITES.lista) || 'Opciones', opciones }]
            : []
        }),
      }]
    })
    return productos.length
      ? [{ nombre: texto(categoria.nombre, LIMITES.categoria) || 'Carta', productos }]
      : []
  })

  const otrosPrecios = lista(raiz.otros_precios).flatMap((o) => {
    const otro = (o || {}) as Record<string, unknown>
    const detalle = texto(otro.texto, 120)
    return detalle ? [{ producto: texto(otro.producto, LIMITES.producto), texto: detalle }] : []
  })

  return { categorias, otrosPrecios }
}

// ── Leer ────────────────────────────────────────────────────────────────────

const INSTRUCCIONES = `Pasas a datos la carta impresa de un restaurante o tienda.
Lee SOLO lo que está impreso. No inventes nada: ni productos, ni precios, ni reglas.

Devuelve JSON con esta forma exacta:
{
  "categorias": [
    { "nombre": string,
      "productos": [
        { "nombre": string,
          "precio": number | null,
          "descripcion": string | null,
          "variantes": [ { "nombre": string, "precio": number | null } ],
          "listas": [ { "titulo": string, "opciones": [string] } ]
        }
      ]
    }
  ],
  "otros_precios": [ { "producto": string, "texto": string } ],
  "ignorado": [string]
}

Reglas:
- "variantes": tamaños o versiones con SU PROPIO precio impreso (ej. «personal $5.99 · mediana $11.99»).
- "listas": opciones impresas para ELEGIR dentro de un producto (ej. un almuerzo con sus sopas, segundos y bebidas). Copia los nombres tal cual.
- Si un producto tiene más de un precio que NO es una variante (por ejemplo «para llevar»), usa el principal en "precio" y copia el otro en "otros_precios".
- Si hay varias fotos, son páginas de la MISMA carta: únelas sin repetir productos.
- Teléfonos, direcciones, redes sociales, eslóganes y títulos decorativos van en "ignorado".
- Un precio que no se lee con claridad va como null. Nunca lo adivines.`

export interface FotoDeCarta {
  buffer: Buffer
  mimetype?: string | null
}

export interface LectorDependencias {
  settings: { get(key: 'openai_api_key'): Promise<string | null> }
  crearCliente?: (apiKey: string) => Pick<OpenAI, 'chat'>
  logger?: { log(mensaje: string): void }
  timeoutMs?: number
}

export const crearLectorDeCartas = (dependencias: LectorDependencias) =>
  /** Lee las fotos. **Nunca lanza**: devuelve `ok: false` con el motivo. */
  async function leerCarta(fotos: FotoDeCarta[]): Promise<ResultadoLectura> {
    try {
      const apiKey = await dependencias.settings.get('openai_api_key')
      if (!apiKey) return { ok: false, motivo: 'sin_credencial' }

      const crearCliente = dependencias.crearCliente
        || ((clave: string) => new OpenAI({ apiKey: clave }))
      const respuesta = await crearCliente(apiKey).chat.completions.create(
        {
          model: 'gpt-4o',
          // Una carta de 300 productos cabe de sobra; más es que algo se desbocó.
          max_tokens: 12_000,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: INSTRUCCIONES },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Esta es la carta. Devuelve el JSON.' },
                ...fotos.map(foto => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${foto.mimetype || 'image/jpeg'};base64,${foto.buffer.toString('base64')}`,
                    detail: 'high' as const,
                  },
                })),
              ],
            },
          ],
        },
        // Quien espera es el superadmin mirando la pantalla, no un cliente:
        // más margen que en los comprobantes, pero con techo.
        { timeout: dependencias.timeoutMs ?? 90_000 },
      )

      const contenido = respuesta.choices?.[0]?.message?.content
      if (!contenido) return { ok: false, motivo: 'respuesta_vacia' }

      let crudo: unknown
      try {
        crudo = JSON.parse(contenido)
      } catch {
        return { ok: false, motivo: 'json_invalido' }
      }

      const propuesta = sanearPropuesta(crudo)
      if (!propuesta.categorias.length) return { ok: false, motivo: 'sin_productos' }
      return { ok: true, propuesta }
    } catch (error) {
      dependencias.logger?.log(
        `⚠️  [carta] no se pudo leer: ${error instanceof Error ? error.message : 'desconocido'}`,
      )
      return { ok: false, motivo: 'fallo_del_modelo' }
    }
  }

// ── Validar lo revisado ─────────────────────────────────────────────────────

export type ResultadoValidacion =
  | { ok: true; menu: BusinessMenu; productos: number }
  | { ok: false; errores: string[] }

const clave = (nombre: string) => nombre.toLocaleLowerCase('es')

/**
 * Revisa la carta que la persona aprobó y la deja con la forma que carga
 * `apply_business_menu`.
 *
 * Aquí es ESTRICTO, al revés que `sanearPropuesta`: ya no se trata de proponer
 * sino de guardar precios que un cliente va a pagar. Un precio que falta o un
 * nombre repetido no se arreglan en silencio: se devuelven para corregirlos.
 */
export function validarCarta(revisada: unknown): ResultadoValidacion {
  const errores: string[] = []
  const raiz = (revisada && typeof revisada === 'object' ? revisada : {}) as Record<string, unknown>
  const categoriasCrudas = lista(raiz.categorias)
  if (categoriasCrudas.length > LIMITES.categorias) {
    errores.push(`La carta tiene más de ${LIMITES.categorias} categorías`)
  }

  const nombresDeCategoria = new Set<string>()
  let totalProductos = 0
  const categorias: MenuCategory[] = []

  categoriasCrudas.slice(0, LIMITES.categorias).forEach((c, indiceCategoria) => {
    const categoria = (c || {}) as Record<string, unknown>
    const nombreCategoria = texto(categoria.nombre, LIMITES.categoria + 1)
    const productosCrudos = lista(categoria.productos)
    // Una categoría que se quedó sin productos en la revisión no aporta nada.
    if (!productosCrudos.length) return

    const donde = nombreCategoria || `Categoría ${indiceCategoria + 1}`
    if (!nombreCategoria) errores.push(`${donde}: le falta el nombre`)
    else if (nombreCategoria.length > LIMITES.categoria) {
      errores.push(`${donde}: el nombre pasa de ${LIMITES.categoria} letras`)
    }
    if (nombreCategoria && nombresDeCategoria.has(clave(nombreCategoria))) {
      errores.push(`${donde}: la categoría está repetida`)
    }
    nombresDeCategoria.add(clave(nombreCategoria))

    const nombresDeProducto = new Set<string>()
    const productos: MenuProduct[] = []
    productosCrudos.forEach((p, indiceProducto) => {
      const producto = (p || {}) as Record<string, unknown>
      const nombre = texto(producto.nombre, LIMITES.producto + 1)
      const aqui = `${donde} › ${nombre || `producto ${indiceProducto + 1}`}`
      if (!nombre) errores.push(`${aqui}: le falta el nombre`)
      else if (nombre.length > LIMITES.producto) {
        errores.push(`${aqui}: el nombre pasa de ${LIMITES.producto} letras`)
      }
      if (nombre && nombresDeProducto.has(clave(nombre))) {
        errores.push(`${aqui}: está repetido en la categoría`)
      }
      nombresDeProducto.add(clave(nombre))

      const variantes = lista(producto.variantes).map((v, indiceVariante) => {
        const variante = (v || {}) as Record<string, unknown>
        const nombreVariante = texto(variante.nombre, LIMITES.variante + 1)
        const precioVariante = precio(variante.precio)
        if (!nombreVariante) errores.push(`${aqui}: el tamaño ${indiceVariante + 1} no tiene nombre`)
        else if (nombreVariante.length > LIMITES.variante) {
          errores.push(`${aqui} › ${nombreVariante}: el nombre pasa de ${LIMITES.variante} letras`)
        }
        if (precioVariante === null) {
          errores.push(`${aqui} › ${nombreVariante || 'tamaño'}: falta el precio`)
        }
        return { nombre: nombreVariante, precio: precioVariante ?? 0, orden: indiceVariante }
      })
      if (variantes.length > LIMITES.variantesPorProducto) {
        errores.push(`${aqui}: tiene más de ${LIMITES.variantesPorProducto} tamaños`)
      }
      if (new Set(variantes.map(v => clave(v.nombre))).size !== variantes.length) {
        errores.push(`${aqui}: tiene dos tamaños con el mismo nombre`)
      }

      // Con tamaños, el precio del producto es el del más barato: es el «desde»
      // que ve el cliente, y cada tamaño cobra el suyo.
      const precioProducto = variantes.length
        ? Math.min(...variantes.map(v => v.precio))
        : precio(producto.precio)
      if (!variantes.length && precioProducto === null) errores.push(`${aqui}: falta el precio`)

      const listas = lista(producto.listas)
      if (listas.length > LIMITES.listasPorProducto) {
        errores.push(`${aqui}: tiene más de ${LIMITES.listasPorProducto} listas`)
      }
      const titulos = new Set<string>()
      const grupos: TemplateGroup[] = listas.map((l, indiceLista) => {
        const impresa = (l || {}) as Record<string, unknown>
        const titulo = texto(impresa.titulo, LIMITES.lista)
        if (!titulo) errores.push(`${aqui}: la lista ${indiceLista + 1} no tiene título`)
        if (titulo && titulos.has(clave(titulo))) errores.push(`${aqui}: la lista «${titulo}» está repetida`)
        titulos.add(clave(titulo))
        const opciones = lista(impresa.opciones).map(o => texto(o, LIMITES.opcion)).filter(Boolean)
        if (!opciones.length) errores.push(`${aqui} › ${titulo || 'lista'}: no tiene opciones`)
        if (opciones.length > LIMITES.opcionesPorLista) {
          errores.push(`${aqui} › ${titulo}: tiene más de ${LIMITES.opcionesPorLista} opciones`)
        }
        if (new Set(opciones.map(clave)).size !== opciones.length) {
          errores.push(`${aqui} › ${titulo}: repite una opción`)
        }
        // Lo impreso es la lista; «elige una» es lo único que se asume, y la
        // persona decide en la revisión si es obligatoria. El resto de reglas
        // (partes del plato, gratis, mínimos) las pone el dueño en su panel.
        const obligatoria = impresa.obligatoria !== false
        return {
          nombre: titulo,
          tipo: 'single',
          obligatorio: obligatoria,
          min: obligatoria ? 1 : 0,
          max: 1,
          orden: indiceLista,
          opciones: opciones.map((nombreOpcion, orden) => ({ nombre: nombreOpcion, orden })),
        }
      })

      productos.push({
        nombre,
        precio: precioProducto ?? 0,
        descripcion: texto(producto.descripcion, LIMITES.descripcion) || undefined,
        tipo: grupos.length ? 'configurable' : 'simple',
        orden: indiceProducto,
        ...(variantes.length ? { variantes } : {}),
        ...(grupos.length ? { grupos } : {}),
      })
    })

    totalProductos += productos.length
    categorias.push({ nombre: nombreCategoria, orden: categorias.length, productos })
  })

  if (!totalProductos) errores.push('La carta no tiene productos')
  if (totalProductos > LIMITES.productos) {
    errores.push(`La carta pasa de ${LIMITES.productos} productos`)
  }

  return errores.length
    ? { ok: false, errores }
    : { ok: true, menu: { categorias }, productos: totalProductos }
}

const settings = require('./settings') as typeof import('./settings')

export const leerCarta = crearLectorDeCartas({
  settings: settings as LectorDependencias['settings'],
  logger: console,
})

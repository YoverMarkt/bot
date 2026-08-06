import type { RequestHandler, Response } from 'express'
import type {
  RecommendationRow,
  OptionGroupRow,
  OptionRow,
  OptionTemplateItemRow,
  OptionTemplateRow,
} from '../db/types'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

// El panel del dueño, del lado del servidor: crear y editar los grupos de
// opciones, sus opciones y las plantillas reutilizables.
//
// Hasta ahora el motor de opciones solo se podía cargar con una plantilla al
// crear el negocio o escribiendo SQL a mano. Todo lo que se construyó —grupos
// obligatorios, contadores, estrategias de precio— era invisible para el dueño.
//
// ⚠️ El `business_id` sale SIEMPRE del JWT (`getClientBusinessId`), nunca del
// cuerpo. Y el saneamiento de aquí replica los CHECK de la base a propósito:
// no es duplicar por duplicar, es que el dueño lea «el máximo debe ser al menos
// 1» en vez de un error de restricción de PostgreSQL.

type DataRecord = Record<string, unknown>

interface DatabaseResult {
  data?: unknown
  error?: { code?: string; message?: string } | null
}

interface ModuloDb {
  getOptionGroups(businessId: string): Promise<OptionGroupRow[]>
  getOptionGroupById(businessId: string, id: string): Promise<OptionGroupRow | null>
  createOptionGroup(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateOptionGroup(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteOptionGroup(businessId: string, id: string): Promise<DatabaseResult>
  getOptions(businessId: string): Promise<OptionRow[]>
  getOptionById(businessId: string, id: string): Promise<OptionRow | null>
  createOption(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateOption(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteOption(businessId: string, id: string): Promise<DatabaseResult>
  getOptionTemplates(businessId: string): Promise<OptionTemplateRow[]>
  getOptionTemplateById(businessId: string, id: string): Promise<OptionTemplateRow | null>
  createOptionTemplate(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateOptionTemplate(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteOptionTemplate(businessId: string, id: string): Promise<DatabaseResult>
  getOptionTemplateUsage(businessId: string): Promise<{ option_template_id: string | null }[]>
  getOptionTemplateItems(businessId: string): Promise<OptionTemplateItemRow[]>
  getOptionTemplateItemById(
    businessId: string, id: string,
  ): Promise<OptionTemplateItemRow | null>
  createOptionTemplateItem(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateOptionTemplateItem(
    businessId: string, id: string, data: DataRecord,
  ): Promise<DatabaseResult>
  deleteOptionTemplateItem(businessId: string, id: string): Promise<DatabaseResult>
  getRecommendations(businessId: string): Promise<RecommendationRow[]>
  getRecommendationById(businessId: string, id: string): Promise<RecommendationRow | null>
  createRecommendation(businessId: string, data: DataRecord): Promise<DatabaseResult>
  updateRecommendation(businessId: string, id: string, data: DataRecord): Promise<DatabaseResult>
  deleteRecommendation(businessId: string, id: string): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')

interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const guards = [auth.authClient, auth.requirePermission('catalogo')] as const

class InvalidInput extends Error {}

const SELECTION_TYPES = ['single', 'multiple', 'quantity'] as const
const PRICING_STRATEGIES = [
  'sum', 'fixed', 'highest_selected', 'lowest_selected', 'average',
  'included', 'included_up_to_limit', 'extra_after_limit',
] as const
const STOCK_VALUES = ['disponible', 'agotado'] as const

const text = (value: unknown, name: string, max: number, required = false): string | null => {
  if (value === null || value === undefined || value === '') {
    if (required) throw new InvalidInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidInput(`${name} es inválido`)
  const clean = value.trim()
  if (required && !clean) throw new InvalidInput(`${name} es obligatorio`)
  if (clean.length > max) throw new InvalidInput(`${name} no puede pasar de ${max} caracteres`)
  return clean || null
}

const integer = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new InvalidInput(`${name} debe ser un número entre ${min} y ${max}`)
  }
  return parsed
}

/** Los recargos admiten NEGATIVOS: «sin sopa −0.50» es un caso real. */
const money = (value: unknown, name: string): number => {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < -100000 || parsed > 100000) {
    throw new InvalidInput(`${name} es inválido`)
  }
  return Math.round(parsed * 100) / 100
}

const flag = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true'
}

const uuid = (value: unknown, name: string): string | null => {
  if (value === null || value === undefined || value === '') return null
  const clean = String(value).trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
    throw new InvalidInput(`${name} es inválido`)
  }
  return clean
}

const oneOf = <T extends string>(
  value: unknown, name: string, allowed: readonly T[], fallback: T,
): T => {
  if (value === null || value === undefined || value === '') return fallback
  const clean = String(value).trim()
  if (!allowed.includes(clean as T)) {
    throw new InvalidInput(`${name} debe ser uno de: ${allowed.join(', ')}`)
  }
  return clean as T
}

const httpsUrl = (value: unknown, name: string): string | null => {
  const clean = text(value, name, 500)
  if (clean && !clean.startsWith('https://')) {
    throw new InvalidInput(`${name} debe empezar por https://`)
  }
  return clean
}

/**
 * Un grupo de opciones, ya validado contra las mismas reglas que aplica la base.
 *
 * Las tres que más se equivocan y por qué existen:
 *   · `single` es exactamente uno — un radio con máximo 5 obligaría a la app a
 *     decidir a quién cree.
 *   · obligatorio exige mínimo 1 — un «obligatorio» que no impide seguir es
 *     peor que no ponerlo.
 *   · cuelga de un producto O de una categoría, nunca de ambos ni de ninguno.
 */
function sanitizeGroup(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Datos inválidos')
  }
  const source = body as DataRecord

  const productId = uuid(source.product_id, 'El producto')
  const categoryId = uuid(source.category_id, 'La categoría')
  if (Boolean(productId) === Boolean(categoryId)) {
    throw new InvalidInput(
      'El grupo tiene que colgar de un producto o de una categoría, pero no de los dos',
    )
  }

  const selectionType = oneOf(source.selection_type, 'El tipo de selección', SELECTION_TYPES, 'single')
  const required = flag(source.required)
  const minSelectable = integer(source.min_selectable, 'El mínimo', 0, 100, required ? 1 : 0)
  const maxSelectable = integer(source.max_selectable, 'El máximo', 1, 100, 1)
  const pricingStrategy = oneOf(
    source.pricing_strategy, 'La estrategia de precio', PRICING_STRATEGIES, 'sum',
  )
  const conLimite = pricingStrategy === 'included_up_to_limit'
    || pricingStrategy === 'extra_after_limit'
  const freeSelections = integer(
    source.free_selections, 'Las selecciones sin recargo', 0, 100, conLimite ? 1 : 0,
  )

  if (selectionType === 'single' && maxSelectable !== 1) {
    throw new InvalidInput('Con «elegir uno» el máximo tiene que ser 1')
  }
  if (required && minSelectable < 1) {
    throw new InvalidInput('Un grupo obligatorio necesita un mínimo de al menos 1')
  }
  if (minSelectable > maxSelectable) {
    throw new InvalidInput('El mínimo no puede ser mayor que el máximo')
  }
  if (conLimite && freeSelections < 1) {
    throw new InvalidInput('Esa estrategia necesita decir cuántas van sin recargo')
  }

  return {
    product_id: productId,
    category_id: categoryId,
    name: text(source.name, 'El nombre', 120, true),
    description: text(source.description, 'La descripción', 300),
    selection_type: selectionType,
    required,
    min_selectable: minSelectable,
    max_selectable: maxSelectable,
    max_total_quantity: source.max_total_quantity === null
      || source.max_total_quantity === undefined || source.max_total_quantity === ''
      ? null
      : integer(source.max_total_quantity, 'El total de porciones', 1, 100, 1),
    pricing_strategy: pricingStrategy,
    free_selections: freeSelections,
    option_template_id: uuid(source.option_template_id, 'La plantilla'),
    sort: integer(source.sort, 'El orden', 0, 999, 0),
    active: flag(source.active, true),
  }
}

/** Una opción suelta o un ítem de plantilla: los campos son los mismos. */
function sanitizeOptionFields(source: DataRecord): DataRecord {
  return {
    name: text(source.name, 'El nombre', 120, true),
    description: text(source.description, 'La descripción', 300),
    image_url: httpsUrl(source.image_url, 'La imagen'),
    image_public_id: text(source.image_public_id, 'La imagen', 200),
    price_adjustment: money(source.price_adjustment, 'El recargo'),
    references_product_id: uuid(source.references_product_id, 'El producto referenciado'),
    default_selected: flag(source.default_selected),
    stock: oneOf(source.stock, 'La disponibilidad', STOCK_VALUES, 'disponible'),
    sort: integer(source.sort, 'El orden', 0, 999, 0),
    active: flag(source.active, true),
  }
}

function sanitizeOption(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Datos inválidos')
  }
  const source = body as DataRecord
  const groupId = uuid(source.option_group_id, 'El grupo')
  if (!groupId) throw new InvalidInput('Falta el grupo de la opción')
  return { ...sanitizeOptionFields(source), option_group_id: groupId }
}

function sanitizeTemplateItem(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Datos inválidos')
  }
  const source = body as DataRecord
  const templateId = uuid(source.option_template_id, 'La plantilla')
  if (!templateId) throw new InvalidInput('Falta la plantilla')
  return { ...sanitizeOptionFields(source), option_template_id: templateId }
}

function sanitizeTemplate(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Datos inválidos')
  }
  const source = body as DataRecord
  return {
    name: text(source.name, 'El nombre', 120, true),
    description: text(source.description, 'La descripción', 300),
    active: flag(source.active, true),
  }
}

/**
 * El panel nunca ve el error crudo de PostgreSQL: filtraría nombres de tablas y
 * restricciones. Pero las dos violaciones que el dueño PUEDE arreglar solo se
 * traducen a algo que se entiende.
 */
function fail(res: Response, context: string, error: unknown): Response {
  if (error instanceof InvalidInput) {
    return res.status(400).json({ error: error.message })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/foreign key|violates foreign key/i.test(message)) {
    return res.status(400).json({
      error: 'Ese producto, categoría o plantilla no existe en tu catálogo',
    })
  }
  if (/duplicate key|unique/i.test(message)) {
    return res.status(409).json({ error: 'Ya existe algo con ese nombre' })
  }
  console.error(`❌ ${context}:`, message)
  return res.status(500).json({ error: `No se pudo ${context}` })
}

const assertWrite = (result: DatabaseResult, context: string): void => {
  if (result?.error) throw new Error(`${context}: ${result.error.message || 'sin detalle'}`)
}

// ── Grupos de opciones ──────────────────────────────────────────────────────

router.get('/api/client/option-groups', auth.authClient, async (req, res) => {
  res.json(await db.getOptionGroups(getClientBusinessId(req)))
})

router.post('/api/client/option-groups', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const data = sanitizeGroup(req.body)
    const result = await db.createOptionGroup(businessId, data)
    assertWrite(result, 'crear el grupo')
    res.status(201).json(result.data)
  } catch (error) {
    fail(res, 'crear el grupo', error)
  }
})

router.put('/api/client/option-groups/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionGroupById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Ese grupo no existe' })
    const data = sanitizeGroup(req.body)
    assertWrite(
      await db.updateOptionGroup(businessId, String(req.params.id), data),
      'actualizar el grupo',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'actualizar el grupo', error)
  }
})

router.delete('/api/client/option-groups/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionGroupById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Ese grupo no existe' })
    assertWrite(
      await db.deleteOptionGroup(businessId, String(req.params.id)),
      'eliminar el grupo',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'eliminar el grupo', error)
  }
})

// ── Opciones ────────────────────────────────────────────────────────────────

router.get('/api/client/options', auth.authClient, async (req, res) => {
  res.json(await db.getOptions(getClientBusinessId(req)))
})

router.post('/api/client/options', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const data = sanitizeOption(req.body)
    // El grupo tiene que ser SUYO. La foránea compuesta lo impediría igual,
    // pero así el dueño recibe un 404 claro en vez de un error de la base.
    const grupo = await db.getOptionGroupById(businessId, String(data.option_group_id))
    if (!grupo) return res.status(404).json({ error: 'Ese grupo no existe' })
    const result = await db.createOption(businessId, data)
    assertWrite(result, 'crear la opción')
    res.status(201).json(result.data)
  } catch (error) {
    fail(res, 'crear la opción', error)
  }
})

router.put('/api/client/options/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa opción no existe' })
    const data = sanitizeOption(req.body)
    const grupo = await db.getOptionGroupById(businessId, String(data.option_group_id))
    if (!grupo) return res.status(404).json({ error: 'Ese grupo no existe' })
    assertWrite(
      await db.updateOption(businessId, String(req.params.id), data),
      'actualizar la opción',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'actualizar la opción', error)
  }
})

router.delete('/api/client/options/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa opción no existe' })
    assertWrite(
      await db.deleteOption(businessId, String(req.params.id)),
      'eliminar la opción',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'eliminar la opción', error)
  }
})

// ── Plantillas reutilizables ────────────────────────────────────────────────

router.get('/api/client/option-templates', auth.authClient, async (req, res) => {
  const businessId = getClientBusinessId(req)
  const [plantillas, usos] = await Promise.all([
    db.getOptionTemplates(businessId),
    db.getOptionTemplateUsage(businessId),
  ])
  // Cuántos grupos se sirven de cada una: el panel avisa antes de borrar, que
  // es justo el aviso que falta cuando algo se referencia desde cinco sitios.
  const cuenta = new Map<string, number>()
  for (const uso of usos) {
    const id = String(uso.option_template_id || '')
    if (id) cuenta.set(id, (cuenta.get(id) || 0) + 1)
  }
  res.json(plantillas.map(plantilla => ({
    ...plantilla,
    used_by_groups: cuenta.get(String(plantilla.id)) || 0,
  })))
})

router.post('/api/client/option-templates', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const result = await db.createOptionTemplate(businessId, sanitizeTemplate(req.body))
    assertWrite(result, 'crear la plantilla')
    res.status(201).json(result.data)
  } catch (error) {
    fail(res, 'crear la plantilla', error)
  }
})

router.put('/api/client/option-templates/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionTemplateById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa plantilla no existe' })
    assertWrite(
      await db.updateOptionTemplate(businessId, String(req.params.id), sanitizeTemplate(req.body)),
      'actualizar la plantilla',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'actualizar la plantilla', error)
  }
})

router.delete('/api/client/option-templates/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionTemplateById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa plantilla no existe' })
    assertWrite(
      await db.deleteOptionTemplate(businessId, String(req.params.id)),
      'eliminar la plantilla',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'eliminar la plantilla', error)
  }
})

// ── Opciones dentro de una plantilla ────────────────────────────────────────

router.get('/api/client/option-template-items', auth.authClient, async (req, res) => {
  res.json(await db.getOptionTemplateItems(getClientBusinessId(req)))
})

router.post('/api/client/option-template-items', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const data = sanitizeTemplateItem(req.body)
    const plantilla = await db.getOptionTemplateById(
      businessId, String(data.option_template_id),
    )
    if (!plantilla) return res.status(404).json({ error: 'Esa plantilla no existe' })
    const result = await db.createOptionTemplateItem(businessId, data)
    assertWrite(result, 'crear la opción de la plantilla')
    res.status(201).json(result.data)
  } catch (error) {
    fail(res, 'crear la opción de la plantilla', error)
  }
})

router.put('/api/client/option-template-items/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionTemplateItemById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa opción no existe' })
    const data = sanitizeTemplateItem(req.body)
    const plantilla = await db.getOptionTemplateById(
      businessId, String(data.option_template_id),
    )
    if (!plantilla) return res.status(404).json({ error: 'Esa plantilla no existe' })
    assertWrite(
      await db.updateOptionTemplateItem(businessId, String(req.params.id), data),
      'actualizar la opción de la plantilla',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'actualizar la opción de la plantilla', error)
  }
})

router.delete('/api/client/option-template-items/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getOptionTemplateItemById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Esa opción no existe' })
    assertWrite(
      await db.deleteOptionTemplateItem(businessId, String(req.params.id)),
      'eliminar la opción de la plantilla',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'eliminar la opción de la plantilla', error)
  }
})

// ── Adicionales: «agrega algo más» ──────────────────────────────────────────
//
// Ojo con la diferencia, que es la que decide todo: un adicional NO es una
// opción del plato. Es OTRO producto que entra al carrito como línea propia,
// así que aquí solo se dice qué ofrecer y dónde — el precio sale del producto.

/**
 * Un adicional cuelga de un producto, de una categoría, o de nada (todo el
 * negocio). A diferencia de los grupos de opciones, aquí «de nada» es legítimo:
 * son las recomendaciones generales del carrito.
 */
function sanitizeRecommendation(body: unknown): DataRecord {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Datos inválidos')
  }
  const source = body as DataRecord

  const productId = uuid(source.source_product_id, 'El producto')
  const categoryId = uuid(source.source_category_id, 'La categoría')
  if (productId && categoryId) {
    throw new InvalidInput('Elige un producto o una categoría, no las dos cosas')
  }

  const ofrecido = uuid(source.recommended_product_id, 'El producto que se ofrece')
  if (!ofrecido) throw new InvalidInput('Falta el producto que se va a ofrecer')
  // Ofrecerse a sí mismo no tiene sentido y confunde al cliente.
  if (ofrecido === productId) {
    throw new InvalidInput('Un producto no puede recomendarse a sí mismo')
  }

  return {
    source_product_id: productId,
    source_category_id: categoryId,
    recommended_product_id: ofrecido,
    section: text(source.section, 'El título', 60) || 'Agrega algo más',
    sort: integer(source.sort, 'El orden', 0, 999, 0),
    active: flag(source.active, true),
  }
}

router.get('/api/client/recommendations', auth.authClient, async (req, res) => {
  res.json(await db.getRecommendations(getClientBusinessId(req)))
})

router.post('/api/client/recommendations', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const result = await db.createRecommendation(businessId, sanitizeRecommendation(req.body))
    assertWrite(result, 'crear el adicional')
    res.status(201).json(result.data)
  } catch (error) {
    fail(res, 'crear el adicional', error)
  }
})

router.put('/api/client/recommendations/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getRecommendationById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Ese adicional no existe' })
    assertWrite(
      await db.updateRecommendation(
        businessId, String(req.params.id), sanitizeRecommendation(req.body),
      ),
      'actualizar el adicional',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'actualizar el adicional', error)
  }
})

router.delete('/api/client/recommendations/:id', ...guards, async (req, res) => {
  const businessId = getClientBusinessId(req)
  try {
    const existente = await db.getRecommendationById(businessId, String(req.params.id))
    if (!existente) return res.status(404).json({ error: 'Ese adicional no existe' })
    assertWrite(
      await db.deleteRecommendation(businessId, String(req.params.id)),
      'eliminar el adicional',
    )
    res.json({ ok: true })
  } catch (error) {
    fail(res, 'eliminar el adicional', error)
  }
})

export = router

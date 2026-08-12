import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const router = require('../dist/routes/product-options.routes')
const db = require('../dist/db')

// ═══════════════════════════════════════════════════════════════════════════
// EL PANEL DEL DUEÑO, DEL LADO DEL SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta ahora el motor de opciones solo se podía cargar con una plantilla al
// crear el negocio o escribiendo SQL a mano: todo lo construido era invisible
// para el dueño. Estas rutas son las que lo hacen suyo.
//
// Lo que de verdad importa comprobar aquí es doble:
//   · que el `business_id` salga SIEMPRE del JWT y nunca del cuerpo, porque
//     este es el único sitio del sistema donde el dueño ESCRIBE catálogo;
//   · que el saneamiento rechace las combinaciones que la base rechazaría,
//     para que el dueño lea un motivo y no un error de PostgreSQL.

const rutas = router.stack
  .filter(layer => layer.route)
  .map(layer => ({
    path: layer.route.path,
    method: Object.keys(layer.route.methods)[0],
    handlers: layer.route.stack.length,
  }))

afterEach(() => { vi.restoreAllMocks() })

/** Ejecuta una ruta saltándose los middlewares de auth, con el negocio dado. */
async function ejecutar(path, method, { businessId = 'negocio-a', body = {}, params = {} } = {}) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method],
  )
  if (!layer) throw new Error(`No existe ${method.toUpperCase()} ${path}`)
  const handler = layer.route.stack.at(-1).handle

  const req = {
    user: { role: 'client', businessId, urole: 'owner' },
    body,
    params,
    query: {},
  }
  const salida = { status: 200, body: undefined }
  const res = {
    status(code) { salida.status = code; return this },
    json(cuerpo) { salida.body = cuerpo; return this },
  }
  await handler(req, res, (error) => { if (error) throw error })
  return salida
}

const GRUPO_VALIDO = {
  product_id: '11111111-1111-4111-8111-111111111111',
  name: 'Término de la carne',
  selection_type: 'single',
  required: true,
  min_selectable: 1,
  max_selectable: 1,
}

describe('rutas de opciones del panel', () => {
  it('expone el CRUD completo y nada más', () => {
    const paths = [...new Set(rutas.map(r => r.path))].sort()
    expect(paths).toEqual([
      '/api/client/option-groups',
      '/api/client/option-groups/:id',
      '/api/client/option-groups/reorder',
      '/api/client/option-template-items',
      '/api/client/option-template-items/:id',
      '/api/client/option-templates',
      '/api/client/option-templates/:id',
      '/api/client/options',
      '/api/client/options/:id',
      '/api/client/options/reorder',
      '/api/client/recommendations',
      '/api/client/recommendations/:id',
    ])
  })

  // Escribir catálogo no puede quedar detrás de un solo `authClient`: un
  // empleado sin permiso de catálogo no debe poder rehacer la carta.
  it('toda escritura exige auth Y permiso de catálogo', () => {
    const escrituras = rutas.filter(r => r.method !== 'get')
    expect(escrituras.length).toBeGreaterThan(0)
    for (const ruta of escrituras) {
      expect(ruta.handlers, `${ruta.method} ${ruta.path}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('las lecturas exigen al menos estar autenticado', () => {
    for (const ruta of rutas.filter(r => r.method === 'get')) {
      expect(ruta.handlers, ruta.path).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('el negocio sale del JWT, nunca del cuerpo', () => {
  // La regla inviolable #1. Este es el único sitio donde el dueño ESCRIBE
  // catálogo, así que es donde más caro sale equivocarse.
  it('un business_id en el cuerpo se ignora', async () => {
    const crear = vi.spyOn(db, 'createOptionGroup')
      .mockResolvedValue({ data: { id: 'g1' }, error: null })

    await ejecutar('/api/client/option-groups', 'post', {
      businessId: 'negocio-a',
      body: { ...GRUPO_VALIDO, business_id: 'negocio-de-otro' },
    })

    expect(crear).toHaveBeenCalledWith('negocio-a', expect.any(Object))
    // Y el cuerpo saneado no lo lleva de contrabando.
    expect(crear.mock.calls[0][1]).not.toHaveProperty('business_id')
  })

  it('editar comprueba primero que el grupo sea SUYO', async () => {
    const buscar = vi.spyOn(db, 'getOptionGroupById').mockResolvedValue(null)
    const actualizar = vi.spyOn(db, 'updateOptionGroup')

    const r = await ejecutar('/api/client/option-groups/:id', 'put', {
      businessId: 'negocio-a',
      params: { id: 'grupo-de-otro' },
      body: GRUPO_VALIDO,
    })

    expect(r.status).toBe(404)
    expect(buscar).toHaveBeenCalledWith('negocio-a', 'grupo-de-otro')
    // Lo importante: nunca llegó a escribir.
    expect(actualizar).not.toHaveBeenCalled()
  })

  it('borrar comprueba primero que el grupo sea SUYO', async () => {
    vi.spyOn(db, 'getOptionGroupById').mockResolvedValue(null)
    const borrar = vi.spyOn(db, 'deleteOptionGroup')

    const r = await ejecutar('/api/client/option-groups/:id', 'delete', {
      params: { id: 'grupo-de-otro' },
    })

    expect(r.status).toBe(404)
    expect(borrar).not.toHaveBeenCalled()
  })

  it('una opción no se puede colgar del grupo de otro negocio', async () => {
    vi.spyOn(db, 'getOptionGroupById').mockResolvedValue(null)
    const crear = vi.spyOn(db, 'createOption')

    const r = await ejecutar('/api/client/options', 'post', {
      body: {
        option_group_id: '22222222-2222-4222-8222-222222222222',
        name: 'Bien cocida',
      },
    })

    expect(r.status).toBe(404)
    expect(crear).not.toHaveBeenCalled()
  })

  it('un ítem no se puede meter en la plantilla de otro negocio', async () => {
    vi.spyOn(db, 'getOptionTemplateById').mockResolvedValue(null)
    const crear = vi.spyOn(db, 'createOptionTemplateItem')

    const r = await ejecutar('/api/client/option-template-items', 'post', {
      body: {
        option_template_id: '33333333-3333-4333-8333-333333333333',
        name: 'Hawaiana',
      },
    })

    expect(r.status).toBe(404)
    expect(crear).not.toHaveBeenCalled()
  })
})

describe('lo que el dueño puede guardar', () => {
  const crearGrupo = (body) => ejecutar('/api/client/option-groups', 'post', { body })

  it('rechaza un grupo que no cuelga de nada', async () => {
    const r = await crearGrupo({ name: 'Suelto' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/producto o de una categoría/)
  })

  it('rechaza un grupo colgado de producto Y categoría a la vez', async () => {
    const r = await crearGrupo({
      ...GRUPO_VALIDO,
      category_id: '44444444-4444-4444-8444-444444444444',
    })
    expect(r.status).toBe(400)
  })

  // «Elegir uno» con máximo 5 obligaría a la app a decidir a quién cree.
  it('rechaza «elegir uno» con máximo mayor que 1', async () => {
    const r = await crearGrupo({ ...GRUPO_VALIDO, max_selectable: 5 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/máximo tiene que ser 1/)
  })

  // Un «obligatorio» que no impide seguir es peor que no ponerlo.
  it('rechaza un obligatorio sin mínimo', async () => {
    const r = await crearGrupo({
      ...GRUPO_VALIDO, selection_type: 'multiple', max_selectable: 3,
      required: true, min_selectable: 0,
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/mínimo de al menos 1/)
  })

  it('rechaza un mínimo mayor que el máximo', async () => {
    const r = await crearGrupo({
      ...GRUPO_VALIDO, selection_type: 'multiple',
      min_selectable: 5, max_selectable: 2,
    })
    expect(r.status).toBe(400)
  })

  it('rechaza una estrategia de precio inventada', async () => {
    const r = await crearGrupo({ ...GRUPO_VALIDO, pricing_strategy: 'lo_que_sea' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/estrategia de precio/)
  })

  it('rechaza «las primeras N gratis» sin decir cuántas', async () => {
    const r = await crearGrupo({
      ...GRUPO_VALIDO, pricing_strategy: 'included_up_to_limit', free_selections: 0,
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/cuántas van sin recargo/)
  })

  it('acepta la mitad y mitad: highest_selected', async () => {
    const crear = vi.spyOn(db, 'createOptionGroup')
      .mockResolvedValue({ data: { id: 'g1' }, error: null })
    const r = await crearGrupo({ ...GRUPO_VALIDO, pricing_strategy: 'highest_selected' })
    expect(r.status).toBe(201)
    expect(crear.mock.calls[0][1].pricing_strategy).toBe('highest_selected')
  })

  it('un uuid inventado no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createOptionGroup')
    const r = await crearGrupo({ ...GRUPO_VALIDO, product_id: 'no-soy-un-uuid' })
    expect(r.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  // El recargo negativo es «sin sopa −0.50»: un caso real, no un error.
  it('acepta un recargo negativo en una opción', async () => {
    vi.spyOn(db, 'getOptionGroupById').mockResolvedValue({ id: 'g1' })
    const crear = vi.spyOn(db, 'createOption')
      .mockResolvedValue({ data: { id: 'o1' }, error: null })

    const r = await ejecutar('/api/client/options', 'post', {
      body: {
        option_group_id: '22222222-2222-4222-8222-222222222222',
        name: 'Sin sopa',
        price_adjustment: -0.5,
      },
    })

    expect(r.status).toBe(201)
    expect(crear.mock.calls[0][1].price_adjustment).toBe(-0.5)
  })

  // La imagen acaba en un <img> de una app pública: http:// la rompe en móvil.
  it('rechaza una imagen que no sea https', async () => {
    vi.spyOn(db, 'getOptionGroupById').mockResolvedValue({ id: 'g1' })
    const r = await ejecutar('/api/client/options', 'post', {
      body: {
        option_group_id: '22222222-2222-4222-8222-222222222222',
        name: 'Con foto',
        image_url: 'http://ejemplo.com/foto.jpg',
      },
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/https/)
  })
})

describe('plantillas', () => {
  // Una plantilla se referencia desde varios grupos: borrarla a ciegas deja al
  // dueño sin saber qué acaba de cambiar en cuántos productos.
  it('el listado dice cuántos grupos usan cada plantilla', async () => {
    vi.spyOn(db, 'getOptionTemplates').mockResolvedValue([
      { id: 'p1', name: 'Sabores' },
      { id: 'p2', name: 'Salsas' },
    ])
    vi.spyOn(db, 'getOptionTemplateUsage').mockResolvedValue([
      { option_template_id: 'p1' },
      { option_template_id: 'p1' },
      { option_template_id: 'p1' },
    ])

    const r = await ejecutar('/api/client/option-templates', 'get')

    expect(r.body).toEqual([
      { id: 'p1', name: 'Sabores', used_by_groups: 3 },
      { id: 'p2', name: 'Salsas', used_by_groups: 0 },
    ])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ADICIONALES: «AGREGA ALGO MÁS»
// ═══════════════════════════════════════════════════════════════════════════
//
// La diferencia que decide el modelo: un adicional NO es una opción del plato,
// es OTRO producto que entra al carrito como línea propia. Si acabara dentro,
// el dueño vería «Pizza (con pan de ajo)» en vez de dos cosas que preparar.

const OFRECIDO = '55555555-5555-4555-8555-555555555555'
const ORIGEN = '66666666-6666-4666-8666-666666666666'

describe('adicionales', () => {
  const crear = (body) => ejecutar('/api/client/recommendations', 'post', { body })

  it('acepta las tres formas: por producto, por categoría y global', async () => {
    const guardar = vi.spyOn(db, 'createRecommendation')
      .mockResolvedValue({ data: { id: 'r1' }, error: null })

    for (const origen of [
      { source_product_id: ORIGEN },
      { source_category_id: ORIGEN },
      {},  // de todo el negocio: el caso del carrito
    ]) {
      const r = await crear({ ...origen, recommended_product_id: OFRECIDO })
      expect(r.status, JSON.stringify(origen)).toBe(201)
    }
    expect(guardar).toHaveBeenCalledTimes(3)
  })

  it('rechaza colgarlo de un producto Y una categoría a la vez', async () => {
    const r = await crear({
      source_product_id: ORIGEN,
      source_category_id: OFRECIDO,
      recommended_product_id: OFRECIDO,
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/no las dos cosas/)
  })

  it('exige decir QUÉ se ofrece', async () => {
    const r = await crear({ source_product_id: ORIGEN })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/producto que se va a ofrecer/)
  })

  // Ofrecerse a sí mismo no tiene sentido y confunde al cliente.
  it('rechaza que un producto se recomiende a sí mismo', async () => {
    const r = await crear({
      source_product_id: ORIGEN, recommended_product_id: ORIGEN,
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/a sí mismo/)
  })

  it('pone un título por defecto si no se da ninguno', async () => {
    const guardar = vi.spyOn(db, 'createRecommendation')
      .mockResolvedValue({ data: { id: 'r1' }, error: null })
    await crear({ recommended_product_id: OFRECIDO })
    expect(guardar.mock.calls[0][1].section).toBe('Agrega algo más')
  })

  it('el business_id sale del JWT, nunca del cuerpo', async () => {
    const guardar = vi.spyOn(db, 'createRecommendation')
      .mockResolvedValue({ data: { id: 'r1' }, error: null })

    await ejecutar('/api/client/recommendations', 'post', {
      businessId: 'negocio-a',
      body: { recommended_product_id: OFRECIDO, business_id: 'negocio-de-otro' },
    })

    expect(guardar).toHaveBeenCalledWith('negocio-a', expect.any(Object))
    expect(guardar.mock.calls[0][1]).not.toHaveProperty('business_id')
  })

  it('editar comprueba primero que el adicional sea SUYO', async () => {
    vi.spyOn(db, 'getRecommendationById').mockResolvedValue(null)
    const actualizar = vi.spyOn(db, 'updateRecommendation')

    const r = await ejecutar('/api/client/recommendations/:id', 'put', {
      params: { id: 'de-otro' },
      body: { recommended_product_id: OFRECIDO },
    })

    expect(r.status).toBe(404)
    expect(actualizar).not.toHaveBeenCalled()
  })

  it('borrar comprueba primero que el adicional sea SUYO', async () => {
    vi.spyOn(db, 'getRecommendationById').mockResolvedValue(null)
    const borrar = vi.spyOn(db, 'deleteRecommendation')

    const r = await ejecutar('/api/client/recommendations/:id', 'delete', {
      params: { id: 'de-otro' },
    })

    expect(r.status).toBe(404)
    expect(borrar).not.toHaveBeenCalled()
  })
})

// ── Reordenar ──────────────────────────────────────────────────────────────
//
// El orden que pone el dueño aquí es el que ve el cliente al armar su plato Y
// el que se congela en su pedido. Antes no se podía tocar: el editor creaba
// todos los grupos con `sort = 0` y no ofrecía ninguna forma de cambiarlo, así
// que ordenar por `sort` no habría hecho nada.
describe('ordenar los grupos y las opciones', () => {
  it('manda la lista al servidor y responde cuántos movió', async () => {
    const ordenar = vi.spyOn(db, 'reorderOptionGroups').mockResolvedValue(3)

    const r = await ejecutar('/api/client/option-groups/reorder', 'post', {
      body: { ids: ['g-1', 'g-2', 'g-3'] },
    })

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, movidos: 3 })
    // ⚠️ REGLA #1: el negocio sale del JWT, nunca del cuerpo.
    expect(ordenar).toHaveBeenCalledWith('negocio-a', ['g-1', 'g-2', 'g-3'])
  })

  it('el negocio del cuerpo se ignora', async () => {
    const ordenar = vi.spyOn(db, 'reorderOptionGroups').mockResolvedValue(1)

    await ejecutar('/api/client/option-groups/reorder', 'post', {
      businessId: 'negocio-a',
      body: { ids: ['g-1'], business_id: 'negocio-b', businessId: 'negocio-b' },
    })

    expect(ordenar).toHaveBeenCalledWith('negocio-a', ['g-1'])
  })

  it('una lista repetida se rechaza: dejaría huecos en el orden', async () => {
    const ordenar = vi.spyOn(db, 'reorderOptionGroups')

    const r = await ejecutar('/api/client/option-groups/reorder', 'post', {
      body: { ids: ['g-1', 'g-1'] },
    })

    expect(r.status).toBe(400)
    expect(ordenar).not.toHaveBeenCalled()
  })

  it('sin lista no se llama a la base', async () => {
    const ordenar = vi.spyOn(db, 'reorderOptionGroups')

    for (const body of [{}, { ids: [] }, { ids: 'g-1' }, { ids: ['', '  '] }]) {
      const r = await ejecutar('/api/client/option-groups/reorder', 'post', { body })
      expect(r.status).toBe(400)
    }
    expect(ordenar).not.toHaveBeenCalled()
  })

  // Las opciones llevan además su grupo: sin él, una opción de otro grupo del
  // mismo negocio se colaría en la lista y saldría reordenada donde no toca.
  it('ordenar opciones comprueba que el grupo sea suyo', async () => {
    const buscar = vi.spyOn(db, 'getOptionGroupById').mockResolvedValue({ id: 'g-1' })
    const ordenar = vi.spyOn(db, 'reorderOptions').mockResolvedValue(2)

    const r = await ejecutar('/api/client/options/reorder', 'post', {
      body: { groupId: 'g-1', ids: ['o-1', 'o-2'] },
    })

    expect(r.status).toBe(200)
    expect(buscar).toHaveBeenCalledWith('negocio-a', 'g-1')
    expect(ordenar).toHaveBeenCalledWith('negocio-a', 'g-1', ['o-1', 'o-2'])
  })

  // Sin esto la función devolvería «cero movidos» y el dueño leería «ordenado»
  // sin que se hubiera ordenado nada.
  it('un grupo de otro negocio responde 404 y no toca la base', async () => {
    vi.spyOn(db, 'getOptionGroupById').mockResolvedValue(null)
    const ordenar = vi.spyOn(db, 'reorderOptions')

    const r = await ejecutar('/api/client/options/reorder', 'post', {
      body: { groupId: 'g-de-otro', ids: ['o-1'] },
    })

    expect(r.status).toBe(404)
    expect(ordenar).not.toHaveBeenCalled()
  })

  it('sin grupo no se ordena nada', async () => {
    const ordenar = vi.spyOn(db, 'reorderOptions')

    const r = await ejecutar('/api/client/options/reorder', 'post', {
      body: { ids: ['o-1'] },
    })

    expect(r.status).toBe(400)
    expect(ordenar).not.toHaveBeenCalled()
  })
})

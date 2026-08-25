import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const cliente = require('../dist/db/client')

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR SIN IA
//
// El comportamiento se prueba de verdad contra PostgreSQL en
// `verificar-esquema.sql` —es donde vive la lógica—. Aquí se vigila lo que un
// refactor puede llevarse sin que nada falle: el ámbito, las tres capas y la
// calificación de esquema que evita el fallo del search_path.
// ═══════════════════════════════════════════════════════════════════════════

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const SQL = readFileSync(`${serverDir}/migration-2026-08-21-marketplace-busqueda.sql`, 'utf8')
const SCHEMA = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const sinComentarios = sql => sql.replace(/--[^\n]*/g, '')

afterEach(() => { vi.restoreAllMocks() })

describe('el diccionario que distingue «no entiendo» de «no tengo»', () => {
  // Devuelve la etiqueta de la categoría a la que apunta el alias, o null.
  const conFilas = (alias, categoria) => {
    vi.spyOn(cliente, 'from').mockImplementation((tabla) => {
      if (tabla === 'marketplace_search_aliases') {
        return {
          select: () => ({ in: () => ({ limit: async () => ({ data: alias, error: null }) }) }),
        }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: categoria, error: null }) }) }),
      }
    })
  }

  it('«quiero pollo asado» se reconoce y devuelve su categoría', async () => {
    conFilas([{ category_code: 'asados' }], { label: 'Asados y parrilladas' })
    await expect(db.marketplaceKnownTerm('quiero pollo asado'))
      .resolves.toBe('Asados y parrilladas')
  })

  // Palabra por palabra, no la frase entera: el alias es «pollo», no «quiero
  // pollo asado». Es el mismo motivo por el que existe la normalización.
  it('busca por palabras y descarta las cortas', async () => {
    const capturado = []
    vi.spyOn(cliente, 'from').mockImplementation(() => ({
      select: () => ({
        in: (_col, valores) => { capturado.push(...valores); return { limit: async () => ({ data: [], error: null }) } },
      }),
    }))
    await db.marketplaceKnownTerm('me das un POLLO, con papas')
    // Sin tildes, en minúsculas, sin puntuación y sin palabras de 1-2 letras.
    expect(capturado).toContain('pollo')
    expect(capturado).toContain('papas')
    expect(capturado).not.toContain('me')
    expect(capturado).not.toContain('un')
  })

  it('una tontería no casa con nada', async () => {
    conFilas([], null)
    await expect(db.marketplaceKnownTerm('asdfghjkl')).resolves.toBeNull()
  })

  it('un texto vacío no gasta ni una consulta', async () => {
    const from = vi.spyOn(cliente, 'from')
    await expect(db.marketplaceKnownTerm('   ')).resolves.toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  // Falla hacia null: el llamador responde entonces lo de siempre.
  it('un fallo de la base devuelve null, no lanza', async () => {
    vi.spyOn(cliente, 'from').mockImplementation(() => ({
      select: () => ({ in: () => ({ limit: async () => ({ data: null, error: { message: 'caída' } }) }) }),
    }))
    await expect(db.marketplaceKnownTerm('pollo')).resolves.toBeNull()
  })
})

describe('el ámbito de la búsqueda', () => {
  it('en global busca locales y no productos sueltos', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [], error: null })
    await db.searchMarketplaceBusinesses('quiero ceviche')
    expect(rpc).toHaveBeenCalledWith('marketplace_buscar_negocios', {
      p_query: 'quiero ceviche', p_limite: 8,
    })
  })

  it('dentro de un local, el negocio viaja SIEMPRE a la base', async () => {
    // ⚠️ Sin `p_business_id`, «también quiero una Coca Cola» traería la de otro
    // local — y un carrito solo puede tener productos de un negocio.
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [], error: null })
    await db.searchMarketplaceProducts('biz-1', 'coca cola')
    expect(rpc).toHaveBeenCalledWith('marketplace_buscar_productos', {
      p_business_id: 'biz-1', p_query: 'coca cola', p_limite: 8,
    })
  })

  it('un fallo de la base sube, no devuelve «no encontré nada»', async () => {
    // Decirle «no hay» a quien sí tiene dónde pedir es peor que un error.
    vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.searchMarketplaceBusinesses('ceviche')).rejects.toThrow('caída')
    await expect(db.searchMarketplaceProducts('b', 'x')).rejects.toThrow('caída')
  })
})

describe('las tres capas', () => {
  it('están las tres, y por eso «cebiche» encuentra «ceviche»', () => {
    // El diccionario español reduce «ceviche» a 'cevich' y «cebiche» a
    // 'cebich': por texto NO casan. Quitar la capa de parecido dejaría fuera
    // media clientela sin que ninguna prueba de texto se enterase.
    expect(SQL).toContain('marketplace_search_aliases')
    expect(SQL).toContain("to_tsvector('spanish'")
    expect(SQL).toContain('extensions.similarity')
  })

  it('el parecido compara palabra por palabra, no la frase entera', () => {
    // Medido: «cebiche» contra «ceviche de camarones» da 0.217 con el nombre
    // completo —bajo el umbral de 0.3— y 0.455 con su mejor palabra.
    expect(SQL).toMatch(/unnest\(string_to_array\(lower\(p\.name\), ' '\)\)/)
  })

  it('normaliza la frase antes de buscar', () => {
    // «quiero ceviche» sin normalizar encontraba UN local de tres: el alias no
    // casa con la frase entera y `plainto_tsquery` exige TODAS las palabras.
    expect(SQL).toContain('marketplace_normalizar_consulta')
    for (const muletilla of ['quiero', 'tienen', 'hola', 'favor']) {
      expect(SQL, muletilla).toContain(`'${muletilla}'`)
    }
  })

  it('el alias se prueba también palabra por palabra', () => {
    // La lista de muletillas nunca estará completa; sin esto, una sola que se
    // cuele deja la capa más barata sin casar.
    expect(SQL).toMatch(/a\.term = any\(string_to_array\(c\.texto, ' '\)\)/)
  })
})

describe('el fallo que dejó el canal mudo cinco días no se repite', () => {
  it('las funciones de pg_trgm se llaman calificadas con su esquema', () => {
    // Supabase instala las extensiones fuera de `public`. Llamarlas sin
    // calificar depende del search_path, y eso es exactamente lo que reventó
    // en julio de 2026 con digest() de pgcrypto.
    const ejecutable = sinComentarios(SQL)
    const sinCalificar = [...ejecutable.matchAll(/(?<!extensions\.)\b(similarity|unaccent)\s*\(/g)]
    expect(
      sinCalificar.map(m => m[1]),
      'Estas llamadas dependen del search_path en vez de calificar su esquema',
    ).toEqual([])
  })

  it('crea las extensiones en el esquema donde Supabase las pone', () => {
    for (const ext of ['pg_trgm', 'unaccent']) {
      expect(SQL, ext).toMatch(
        new RegExp(`create extension if not exists ${ext} with schema extensions`),
      )
    }
  })

  it('el índice de trigramas califica también su clase de operadores', () => {
    // `gin_trgm_ops` se resuelve por search_path al crear el índice.
    expect(SQL).toContain('extensions.gin_trgm_ops')
  })
})

describe('la búsqueda respeta lo que puede atender', () => {
  it('excluye lo que no puede recibir un pedido ahora', () => {
    // Encontrar un local que no puede atender es peor que no encontrar
    // ninguno: el cliente ya eligió y gastó un mensaje.
    const disponibles = SQL.slice(SQL.indexOf('disponibles as ('), SQL.indexOf('por_alias'))
    for (const condicion of ['b.active', 'b.suspended is not true', 'b.takes_orders', 'b.storefront_enabled']) {
      expect(disponibles, condicion).toContain(condicion)
    }
  })

  it('schema.sql y la migración dicen lo mismo', () => {
    for (const funcion of [
      'marketplace_normalizar_consulta',
      'marketplace_buscar_negocios',
      'marketplace_buscar_productos',
    ]) {
      expect(SCHEMA, funcion).toContain(`function public.${funcion}`)
    }
  })

  it('no recrea ninguna función del dinero', () => {
    expect(sinComentarios(SQL)).not.toMatch(/create_storefront_order|set_order_status/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Y AHORA SÍ LA LLAMA ALGUIEN (2026-08-25)
//
// Hasta esta fecha la búsqueda estaba CONSTRUIDA Y DESCONECTADA: tres capas,
// su migración, sus pruebas… y ni un llamador fuera de su repositorio.
// `marketplace-entry.ts` no la mencionaba, así que «quiero ceviche» recibía
// «🙏 No te entendí» aunque la base supiera resolverlo. Octavo caso del
// patrón; por eso estas pruebas ejercen la función REAL, no leen el archivo.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]
const CEVICHERIA = { id: 'biz-9', slug: 'el-puerto', name: 'El Puerto', type: 'marisquería' }

const armarEntrada = ({ hits = [], buscar, conocido = null } = {}) => {
  const conversacion = { valor: null }
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
    getConversation: vi.fn(async () => conversacion.valor),
    advanceConversation: vi.fn(async (_id, patch) => {
      conversacion.valor = {
        current_state: patch.state || 'navegando',
        selected_business_id: patch.clearBusiness ? null : (patch.businessId ?? null),
        shopping_locked: Boolean(patch.shoppingLocked),
        flow_state: patch.flowState ?? null,
        version: (conversacion.valor?.version || 0) + 1,
      }
      return { conflicto: false }
    }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([
      { id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 },
    ]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-9', name: 'El Puerto', slug: 'el-puerto',
      storefront_enabled: true, takes_orders: true,
    }),
    getPolicies: vi.fn().mockResolvedValue({ welcome_message: null }),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    isPlatformBlocked: vi.fn().mockResolvedValue(false),
    claimBlockedNotice: vi.fn().mockResolvedValue(false),
    searchMarketplaceBusinesses: buscar || vi.fn().mockResolvedValue(hits),
    marketplaceKnownTerm: vi.fn().mockResolvedValue(conocido),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn().mockResolvedValue('https://umbani.test/s/token'),
      tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(), crearPedido: vi.fn(), crearPedidoCompleto: vi.fn(),
    },
  }
}

const escribir = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000825', text: texto }, deps)
}

describe('la búsqueda, conectada al flujo', () => {
  it('«quiero ceviche» encuentra el local en vez de reprochar', async () => {
    const { deps, enviados, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')

    expect(database.searchMarketplaceBusinesses).toHaveBeenCalledWith('quiero ceviche', 9)
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toContain('No te entendí')
    // El local va en las OPCIONES: en WhatsApp es una fila de la lista, no
    // texto del mensaje.
    expect(enviados.flatMap(e => e.options)).toContain('El Puerto')
    // Se dice QUÉ se buscó: si no, una lista de locales tras escribir una
    // frase parece que el bot cambió de tema.
    expect(texto).toContain('quiero ceviche')
  })

  // El menú MANDA. Si se buscara primero, quien está eligiendo de la lista
  // acabaría en una búsqueda de texto libre.
  it('elegir del menú NO dispara la búsqueda', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, '🍕 Pizzerías')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  it('tocar un resultado entra en ese local, como si viniera del menú', async () => {
    const { deps, enviados } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, 'quiero ceviche')
    enviados.length = 0
    await escribir(deps, 'El Puerto')

    expect(deps.issueLink).toHaveBeenCalled()
    expect(enviados.map(e => e.reply).join('')).toContain('umbani.test/s/token')
  })

  // Sin resultados, el cliente recibe exactamente lo de antes.
  it('si no encuentra nada, responde como siempre', async () => {
    const { deps, enviados } = armarEntrada({ hits: [] })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero sushi de wagyu')
    expect(enviados.map(e => e.reply).join('')).toContain('No te entendí')
  })

  // La búsqueda es una MEJORA sobre «no te entendí»: un fallo suyo no puede
  // dejar al cliente sin respuesta.
  it('si la búsqueda revienta, el cliente recibe su respuesta igual', async () => {
    const { deps, enviados } = armarEntrada({
      buscar: vi.fn().mockRejectedValue(new Error('trigramas caídos')),
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')
    expect(enviados.map(e => e.reply).join('')).toContain('No te entendí')
  })

  // Dentro de un local el ámbito es ese local: traerle el ceviche de otro
  // negocio metería en el carrito un producto que no puede estar ahí.
  it('con local elegido NO busca en todo el marketplace', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    await escribir(deps, '🍕 Pizzerías')
    await escribir(deps, 'Monster Pizza')
    database.searchMarketplaceBusinesses.mockClear()
    await escribir(deps, 'quiero ceviche')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  // Un saludo no es una búsqueda: no se gasta una consulta en «hola».
  it('un saludo no dispara la búsqueda', async () => {
    const { deps, database } = armarEntrada({ hits: [CEVICHERIA] })
    await escribir(deps, 'hola')
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «NO TE ENTENDÍ» vs «TE ENTIENDO, PERO NO LO TENGO» (2026-08-25)
//
// El dueño lo probó y lo vio: escribir «pollo» devolvía «🙏 No te entendí».
// Y «pollo» SE ENTIENDE — el alias existe y apunta a `asados`; lo que falta es
// un asadero dado de alta. Llamarle tonto a quien escribió bien es de las
// cosas que hacen que una app parezca tonta, y le pasa justo al cliente que
// sabe lo que quiere.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuando se entiende pero no hay locales', () => {
  it('lo dice con su nombre, y ofrece lo que sí hay', async () => {
    const { deps, enviados } = armarEntrada({ hits: [], conocido: 'Asados y parrilladas' })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero pollo asado')

    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toContain('No te entendí')
    expect(texto).toContain('Asados y parrilladas')
    // No es una calle sin salida: se le enseña lo que sí puede pedir.
    expect(enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })

  // Una tontería SÍ merece «no te entendí»: ahí no hay nada que ofrecer que
  // tenga que ver con lo que escribió.
  it('una tontería sigue recibiendo «no te entendí»', async () => {
    const { deps, enviados } = armarEntrada({ hits: [], conocido: null })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'asdfghjkl')
    expect(enviados.map(e => e.reply).join('')).toContain('No te entendí')
  })

  // Primero se busca de verdad: si hay locales, se enseñan. Este mensaje es
  // solo para cuando la búsqueda vino vacía.
  it('con resultados NO se dice que no hay', async () => {
    const { deps, enviados } = armarEntrada({
      hits: [CEVICHERIA], conocido: 'Mariscos y ceviches',
    })
    await escribir(deps, 'hola')
    enviados.length = 0
    await escribir(deps, 'quiero ceviche')
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).not.toMatch(/Todavía no tenemos/)
    expect(enviados.flatMap(e => e.options)).toContain('El Puerto')
  })

  // Falla hacia el mensaje de siempre: esto es una mejora del trato, no un
  // camino del que dependa la respuesta.
  it('si el diccionario revienta, responde como antes', async () => {
    const m = armarEntrada({ hits: [] })
    m.database.marketplaceKnownTerm = vi.fn().mockRejectedValue(new Error('caído'))
    await escribir(m.deps, 'hola')
    m.enviados.length = 0
    await escribir(m.deps, 'quiero pollo')
    expect(m.enviados.map(e => e.reply).join('')).toContain('No te entendí')
  })
})

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
const SQL = readFileSync(`${serverDir}/migration-2026-08-21-busqueda-del-marketplace.sql`, 'utf8')
const SCHEMA = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const sinComentarios = sql => sql.replace(/--[^\n]*/g, '')

afterEach(() => { vi.restoreAllMocks() })

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

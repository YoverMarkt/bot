#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ¿ESTE RESPALDO SIRVE DE ALGO?
// ═══════════════════════════════════════════════════════════════════════════
//
// Un `pg_dump` que termina en 0 no garantiza nada: puede haber volcado un
// esquema vacío, la mitad de las tablas, o conectado a la base equivocada. El
// día que haga falta restaurar no es el día de descubrirlo.
//
// Esto lee el inventario del dump (`pg_restore -l`) y exige que estén las
// tablas sin las cuales la plataforma no existe. Es la misma idea que el
// verificador de esquema: comprobar que la red DETECTA algo, no solo que corre.
//
// ⚠️ Nació el 2026-09-23, después de 39 horas con la base de producción caída
// y con el respaldo más reciente de hacía UN MES: el comando existía y
// funcionaba, pero no lo ejecutaba nadie.

/**
 * Las tablas que, si faltan, hacen inútil el respaldo.
 *
 * ⚠️ Es una lista CORTA y a propósito. Enumerar las 50 obligaría a tocar este
 * archivo cada vez que nace una tabla, y acabaría desactivándose. Estas seis
 * son el negocio: quién vende, qué vende, qué le pidieron, qué se cobró y
 * quién entra al panel.
 */
export const IMPRESCINDIBLES = [
  'businesses',
  'products',
  'orders',
  'order_items',
  'sales',
  'client_users',
]

/**
 * Cuántas tablas CON DATOS debe traer como mínimo.
 *
 * El esquema ronda las 90; se exige bastante menos para no romper el respaldo
 * cada vez que se añade una tabla vacía, pero lo suficiente para que un dump a
 * medias no pase por bueno.
 */
export const MINIMO_TABLAS = 30

/**
 * Las tablas que trae un inventario de `pg_restore -l`.
 *
 * Sus líneas son del tipo:
 *   `4321; 0 16543 TABLE DATA public businesses postgres`
 */
export const tablasDelInventario = (listado) => {
  const encontradas = []
  for (const linea of String(listado || '').split('\n')) {
    const m = /TABLE DATA\s+(\S+)\s+(\S+)/.exec(linea)
    if (m) encontradas.push(m[2])
  }
  return encontradas
}

/**
 * ¿Sirve este respaldo?
 *
 * Devuelve los problemas en vez de lanzar: quien llama decide si avisar o
 * fallar, igual que hace el vigía.
 */
export const revisarRespaldo = (listado, { minimo = MINIMO_TABLAS } = {}) => {
  const tablas = tablasDelInventario(listado)
  const problemas = []

  if (tablas.length === 0) {
    problemas.push('El respaldo no trae NINGUNA tabla con datos: está vacío.')
    return { sano: false, tablas, problemas }
  }

  const faltan = IMPRESCINDIBLES.filter(t => !tablas.includes(t))
  if (faltan.length > 0) {
    problemas.push(
      `Faltan tablas sin las que el respaldo no sirve: ${faltan.join(', ')}.`,
    )
  }

  if (tablas.length < minimo) {
    problemas.push(
      `Solo ${tablas.length} tablas con datos; se esperaban al menos ${minimo}. `
      + 'Puede ser un volcado a medias o contra la base equivocada.',
    )
  }

  return { sano: problemas.length === 0, tablas, problemas }
}

// ── Como programa: lee el inventario por la entrada estándar ───────────────
//
// Se usa así en el workflow:  pg_restore -l respaldo.dump | node este-archivo
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  let entrada = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', trozo => { entrada += trozo })
  process.stdin.on('end', () => {
    const { sano, tablas, problemas } = revisarRespaldo(entrada)
    console.log(`📦 Tablas con datos en el respaldo: ${tablas.length}`)
    if (sano) {
      console.log('✅ El respaldo trae todo lo imprescindible.')
      process.exit(0)
    }
    for (const p of problemas) console.error(`❌ ${p}`)
    process.exit(1)
  })
}

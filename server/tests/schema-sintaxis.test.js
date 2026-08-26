import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// UNA CADENA SIN CERRAR TUMBA EL ESQUEMA ENTERO
//
// Pasó DOS veces el 2026-08-25 editando `schema.sql` con expresiones
// regulares: un `[^;]*` cortó en el primer `;` —que estaba en mitad del texto
// del comentario— y dejó el resto colgando detrás del cierre. La cadena quedó
// abierta y psql interpretó un `\D` legítimo de 2.300 líneas MÁS ABAJO como si
// fuera un comando suyo: «invalid command \D».
//
// El error apunta lejísimos de la causa y cuesta un ciclo entero de CI
// descubrirlo. Esta prueba lo caza en 20 ms.
// ═══════════════════════════════════════════════════════════════════════════

const leer = (n) => readFileSync(fileURLToPath(new URL(`../${n}`, import.meta.url)), 'utf8')

/**
 * Recorre el SQL como lo haría psql: salta comentarios de línea y cuerpos
 * `$$…$$`, y va marcando si está dentro de una cadena. Devuelve la línea donde
 * quedó abierta, o `null` si todas cierran.
 */
const cadenaSinCerrar = (sql) => {
  let i = 0, linea = 1, dentro = false, abreEn = null
  while (i < sql.length) {
    if (sql[i] === '\n') linea += 1
    if (!dentro && sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    // El cuerpo de una función va entre `$$` y ahí las comillas son suyas.
    if (!dentro && sql.startsWith('$$', i)) {
      const fin = sql.indexOf('$$', i + 2)
      if (fin === -1) break
      for (let k = i; k < fin; k += 1) if (sql[k] === '\n') linea += 1
      i = fin + 2
      continue
    }
    if (sql[i] === "'") {
      // `''` es una comilla escapada dentro de la cadena, no un cierre.
      if (dentro && sql[i + 1] === "'") { i += 2; continue }
      dentro = !dentro
      if (dentro) abreEn = linea
    }
    i += 1
  }
  return dentro ? abreEn : null
}

describe('la sintaxis del SQL versionado', () => {
  const archivos = ['schema.sql', 'tests/sql/verificar-esquema.sql']

  for (const archivo of archivos) {
    it(`${archivo}: todas las cadenas cierran`, () => {
      const abierta = cadenaSinCerrar(leer(archivo))
      expect(abierta, abierta ? `cadena sin cerrar abierta en la línea ${abierta}` : '').toBeNull()
    })
  }

  // El detector tiene que detectar: si se rompe, deja de proteger en silencio.
  it('el detector reconoce una cadena sin cerrar', () => {
    expect(cadenaSinCerrar("comment on column x is 'sin cerrar;")).toBe(1)
    expect(cadenaSinCerrar("comment on column x is 'cerrada';")).toBeNull()
    // Una comilla escapada no abre nada.
    expect(cadenaSinCerrar("select 'no ''rompe'' esto';")).toBeNull()
    // Ni las comillas dentro del cuerpo de una función.
    expect(cadenaSinCerrar("create function f() as $$ begin return 'x'; end; $$;")).toBeNull()
  })
})

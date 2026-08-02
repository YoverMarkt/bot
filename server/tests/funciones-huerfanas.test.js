import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// GUARDIÁN DE FUNCIONES DE BASE DE DATOS QUE SOBRAN O NO CUADRAN
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace de una pregunta del dueño del SaaS el 2026-08-02: «todo lo que se borra
// o el código viejo, ¿ya no existe en mi sistema? ¿se está verificando?».
//
// La respuesta entonces era «a mano». Esto lo automatiza, y cubre los dos
// riesgos reales de cambiar funciones en PostgreSQL:
//
//  1. CAMBIAR UNA FIRMA Y NO RETIRAR LA VIEJA. `create or replace` con un
//     parámetro nuevo NO reemplaza: crea una SEGUNDA función con el mismo
//     nombre. Las dos quedan vivas y cualquier llamada se vuelve ambigua.
//     Ese mismo día, cuatro `grant` quedaron nombrando una firma que ya no
//     existía y el esquema dejó de aplicarse en una base limpia.
//
//  2. FUNCIONES QUE YA NO LLAMA NADIE. Se quedan en la base como código
//     muerto que alguien puede invocar por error años después.
//
// El otro guardián (`rpc-cobertura`) mira lo contrario: que todo lo que el
// servidor LLAMA esté probado. Este mira que todo lo que EXISTE tenga dueño.

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const schema = readFileSync(path.join(serverDir, 'schema.sql'), 'utf8')

/** Todo el TypeScript del servidor, sin bajar a dist ni a node_modules. */
function archivosFuente(dir) {
  return readdirSync(dir).flatMap((entrada) => {
    if (entrada === 'node_modules' || entrada === 'dist') return []
    const completa = path.join(dir, entrada)
    if (statSync(completa).isDirectory()) return archivosFuente(completa)
    return entrada.endsWith('.ts') ? [readFileSync(completa, 'utf8')] : []
  })
}
const fuente = archivosFuente(path.join(serverDir, 'src')).join('\n')

/** Las líneas de comentario no cuentan: nombrar algo no es usarlo. */
const sinComentarios = schema
  .split('\n')
  .filter(linea => !linea.trimStart().startsWith('--'))
  .join('\n')

/** Nombre y número de parámetros de cada función declarada en el esquema. */
const definidas = [...sinComentarios.matchAll(
  /create or replace function\s+(?:public\.)?([a-z_]+)\s*\(([^)]*)\)/gi,
)].map(([, nombre, parametros]) => ({
  nombre: nombre.toLowerCase(),
  argumentos: parametros.trim() ? parametros.split(',').length : 0,
}))

/** Cada revoke/grant, con la firma que dice estar tocando. */
const permisos = [...sinComentarios.matchAll(
  /(?:revoke all|grant execute)\s+on function\s+(?:public\.)?([a-z_]+)\s*\(([^)]*)\)/gi,
)].map(([, nombre, parametros]) => ({
  nombre: nombre.toLowerCase(),
  argumentos: parametros.trim() ? parametros.split(',').length : 0,
}))

describe('funciones de base de datos sin dueño', () => {
  it('encuentra las funciones del esquema (si no, todo lo demás pasaría en falso)', () => {
    expect(definidas.length).toBeGreaterThanOrEqual(20)
    expect(definidas.map(f => f.nombre)).toContain('set_order_status')
  })

  // El fallo exacto del 2026-08-02: el grant nombraba 7 argumentos y la
  // función ya tenía 8, así que `psql` abortaba al aplicar el esquema.
  it('cada permiso nombra una firma que existe de verdad', () => {
    const desajustados = permisos.filter(permiso => !definidas.some(
      definida => definida.nombre === permiso.nombre
        && definida.argumentos === permiso.argumentos,
    ))

    expect(
      desajustados,
      desajustados.length
        ? 'Estos revoke/grant apuntan a una firma que el esquema no define:\n'
          + `${desajustados.map(d => `  · ${d.nombre} con ${d.argumentos} argumentos`).join('\n')}\n\n`
          + 'Suele significar que se añadió un parámetro y el permiso se quedó\n'
          + 'con la firma vieja. PostgreSQL falla al aplicar el esquema entero.'
        : '',
    ).toEqual([])
  })

  // Una función que no llama ni el servidor, ni un disparador, ni otra
  // función, es código muerto esperando a que alguien lo invoque por error.
  it('ninguna función del esquema se quedó sin quien la llame', () => {
    const huerfanas = definidas.filter(({ nombre }) => {
      // ¿La llama el servidor? El nombre puede ir en la línea siguiente, que
      // es como se escapaba la mitad de las llamadas del guardián hermano.
      if (new RegExp(`'${nombre}'`).test(fuente)) return false

      // ¿La llama alguien dentro del propio esquema? Se buscan LLAMADAS, no
      // apariciones del nombre: declararla o darle permisos no es usarla, y
      // contar ocurrencias a bulto daba falsos positivos.
      const apariciones = [...sinComentarios.matchAll(
        new RegExp(`(?:public\\.)?${nombre}\\s*\\(`, 'g'),
      )]
      return !apariciones.some((coincidencia) => {
        const contexto = sinComentarios.slice(
          Math.max(0, coincidencia.index - 60), coincidencia.index,
        )
        // Declararla o darle permisos NO es usarla. Pero `execute function X()`
        // —como la cuelga un disparador— sí lo es, y confundir las dos cosas
        // marcaba como muertas todas las funciones de trigger del proyecto.
        const esDeclaracion = /create or replace function\s+(?:public\.)?$/i.test(contexto)
        const esPermiso = /on function\s+(?:public\.)?$/i.test(contexto)
        return !esDeclaracion && !esPermiso
      })
    })

    expect(
      huerfanas.map(f => f.nombre),
      huerfanas.length
        ? 'Estas funciones existen en el esquema pero no las llama nadie —ni el\n'
          + 'servidor, ni un disparador, ni otra función. O se usan y falta\n'
          + 'declararlo, o sobran y hay que retirarlas de la base:\n'
          + `${huerfanas.map(f => `  · ${f.nombre}`).join('\n')}`
        : '',
    ).toEqual([])
  })
})

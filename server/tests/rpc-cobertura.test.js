import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// GUARDIÁN DE COBERTURA DE FUNCIONES DE BASE DE DATOS
//
// Nace del 2 de agosto de 2026, cuando se descubrió que NINGÚN cliente nuevo
// se podía crear. El fallo llevaba meses ahí: `create_business_onboarding`
// reventaba siempre, pero nadie había dado de alta a nadie desde la migración
// que lo rompió.
//
// El problema de fondo no era ese disparador. Era que la verificación contra
// PostgreSQL real —que existe precisamente para esto— cubría lo que alguien se
// había acordado de añadir. Y nadie se acuerda de lo que aún no ha visto fallar.
//
// Este test invierte la carga: en vez de una lista que mantener a mano, LEE el
// código, encuentra cada función de base de datos que el servidor llama, y
// exige que la verificación la ejecute al menos una vez. Añade una función
// nueva y el CI te para hasta que la pruebes.
//
// ⚠️ Recordatorio del porqué: PostgreSQL acepta `create function` y
// `create trigger` SIN comprobar que funcionen. El SQL se aplica "con éxito" y
// el fallo aparece la primera vez que alguien lo usa de verdad. Leer el SQL no
// basta: hay que EJECUTARLO.

const serverDir = fileURLToPath(new URL('..', import.meta.url))

/** Todos los .ts del servidor, sin bajar a dist ni a node_modules. */
function archivosFuente(dir) {
  return readdirSync(dir).flatMap((entrada) => {
    if (entrada === 'node_modules' || entrada === 'dist') return []
    const completa = path.join(dir, entrada)
    if (statSync(completa).isDirectory()) return archivosFuente(completa)
    return entrada.endsWith('.ts') ? [completa] : []
  })
}

const fuente = archivosFuente(path.join(serverDir, 'src'))
  .map(archivo => readFileSync(archivo, 'utf8'))
  .join('\n')

/**
 * Extrae los nombres de `db.rpc('...')`.
 *
 * El `\s*` NO es decorativo: al medir esto por primera vez salieron 10
 * funciones, y resultó que eran 20 — la mitad se llamaban con el nombre en la
 * línea siguiente y el patrón ingenuo no las veía. Un contador que miente por
 * la mitad es peor que no contar.
 */
// ⚠️ El rango incluye DÍGITOS desde 2026-08-02: sin ellos, cualquier función
// con número en el nombre —`set_lodging_request_status_v2`— se escapaba de la
// cobertura obligatoria sin que nadie se enterara. Justo el tipo de agujero
// que este guardián existe para tapar.
const llamadas = [...fuente.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)]
  .map(coincidencia => coincidencia[1])

const usadas = [...new Set(llamadas)].sort()

const verificaciones = ['verificar-esquema.sql', 'verificar-aislamiento.sql']
  .map(nombre => readFileSync(path.join(serverDir, 'tests/sql', nombre), 'utf8'))
  .join('\n')

/** Ejecutada = aparece como llamada real, no mencionada en un comentario. */
const seEjecuta = nombre => new RegExp(`\\b${nombre}\\s*\\(`).test(
  verificaciones
    // Los comentarios no cuentan: nombrar una función no es probarla.
    .split('\n')
    .filter(linea => !linea.trimStart().startsWith('--'))
    .join('\n'),
)

describe('cobertura de las funciones de base de datos', () => {
  it('encuentra las llamadas del servidor, también las multilínea', () => {
    // Si este número cae en picado, el extractor se rompió y todo lo demás
    // pasaría en falso.
    expect(usadas.length).toBeGreaterThanOrEqual(20)
    expect(usadas).toContain('create_business_onboarding')
    // Ésta se llama con el nombre en otra línea: es el caso que se escapaba.
    // Desde 2026-08-02 el servidor llama a la v2, que envuelve a la original
    // para registrar la venta al confirmar sin tocar el anti-sobreventa.
    expect(usadas).toContain('set_lodging_request_status_v2')
  })

  // El test que impide que vuelva a pasar lo del 2 de agosto.
  it('la verificación contra PostgreSQL real EJECUTA todas', () => {
    const sinProbar = usadas.filter(nombre => !seEjecuta(nombre))
    expect(
      sinProbar,
      sinProbar.length
        ? `Estas funciones se llaman en producción pero ninguna prueba las ejecuta:\n`
          + `${sinProbar.map(nombre => `  · ${nombre}`).join('\n')}\n\n`
          + `Añádelas a server/tests/sql/verificar-esquema.sql. PostgreSQL acepta\n`
          + `una función rota sin avisar: si nadie la ejecuta, el primero en\n`
          + `descubrirlo será un cliente.`
        : '',
    ).toEqual([])
  })

  // Nombrar una función en un comentario no es probarla, y sería la forma más
  // fácil de silenciar este guardián sin darse cuenta.
  it('no se conforma con mencionarlas en un comentario', () => {
    expect(seEjecuta('funcion_que_no_existe_en_ninguna_parte')).toBe(false)
  })
})

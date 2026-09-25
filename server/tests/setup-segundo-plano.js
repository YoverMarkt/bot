import { afterAll, afterEach } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { esperarSegundoPlano } = require('../dist/lib/segundo-plano.js')

// ═══════════════════════════════════════════════════════════════════════════
// NINGUNA PRUEBA SE CIERRA CON TRABAJO SUELTO
// ═══════════════════════════════════════════════════════════════════════════
//
// El CI se ponía rojo solo, una de cada cuatro veces, con todas las pruebas en
// verde: `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
// pending`. Un registro lanzado sin esperar (el de errores, el paso del menú,
// el índice de un producto) terminaba DESPUÉS de su prueba y escribía en la
// consola cuando vitest ya estaba cerrando el proceso. Ver `lib/segundo-plano`.
//
// Aquí se espera lo que quedó en vuelo al cerrar cada prueba, y otra vez al
// cerrar el archivo por si algo arrancó después del último `afterEach`.
//
// ⚠️ Con un TOPE de tiempo, y con el `setTimeout` de verdad guardado al
// cargar: tres archivos usan relojes falsos, y una tarea colgada no puede
// convertir el arreglo de una prueba inestable en una prueba que se cuelga.

const esperaReal = globalThis.setTimeout
const TOPE_MS = 5_000

const esperarConTope = () => Promise.race([
  esperarSegundoPlano(),
  new Promise(resolve => esperaReal(resolve, TOPE_MS)),
])

afterEach(esperarConTope)
afterAll(esperarConTope)

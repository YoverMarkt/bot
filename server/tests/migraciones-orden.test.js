import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  excepcionesDeBaseline,
  ordenarNombresDeMigracion,
  seleccionarMigracionesParaAplicar,
  seleccionarMigracionesParaBaseline,
  validarArgumentosCli,
} from './migraciones.mjs'

const EJECUTOR = fileURLToPath(new URL('./migraciones.mjs', import.meta.url))

describe('orden del ejecutor de migraciones', () => {
  // ⚠️ Las tres «fases de retiro» (hospedaje → citas → modo menú) que se
  // probaban aquí se retiraron el 2026-08-24. Las dos primeras están
  // aplicadas desde el 2026-08-16 y `retirar-modo-menu.sql` nunca existió
  // —la retirada real fue `retirar-el-modo-ia.sql`—, así que vigilaban un
  // orden ya ocurrido y un archivo fantasma. Umbani es solo domicilios.
  //
  // En su lugar van las dependencias REALES que CLAUDE.md documenta, y que
  // hasta hoy solo estaban insinuadas en el NOMBRE de los archivos.
  const CATEGORIAS = 'migration-2026-08-21-categorias-del-marketplace.sql'
  const BUSQUEDA = 'migration-2026-08-21-marketplace-busqueda.sql'
  const HUELLA = 'migration-2026-08-22-huella-del-comprobante.sql'
  const LECTURA = 'migration-2026-08-22-lectura-del-comprobante.sql'

  it('la búsqueda del marketplace corre DESPUÉS de las categorías', () => {
    // ⚠️ Se pasan al revés a propósito: el orden no puede depender de cómo
    // venga la lista del disco.
    expect(ordenarNombresDeMigracion([BUSQUEDA, CATEGORIAS]))
      .toEqual([CATEGORIAS, BUSQUEDA])
  })

  it('la lectura del comprobante corre DESPUÉS de su huella', () => {
    expect(ordenarNombresDeMigracion([LECTURA, HUELLA]))
      .toEqual([HUELLA, LECTURA])
  })

  it('las cuatro juntas conservan cada pareja en su orden', () => {
    expect(ordenarNombresDeMigracion([LECTURA, BUSQUEDA, HUELLA, CATEGORIAS]))
      .toEqual([CATEGORIAS, BUSQUEDA, HUELLA, LECTURA])
  })

  // ⚠️ HONESTIDAD SOBRE ESTAS PRUEBAS: hoy las cuatro también salen bien por
  // orden alfabético, porque se BAUTIZARON para eso —«se llama así para
  // ordenar DESPUÉS de las categorías, de las que depende», dice CLAUDE.md, y
  // avisa de que es la tercera vez que la trampa aparece y el CI no puede
  // verla—. Eso es exactamente la fragilidad que se está retirando: el día
  // que alguien renombre un archivo por claridad, el alfabeto deja de
  // salvarlo y estas pruebas son las que lo cazan.

  it('un requisito ausente se dice por su nombre, no se ignora', () => {
    // Sin esto, la migración corre igual y falla con un error que habla de
    // una tabla que no existe, en vez de decir lo que de verdad pasó.
    expect(() => ordenarNombresDeMigracion([BUSQUEDA])).toThrow(
      `depende de un archivo ausente: ${CATEGORIAS}`,
    )
    expect(() => ordenarNombresDeMigracion([LECTURA])).toThrow(
      `depende de un archivo ausente: ${HUELLA}`,
    )
  })

  it('las migraciones sin fecha van primero: son más viejas por definición', () => {
    expect(ordenarNombresDeMigracion([
      'migration-2026-08-15-ajuste.sql',
      'migration-negocios.sql',
    ])).toEqual([
      'migration-negocios.sql',
      'migration-2026-08-15-ajuste.sql',
    ])
  })

  it('una lista sin dependencias declaradas se ordena y no se toca', () => {
    expect(ordenarNombresDeMigracion([
      'migration-2026-08-26-minimo-y-avalancha.sql',
      'migration-2026-08-25-frenos-de-abuso.sql',
    ])).toEqual([
      'migration-2026-08-25-frenos-de-abuso.sql',
      'migration-2026-08-26-minimo-y-avalancha.sql',
    ])
  })
})

describe('selección de una migración exacta', () => {
  const pendientes = [
    { name: 'migration-2026-08-24-techo-del-marketplace.sql' },
    { name: 'migration-2026-08-25-frenos-de-abuso.sql' },
    { name: 'migration-2026-08-26-minimo-y-avalancha.sql' },
  ]

  it('sin --solo conserva la aplicación de todas las pendientes', () => {
    expect(seleccionarMigracionesParaAplicar(pendientes)).toEqual(pendientes)
  })

  it('selecciona únicamente el objetivo cuando es la primera pendiente', () => {
    expect(seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-24-techo-del-marketplace.sql',
    )).toEqual([{ name: 'migration-2026-08-24-techo-del-marketplace.sql' }])
  })

  it('permite la siguiente cuando la anterior ya está aplicada', () => {
    const despuesDeLaPrimera = pendientes.slice(1)
    expect(seleccionarMigracionesParaAplicar(
      despuesDeLaPrimera,
      'migration-2026-08-25-frenos-de-abuso.sql',
    )).toEqual([{ name: 'migration-2026-08-25-frenos-de-abuso.sql' }])
  })

  it('rechaza adelantar una migración que tiene otra pendiente delante', () => {
    expect(() => seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-25-frenos-de-abuso.sql',
    )).toThrow('la primera migración pendiente es migration-2026-08-24-techo-del-marketplace.sql')
  })

  it('rechaza un objetivo que no está pendiente', () => {
    expect(() => seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-30-inexistente.sql',
    )).toThrow('no está pendiente')
  })
})

describe('argumentos del ejecutor', () => {
  it('acepta únicamente las opciones conocidas por cada comando', () => {
    expect(validarArgumentosCli(['status'])).toBe('status')
    expect(validarArgumentosCli(['baseline', '--si', '--excepto=una.sql'])).toBe('baseline')
    expect(validarArgumentosCli(['apply', '--solo=una.sql'])).toBe('apply')
  })

  it('rechaza un typo para que nunca termine aplicando todas las pendientes', () => {
    expect(() => validarArgumentosCli([
      'apply', '--sollo=migration-2026-08-24-techo-del-marketplace.sql',
    ])).toThrow('Argumento desconocido')
  })

  it('rechaza múltiples --solo aunque apunten al mismo archivo', () => {
    expect(() => validarArgumentosCli([
      'apply', '--solo=una.sql', '--solo=una.sql',
    ])).toThrow('solo admite un --solo')
  })

  it('rechaza opciones de otro comando y argumentos posicionales extra', () => {
    expect(() => validarArgumentosCli(['apply', '--si'])).toThrow('Argumento desconocido')
    expect(() => validarArgumentosCli(['apply', 'otra-cosa'])).toThrow('Argumento desconocido')
  })

  it('rechaza --solo vacío', () => {
    expect(() => validarArgumentosCli(['apply', '--solo='])).toThrow('Argumento desconocido')
  })

  it('rechaza exclusiones baseline ambiguas o vacías antes de conectar', () => {
    expect(() => validarArgumentosCli([
      'baseline', '--excepto=una.sql', '--excepto=otra.sql',
    ])).toThrow('solo admite un --excepto')
    expect(() => validarArgumentosCli(['baseline', '--excepto=,'])).toThrow(
      'exige al menos una migración',
    )
    expect(() => validarArgumentosCli(['baseline', '--excepto=una.sql,una.sql'])).toThrow(
      'no admite migraciones repetidas',
    )
  })

  it('rechaza argumentos inválidos antes de intentar conectar a Postgres', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([nombre]) => nombre !== 'DATABASE_URL'),
    )
    const resultado = spawnSync(
      process.execPath,
      [EJECUTOR, 'apply', '--sollo=migration.sql'],
      { encoding: 'utf8', env },
    )

    expect(resultado.status).toBe(1)
    expect(resultado.stderr).toContain('Argumento desconocido para apply')
    expect(`${resultado.stdout}\n${resultado.stderr}`).not.toContain('Falta DATABASE_URL')
  })
})

describe('exclusiones de baseline', () => {
  const pendientes = [
    { name: 'migration-2026-08-24-techo-del-marketplace.sql' },
    { name: 'migration-2026-08-25-frenos-de-abuso.sql' },
    { name: 'migration-2026-08-26-minimo-y-avalancha.sql' },
  ]

  it('interpreta una sola lista separada por comas', () => {
    expect(excepcionesDeBaseline([
      '--excepto=migration-2026-08-25-frenos-de-abuso.sql, migration-2026-08-26-minimo-y-avalancha.sql',
    ])).toEqual([
      'migration-2026-08-25-frenos-de-abuso.sql',
      'migration-2026-08-26-minimo-y-avalancha.sql',
    ])
  })

  it('rechaza excluir un archivo inexistente antes de registrar nada', () => {
    expect(() => seleccionarMigracionesParaBaseline(
      pendientes,
      ['migration-2026-08-16-typo.sql'],
    )).toThrow('no está pendiente')
  })

  it('no permite baselinear algo cuyo requisito queda pendiente', () => {
    // El caso: se excluyen las CATEGORÍAS —así que siguen pendientes— pero la
    // BÚSQUEDA, que depende de ellas, se marcaría como aplicada. Quedaría
    // invisible para siempre sobre una base que no tiene sus categorías, y el
    // ejecutor no volvería a proponerla nunca.
    //
    // ⚠️ Esta es la guarda que me faltó hoy al sanear el registro a mano: un
    // typo en el `--excepto=` habría marcado como aplicada una migración que
    // nunca corrió.
    expect(() => seleccionarMigracionesParaBaseline(
      [
        { name: 'migration-2026-08-21-categorias-del-marketplace.sql' },
        { name: 'migration-2026-08-21-marketplace-busqueda.sql' },
      ],
      ['migration-2026-08-21-categorias-del-marketplace.sql'],
    )).toThrow('queda pendiente su requisito')
  })

  it('permite excluir una cola final coherente', () => {
    expect(seleccionarMigracionesParaBaseline(
      pendientes,
      [
        'migration-2026-08-25-frenos-de-abuso.sql',
        'migration-2026-08-26-minimo-y-avalancha.sql',
      ],
    )).toEqual([{ name: 'migration-2026-08-24-techo-del-marketplace.sql' }])
  })
})

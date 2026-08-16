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
  it('respeta las tres fases de retiro aunque compartan fecha', () => {
    const nombres = [
      'migration-2026-08-16-retirar-modo-menu.sql',
      'migration-2026-08-16-retirar-hospedaje.sql',
      'migration-2026-08-16-retirar-citas.sql',
    ]

    expect(ordenarNombresDeMigracion(nombres)).toEqual([
      'migration-2026-08-16-retirar-hospedaje.sql',
      'migration-2026-08-16-retirar-citas.sql',
      'migration-2026-08-16-retirar-modo-menu.sql',
    ])
  })

  it('no exige las fases mientras aún no existan en disco', () => {
    expect(ordenarNombresDeMigracion([
      'migration-2026-08-15-ajuste.sql',
      'migration-negocios.sql',
    ])).toEqual([
      'migration-negocios.sql',
      'migration-2026-08-15-ajuste.sql',
    ])
  })

  it.each([
    [
      ['migration-2026-08-16-retirar-citas.sql'],
      'migration-2026-08-16-retirar-hospedaje.sql',
    ],
    [
      ['migration-2026-08-16-retirar-modo-menu.sql'],
      'migration-2026-08-16-retirar-citas.sql',
    ],
  ])('falla si una fase existe pero falta %s', (nombres, requisito) => {
    expect(() => ordenarNombresDeMigracion(nombres)).toThrow(
      `depende de un archivo ausente: ${requisito}`,
    )
  })
})

describe('selección de una migración exacta', () => {
  const pendientes = [
    { name: 'migration-2026-08-16-retirar-hospedaje.sql' },
    { name: 'migration-2026-08-16-retirar-citas.sql' },
    { name: 'migration-2026-08-16-retirar-modo-menu.sql' },
  ]

  it('sin --solo conserva la aplicación de todas las pendientes', () => {
    expect(seleccionarMigracionesParaAplicar(pendientes)).toEqual(pendientes)
  })

  it('selecciona únicamente el objetivo cuando es la primera pendiente', () => {
    expect(seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-16-retirar-hospedaje.sql',
    )).toEqual([{ name: 'migration-2026-08-16-retirar-hospedaje.sql' }])
  })

  it('permite la fase siguiente cuando la anterior ya está aplicada', () => {
    const despuesDeHospedaje = pendientes.slice(1)
    expect(seleccionarMigracionesParaAplicar(
      despuesDeHospedaje,
      'migration-2026-08-16-retirar-citas.sql',
    )).toEqual([{ name: 'migration-2026-08-16-retirar-citas.sql' }])
  })

  it('rechaza adelantar una fase que todavía tiene una dependencia pendiente', () => {
    expect(() => seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-16-retirar-citas.sql',
    )).toThrow('la primera migración pendiente es migration-2026-08-16-retirar-hospedaje.sql')
  })

  it('rechaza un objetivo que no está pendiente', () => {
    expect(() => seleccionarMigracionesParaAplicar(
      pendientes,
      'migration-2026-08-16-inexistente.sql',
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
      'apply', '--sollo=migration-2026-08-16-retirar-hospedaje.sql',
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
    { name: 'migration-2026-08-16-retirar-hospedaje.sql' },
    { name: 'migration-2026-08-16-retirar-citas.sql' },
    { name: 'migration-2026-08-16-retirar-modo-menu.sql' },
  ]

  it('interpreta una sola lista separada por comas', () => {
    expect(excepcionesDeBaseline([
      '--excepto=migration-2026-08-16-retirar-citas.sql, migration-2026-08-16-retirar-modo-menu.sql',
    ])).toEqual([
      'migration-2026-08-16-retirar-citas.sql',
      'migration-2026-08-16-retirar-modo-menu.sql',
    ])
  })

  it('rechaza excluir un archivo inexistente antes de registrar nada', () => {
    expect(() => seleccionarMigracionesParaBaseline(
      pendientes,
      ['migration-2026-08-16-typo.sql'],
    )).toThrow('no está pendiente')
  })

  it('no permite baselinear una fase cuyo requisito queda pendiente', () => {
    expect(() => seleccionarMigracionesParaBaseline(
      pendientes,
      ['migration-2026-08-16-retirar-hospedaje.sql'],
    )).toThrow('queda pendiente su requisito')
  })

  it('permite excluir una cola final coherente', () => {
    expect(seleccionarMigracionesParaBaseline(
      pendientes,
      [
        'migration-2026-08-16-retirar-citas.sql',
        'migration-2026-08-16-retirar-modo-menu.sql',
      ],
    )).toEqual([{ name: 'migration-2026-08-16-retirar-hospedaje.sql' }])
  })
})

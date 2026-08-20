import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptRespaldo = fileURLToPath(new URL('./respaldo.mjs', import.meta.url))
const temporales = []

const DOCKER_SIMULADO = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const modo = process.env.DOCKER_SIMULADO_MODO
appendFileSync(process.env.DOCKER_SIMULADO_LOG, JSON.stringify(args) + '\\n')

if (args[0] === 'version') {
  process.stdout.write('27.0.0\\n')
  process.exit(0)
}

if (args.includes('pg_dump')) {
  if (modo === 'backup-exitoso') {
    process.stdout.write('volcado binario simulado')
    process.exit(0)
  }
  if (modo === 'dump-falla-con-detalle') {
    process.stderr.write('falló la conexión: ' + process.env.DATABASE_URL + '\\n')
    process.stderr.write('password=' + process.env.CLAVE_SIMULADA + '\\n')
  }
  process.exit(1)
}

if (args.includes('pg_restore')) {
  const erroresVault = [
    'pg_restore: error: could not execute query: ERROR:  extension "supabase_vault" is not available',
    'pg_restore: error: could not execute query: ERROR:  extension "supabase_vault" does not exist',
    'pg_restore: error: could not execute query: ERROR:  relation "vault.secrets" does not exist',
  ]
  if (modo === 'restore-con-error-extra') {
    erroresVault.push('pg_restore: error: could not execute query: ERROR:  permission denied for table orders')
  }
  process.stderr.write('pg_restore: while PROCESSING TOC:\\n')
  process.stderr.write(erroresVault.join('\\n') + '\\n')
  process.stderr.write('DETAIL: Could not open extension control file\\n')
  process.stderr.write('HINT: The extension must first be installed\\n')
  process.stderr.write('Command was: CREATE EXTENSION IF NOT EXISTS supabase_vault;\\n')
  if (modo === 'restore-con-fatal-extra') {
    process.stderr.write('pg_restore: fatal: could not reconnect to database\\n')
  }
  if (modo === 'restore-con-docker-extra') {
    process.stderr.write('Error response from daemon: container stopped unexpectedly\\n')
  }
  if (modo === 'restore-con-stdout-extra') {
    process.stdout.write('salida inesperada de docker exec\\n')
  }
  process.stderr.write(
    'pg_restore: warning: errors ignored on restore: '
      + (modo === 'restore-con-error-extra' ? '4' : '3')
      + '\\n',
  )
  if (modo === 'restore-con-signal') {
    process.kill(process.pid, 'SIGTERM')
  }
  if (modo === 'restore-status-dos') {
    process.exit(2)
  }
  process.exit(1)
}

if (args.includes('psql')) {
  const consulta = args.at(-1)
  if (consulta.includes('information_schema.tables') && consulta.includes('table_name=')) {
    const faltaProducts = modo === 'restore-falta-tabla' && consulta.includes("table_name='products'")
    process.stdout.write(faltaProducts ? '0\\n' : '1\\n')
  } else if (consulta.includes('information_schema.tables')) {
    process.stdout.write(modo === 'restore-pocas-tablas' ? '12\\n' : '51\\n')
  } else if (modo === 'restore-base-vacia' && consulta.includes('select count(*) from public.')) {
    process.stdout.write('0\\n')
  } else if (consulta.includes('public.businesses')) {
    process.stdout.write('1\\n')
  } else if (consulta.includes('public.products')) {
    process.stdout.write('8\\n')
  } else if (consulta.includes('public.orders')) {
    process.stdout.write('3\\n')
  } else if (consulta.includes('public.client_users')) {
    process.stdout.write('1\\n')
  } else {
    process.stdout.write('0\\n')
  }
  process.exit(0)
}

process.stdout.write('ok\\n')
`

const prepararDockerSimulado = () => {
  const directorio = mkdtempSync(path.join(tmpdir(), 'umbani-respaldo-test-'))
  temporales.push(directorio)
  const docker = path.join(directorio, 'docker')
  const dump = path.join(directorio, 'respaldo.dump')
  const registro = path.join(directorio, 'docker.log')
  writeFileSync(docker, DOCKER_SIMULADO)
  chmodSync(docker, 0o755)
  writeFileSync(dump, 'volcado simulado sin datos reales')
  return { directorio, dump, registro }
}

const ejecutar = ({ modo, comando, url, clave }) => {
  const { directorio, dump, registro } = prepararDockerSimulado()
  const args = [scriptRespaldo, comando]
  if (comando === 'verify') args.push(dump)
  const resultado = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKUP_DIR: directorio,
      CLAVE_SIMULADA: clave || '',
      DATABASE_URL: url,
      DOCKER_SIMULADO_LOG: registro,
      DOCKER_SIMULADO_MODO: modo,
      PATH: `${directorio}${path.delimiter}${process.env.PATH || ''}`,
    },
  })
  resultado.comandosDocker = readFileSync(registro, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(linea => JSON.parse(linea))
  resultado.directorioTemporal = directorio
  return resultado
}

const eliminoContenedor = resultado => resultado.comandosDocker.some(
  args => args[0] === 'rm' && args[1] === '-f' && args[2]?.startsWith('verificar-respaldo-'),
)

afterEach(() => {
  while (temporales.length) {
    rmSync(temporales.pop(), { recursive: true, force: true })
  }
})

describe('respaldo seguro', () => {
  it.each(['dump-falla-con-detalle', 'dump-falla-sin-detalle'])(
    'nunca imprime DATABASE_URL ni su contraseña si pg_dump falla (%s)',
    modo => {
      const clave = 'Clave/Simulada@2026?'
      const claveCodificada = encodeURIComponent(clave)
      const url = `postgresql://usuario:${claveCodificada}@db.example.test:5432/app`

      const resultado = ejecutar({ modo, comando: 'backup', url, clave })
      const salida = `${resultado.stdout}\n${resultado.stderr}`

      expect(resultado.status).toBe(1)
      expect(salida).not.toContain(url)
      expect(salida).not.toContain(claveCodificada)
      expect(salida).not.toContain(clave)
      expect(salida).toContain('DATABASE_URL y su contraseña se mantuvieron ocultas')
      if (modo === 'dump-falla-sin-detalle') {
        expect(salida).toContain('Command failed: docker')
        expect(salida).toContain('[REDACTADO]')
      }
    },
  )

  it('tolera únicamente los tres errores esperados de Supabase Vault y valida los datos', () => {
    const resultado = ejecutar({
      modo: 'restore-solo-vault',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })

    expect(resultado.status).toBe(0)
    expect(resultado.stdout).toContain('Avisos esperados: la imagen local no incluye Supabase Vault')
    expect(resultado.stdout).toContain('Tablas restauradas: 51')
    expect(resultado.stdout).toContain('businesses     1 fila(s)')
    expect(resultado.stdout).toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)

    const consultasNucleo = resultado.comandosDocker
      .filter(args => args.includes('psql') && args.at(-1).includes('table_name='))
      .map(args => args.at(-1))
    expect(consultasNucleo).toHaveLength(4)
    expect(consultasNucleo.every(consulta => consulta.includes("table_type='BASE TABLE'"))).toBe(true)
  })

  it('acepta las tablas núcleo vacías de una instalación nueva', () => {
    const resultado = ejecutar({
      modo: 'restore-base-vacia',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })

    expect(resultado.status).toBe(0)
    expect(resultado.stdout).toContain('businesses     0 fila(s)')
    expect(resultado.stdout).toContain('products       0 fila(s)')
    expect(resultado.stdout).toContain('El respaldo se restaura y trae el esquema completo')
  })

  it.each([
    ['restore-con-error-extra', 'permission denied for table orders'],
    ['restore-con-fatal-extra', 'could not reconnect to database'],
    ['restore-con-docker-extra', 'Error response from daemon'],
  ])('detiene la verificación ante cualquier diagnóstico adicional de pg_restore (%s)',
    (modo, diagnostico) => {
      const resultado = ejecutar({
        modo,
        comando: 'verify',
        url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
      })
      const salida = `${resultado.stdout}\n${resultado.stderr}`

      expect(resultado.status).toBe(1)
      expect(salida).toContain(diagnostico)
      expect(salida).not.toContain('Tablas restauradas')
      expect(salida).not.toContain('El respaldo se restaura y trae el esquema completo')
      expect(eliminoContenedor(resultado)).toBe(true)
    })

  it('rechaza un pg_restore terminado por señal aunque stderr parezca el indulto de Vault', () => {
    const resultado = ejecutar({
      modo: 'restore-con-signal',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })

    expect(resultado.status).toBe(1)
    expect(resultado.stdout).not.toContain('Tablas restauradas')
    expect(resultado.stdout).not.toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)
  })

  it('rechaza el indulto de Vault si pg_restore termina con un status distinto de 1', () => {
    const resultado = ejecutar({
      modo: 'restore-status-dos',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })

    expect(resultado.status).toBe(1)
    expect(resultado.stdout).not.toContain('Tablas restauradas')
    expect(resultado.stdout).not.toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)
  })

  it('rechaza el indulto de Vault si docker exec produjo stdout', () => {
    const resultado = ejecutar({
      modo: 'restore-con-stdout-extra',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })

    expect(resultado.status).toBe(1)
    expect(resultado.stdout).not.toContain('Tablas restauradas')
    expect(resultado.stdout).not.toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)
  })

  it('elimina el contenedor si la restauración trae menos de 30 tablas', () => {
    const resultado = ejecutar({
      modo: 'restore-pocas-tablas',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })
    const salida = `${resultado.stdout}\n${resultado.stderr}`

    expect(resultado.status).toBe(1)
    expect(salida).toContain('Solo 12 tablas')
    expect(salida).not.toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)
  })

  it('falla si falta una tabla núcleo aunque el total de tablas supere el mínimo', () => {
    const resultado = ejecutar({
      modo: 'restore-falta-tabla',
      comando: 'verify',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })
    const salida = `${resultado.stdout}\n${resultado.stderr}`

    expect(resultado.status).toBe(1)
    expect(salida).toContain('Tablas restauradas: 51')
    expect(salida).toContain('products       no existe')
    expect(salida).toContain('Faltan tablas núcleo: products')
    expect(salida).not.toContain('El respaldo se restaura y trae el esquema completo')
    expect(eliminoContenedor(resultado)).toBe(true)
  })

  it('crea el archivo de respaldo con permisos privados 0600', () => {
    const resultado = ejecutar({
      modo: 'backup-exitoso',
      comando: 'backup',
      url: 'postgresql://usuario:clave-simulada@db.example.test:5432/app',
    })
    const archivo = readdirSync(resultado.directorioTemporal)
      .find(nombre => nombre.startsWith('botpanel-') && nombre.endsWith('.dump'))

    expect(resultado.status).toBe(0)
    expect(archivo).toBeDefined()
    expect(statSync(path.join(resultado.directorioTemporal, archivo)).mode & 0o777).toBe(0o600)
    expect(eliminoContenedor(resultado)).toBe(true)
  })
})

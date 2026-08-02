#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// RESPALDO DE PRODUCCIÓN — y la prueba de que sirve
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ En el plan gratuito, Supabase NO hace respaldos automáticos. Los diarios
// son de Pro en adelante; su propia documentación recomienda a los proyectos
// gratuitos exportar sus datos por su cuenta. Es decir: hasta que esto exista,
// perder la base es perderlo todo.
//
//   npm run backup -w @botpanel/server            -- guarda el respaldo
//   npm run backup:verify -w @botpanel/server     -- lo restaura y lo comprueba
//
// Un respaldo que nunca se restauró NO es un respaldo: es un archivo del que
// nadie sabe nada. Por eso el segundo comando existe y por eso conviene correrlo
// de vez en cuando, no solo el día que haga falta.
//
// Usa `pg_dump` DENTRO de un contenedor con la misma versión mayor que el
// servidor, en vez del que haya instalado en la máquina: un pg_dump más viejo
// que el servidor se niega a trabajar, y esa es la forma más común de descubrir
// que tu respaldo no se puede hacer justo cuando lo necesitas.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// pgvector, NO el postgres normal. La tabla `products` guarda embeddings de
// 1536 dimensiones, así que un PostgreSQL sin esa extensión no puede ni crearla:
// el volcado se restaura "con avisos" y te deja media base. Se descubrió
// probando la restauración de verdad, que es justo para lo que sirve probarla.
const IMAGEN = 'pgvector/pgvector:pg17'
const DESTINO = process.env.BACKUP_DIR || path.join(process.cwd(), 'respaldos')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('❌ Falta DATABASE_URL (cadena de conexión directa de Postgres).')
  console.error('   Supabase → Configuración → Base de datos → Connection string → URI.')
  console.error('   Es la misma que usa `npm run migrate`.')
  process.exit(1)
}

const docker = (args, opciones = {}) => execFileSync('docker', args, {
  stdio: opciones.silencioso ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  encoding: 'utf8',
  ...opciones,
})

const asegurarDocker = () => {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], { silencioso: true })
  } catch {
    console.error('❌ Docker no está corriendo. Ábrelo y vuelve a intentarlo.')
    process.exit(1)
  }
}

const respaldar = () => {
  mkdirSync(DESTINO, { recursive: true })
  const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const archivo = path.join(DESTINO, `botpanel-${sello}.dump`)

  console.log(`\n💾 Respaldando producción…`)
  // Formato `custom` (-Fc): comprimido y restaurable con pg_restore, que además
  // permite recuperar UNA tabla suelta sin tragarse el volcado entero.
  const salida = docker([
    'run', '--rm', '-i', IMAGEN,
    'pg_dump', '--format=custom', '--no-owner', '--no-privileges', url,
  ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'buffer' })

  writeFileSync(archivo, salida)
  const mb = (statSync(archivo).size / 1024 / 1024).toFixed(2)
  console.log(`✅ Guardado: ${archivo}  (${mb} MB)`)
  console.log('\n⚠️  Un respaldo en la MISMA máquina no protege de perder la máquina.')
  console.log('   Copia esta carpeta a otro sitio (Drive, disco externo, otro equipo).')
  return archivo
}

const verificar = archivo => {
  if (!archivo || !existsSync(archivo)) {
    console.error(`❌ No encuentro el respaldo: ${archivo || '(ninguno indicado)'}`)
    console.error('   Uso: npm run backup:verify -w @botpanel/server -- respaldos/archivo.dump')
    process.exit(1)
  }

  const contenedor = `verificar-respaldo-${Date.now()}`
  console.log(`\n🧪 Restaurando ${path.basename(archivo)} en un PostgreSQL limpio…`)
  try {
    docker(['run', '-d', '--name', contenedor, '-e', 'POSTGRES_PASSWORD=verificar',
      '-e', 'POSTGRES_DB=restaurado', IMAGEN], { silencioso: true })

    // Esperar a que acepte conexiones.
    for (let intento = 0; intento < 60; intento++) {
      try {
        docker(['exec', contenedor, 'pg_isready', '-U', 'postgres'], { silencioso: true })
        break
      } catch {
        execFileSync('sleep', ['1'])
      }
    }

    docker(['cp', archivo, `${contenedor}:/tmp/r.dump`], { silencioso: true })
    // Sin --exit-on-error a propósito: un volcado de Supabase trae referencias a
    // roles y extensiones que aquí no existen, y esos avisos son esperados. Lo
    // que importa es si los DATOS llegaron, y eso se comprueba contándolos.
    docker(['exec', contenedor, 'pg_restore', '-U', 'postgres', '-d', 'restaurado',
      '--no-owner', '--no-privileges', '/tmp/r.dump'], { silencioso: true })

    const contar = consulta => docker(
      ['exec', contenedor, 'psql', '-U', 'postgres', '-d', 'restaurado', '-tAc', consulta],
      { silencioso: true },
    ).trim()

    const tablas = Number(contar(
      "select count(*) from information_schema.tables where table_schema='public'",
    ))
    console.log(`\n   Tablas restauradas: ${tablas}`)

    if (tablas < 30) {
      console.error(`\n❌ Solo ${tablas} tablas. El esquema completo tiene ~38.`)
      console.error('   Este respaldo NO sirve para recuperarse tal cual.')
      console.error('   Causa habitual: el destino no tiene `pgvector` y `products`')
      console.error('   —que guarda embeddings— no se puede crear sin esa extensión.')
      process.exit(1)
    }

    // Lo que de verdad importa no es que haya tablas, sino que haya CONTENIDO.
    for (const tabla of ['businesses', 'products', 'orders', 'client_users']) {
      const existe = contar(
        `select count(*) from information_schema.tables where table_schema='public' and table_name='${tabla}'`,
      )
      const filas = existe === '1' ? contar(`select count(*) from public.${tabla}`) : 'no existe'
      console.log(`   ${tabla.padEnd(14)} ${filas} fila(s)`)
    }

    console.log('\n✅ El respaldo se restaura y trae el esquema completo.')
    console.log('   Guárdalo fuera de esta máquina.')
  } finally {
    try { docker(['rm', '-f', contenedor], { silencioso: true }) } catch { /* ya no estaba */ }
  }
}

asegurarDocker()
const comando = process.argv[2] === 'verify' ? 'verify' : 'backup'
if (comando === 'verify') verificar(process.argv[3])
else verificar(respaldar())

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

const redactarCredenciales = valor => {
  let texto = Buffer.isBuffer(valor) ? valor.toString('utf8') : String(valor || '')
  const secretos = new Set([url])

  try {
    const parsed = new URL(url)
    secretos.add(parsed.password)
    try { secretos.add(decodeURIComponent(parsed.password)) } catch { /* URI mal codificada */ }
    try { secretos.add(decodeURIComponent(url)) } catch { /* URI mal codificada */ }
  } catch { /* pg_dump dará el diagnóstico de una URI inválida */ }

  for (const secreto of [...secretos].filter(Boolean).sort((a, b) => b.length - a.length)) {
    texto = texto.split(secreto).join('[REDACTADO]')
  }

  return texto
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[URI DE POSTGRES REDACTADA]')
    .replace(
      /\b((?:postgres_password|pgpassword|password)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTADO]',
    )
}

const tieneContenido = valor => Buffer.isBuffer(valor)
  ? valor.toString('utf8').trim().length > 0
  : String(valor || '').trim().length > 0

const detalleSeguro = error => redactarCredenciales(
  tieneContenido(error?.stderr) ? error.stderr : error?.message || '',
)

const ERRORES_VAULT_ESPERADOS = [
  'extension "supabase_vault" is not available',
  'extension "supabase_vault" does not exist',
  'relation "vault.secrets" does not exist',
]

const soloFaltaVault = error => {
  if (error?.status !== 1 || error?.signal != null || error?.killed === true) return false
  if (tieneContenido(error?.stdout) || !tieneContenido(error?.stderr)) return false

  const detalle = redactarCredenciales(error.stderr)
  const lineas = detalle.replace(/\r\n/g, '\n').split('\n').map(linea => linea.trim())
    .filter(Boolean)
  const errores = lineas.filter(linea => /^pg_restore: error:/i.test(linea))
  const avisos = lineas.filter(linea => /^pg_restore: warning:/i.test(linea))
  const diagnosticos = lineas.filter(linea => /^pg_restore: (?:error|warning|fatal):/i.test(linea))
  const salidaPropiaDePgRestore = lineas.every(linea => [
    /^pg_restore: (?:error:|warning:|while PROCESSING TOC:|from TOC entry )/i,
    /^(?:DETAIL|HINT|Command was):/i,
  ].some(patron => patron.test(linea)))

  return salidaPropiaDePgRestore
    && diagnosticos.length === ERRORES_VAULT_ESPERADOS.length + 1
    && errores.length === ERRORES_VAULT_ESPERADOS.length
    && ERRORES_VAULT_ESPERADOS.every(
      firma => errores.filter(linea => linea.includes(firma)).length === 1,
    )
    && errores.every(linea => ERRORES_VAULT_ESPERADOS.some(firma => linea.includes(firma)))
    && avisos.length === 1
    && /^pg_restore: warning: errors ignored on restore: 3$/i.test(avisos[0])
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
  // `execFileSync` repite sus argumentos al fallar; uno de ellos es la URI de
  // producción. stderr se captura para sanearla antes de mostrar cualquier
  // diagnóstico, y stdout conserva el volcado binario.
  const salida = docker([
    'run', '--rm', '-i', IMAGEN,
    'pg_dump', '--format=custom', '--no-owner', '--no-privileges', url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'buffer' })

  writeFileSync(archivo, salida, { mode: 0o600 })
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
    // Sin --exit-on-error a propósito: Supabase incluye referencias a su Vault
    // incluso cuando está vacío, pero la imagen local solo trae pgvector. Solo
    // esos tres errores exactos pueden continuar; cualquier otro fallo detiene
    // la prueba antes de declarar que el respaldo sirve.
    try {
      docker(['exec', contenedor, 'pg_restore', '-U', 'postgres', '-d', 'restaurado',
        '--no-owner', '--no-privileges', '/tmp/r.dump'], { silencioso: true })
    } catch (error) {
      if (!soloFaltaVault(error)) throw error
      console.log('   Avisos esperados: la imagen local no incluye Supabase Vault.')
    }

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
      throw new Error('La restauración no contiene el esquema completo.')
    }

    // El total no basta: las tablas núcleo deben existir. Pueden tener cero
    // filas porque una instalación nueva y válida todavía puede estar vacía.
    const tablasNucleoFaltantes = []
    for (const tabla of ['businesses', 'products', 'orders', 'client_users']) {
      const existe = contar(
        `select count(*) from information_schema.tables where table_schema='public' and table_name='${tabla}' and table_type='BASE TABLE'`,
      )
      if (existe !== '1') {
        tablasNucleoFaltantes.push(tabla)
        console.log(`   ${tabla.padEnd(14)} no existe`)
        continue
      }
      const filas = contar(`select count(*) from public.${tabla}`)
      console.log(`   ${tabla.padEnd(14)} ${filas} fila(s)`)
    }

    if (tablasNucleoFaltantes.length) {
      throw new Error(`Faltan tablas núcleo: ${tablasNucleoFaltantes.join(', ')}`)
    }

    console.log('\n✅ El respaldo se restaura y trae el esquema completo.')
    console.log('   Guárdalo fuera de esta máquina.')
  } finally {
    try { docker(['rm', '-f', contenedor], { silencioso: true }) } catch { /* ya no estaba */ }
  }
}

try {
  asegurarDocker()
  const comando = process.argv[2] === 'verify' ? 'verify' : 'backup'
  if (comando === 'verify') verificar(process.argv[3])
  else verificar(respaldar())
} catch (error) {
  // Nunca imprimir el objeto de `execFileSync`: incluye todos sus argumentos y
  // pg_dump recibe DATABASE_URL como uno de ellos.
  console.error('\n❌ No se pudo completar el respaldo ni su restauración de prueba.')
  console.error('   DATABASE_URL y su contraseña se mantuvieron ocultas.')
  const detalle = detalleSeguro(error)
  if (detalle.trim()) console.error(`\n${detalle.trim()}`)
  process.exit(1)
}

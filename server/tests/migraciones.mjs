#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EJECUTOR DE MIGRACIONES — qué se aplicó, qué falta, y aplicar lo que falta
// ═══════════════════════════════════════════════════════════════════════════
//
// El problema que resuelve: las 34 migraciones del proyecto se corrían a mano
// en el editor SQL de Supabase y nadie llevaba la cuenta. Olvidar una no avisa
// — la app responde 500 cuando el código busca una tabla que no existe—, y ya
// pasó con las del hostal y las de la tienda.
//
// ⚠️ NO va en el CI ni en el arranque del servidor. Es una herramienta de
// mano, como `verify:smoke`. El servidor NUNCA aplica migraciones solo:
// arrancar cuatro instancias en Railway significaría cuatro procesos corriendo
// el mismo DDL a la vez.
//
// Necesita `DATABASE_URL`, la cadena de conexión DIRECTA de Postgres —no la
// URL de la API—, que Supabase da en Configuración → Base de datos. Es una
// credencial de herramienta: se queda en el .env local y no hace falta en
// Railway, porque el servidor en marcha no la usa.
//
//   npm run migrate:status                 -- qué hay aplicado y qué falta
//   npm run migrate:baseline               -- dar por aplicadas las de siempre
//   npm run migrate                        -- aplicar lo pendiente
//   npm run migrate -- --solo=archivo.sql  -- aplicar únicamente la primera pendiente
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Este archivo tiene el esquema VIEJO de `bookings` (start_time/end_time), que
// ya fue reemplazado. Su propia cabecera dice NO USAR. Aplicarlo hoy rompería
// la agenda de todos los negocios, así que el ejecutor lo ignora siempre — no
// depende de que nadie se acuerde.
const JAMAS_EJECUTAR = new Set(['migration-integraciones.sql'])

const REGISTRO = 'migration-registro-migraciones.sql'

const huella = texto => createHash('sha256').update(texto).digest('hex').slice(0, 16)

// Algunas migraciones de una misma fecha son fases, no cambios independientes.
// Declarar la dependencia aquí evita esconderla en un nombre cuya ordenación
// alfabética puede decir otra cosa.
const DEPENDENCIAS_POR_MIGRACION = new Map([
  [
    'migration-2026-08-16-retirar-citas.sql',
    ['migration-2026-08-16-retirar-hospedaje.sql'],
  ],
  [
    'migration-2026-08-16-retirar-modo-menu.sql',
    ['migration-2026-08-16-retirar-citas.sql'],
  ],
])

export const ordenarNombresDeMigracion = nombres => {
  // Las nuevas se llaman `migration-AAAA-MM-DD-tema.sql`, así que el nombre da
  // el orden cronológico base. Las de antes de esta convención van PRIMERO:
  // son más viejas por definición, y durante la adopción puede quedar alguna
  // sin aplicar que una nueva dé por hecha.
  const pendientes = [...nombres].sort((a, b) => {
    const fechada = name => /^migration-\d{4}-\d{2}-\d{2}-/.test(name)
    if (fechada(a) !== fechada(b)) return fechada(a) ? 1 : -1
    return a.localeCompare(b)
  })
  const presentes = new Set(pendientes)
  const ordenadas = new Set()
  const resultado = []

  for (const [dependiente, requisitos] of DEPENDENCIAS_POR_MIGRACION) {
    if (!presentes.has(dependiente)) continue
    const ausente = requisitos.find(requisito => !presentes.has(requisito))
    if (ausente) {
      throw new Error(
        `La migración ${dependiente} depende de un archivo ausente: ${ausente}`,
      )
    }
  }

  // Orden topológico estable: conserva el orden base salvo cuando una
  // dependencia explícita obliga a adelantar su requisito.
  while (pendientes.length) {
    const indice = pendientes.findIndex(name => (
      DEPENDENCIAS_POR_MIGRACION.get(name) || []
    ).every(requisito => !presentes.has(requisito) || ordenadas.has(requisito)))
    if (indice === -1) {
      throw new Error('Las dependencias declaradas de migraciones contienen un ciclo')
    }
    const [siguiente] = pendientes.splice(indice, 1)
    resultado.push(siguiente)
    ordenadas.add(siguiente)
  }
  return resultado
}

export const seleccionarMigracionesParaAplicar = (pendientes, solo) => {
  if (solo === undefined) return pendientes
  if (!solo) throw new Error('La opción --solo exige el nombre exacto de una migración')

  const objetivo = pendientes.find(migracion => migracion.name === solo)
  if (!objetivo) {
    throw new Error(`La migración indicada en --solo no está pendiente: ${solo}`)
  }

  const primera = pendientes[0]
  if (primera?.name !== solo) {
    throw new Error(
      `No se puede aplicar ${solo}: la primera migración pendiente es ${primera?.name}`,
    )
  }
  return [objetivo]
}

const COMANDOS = new Set(['status', 'baseline', 'apply'])

export const validarArgumentosCli = argumentos => {
  const posicionales = argumentos.filter(argumento => !argumento.startsWith('--'))
  const comando = posicionales[0] || 'status'
  if (!COMANDOS.has(comando)) throw new Error(`Argumento desconocido: ${comando}`)
  if (posicionales.length > 1) {
    throw new Error(`Argumento desconocido: ${posicionales[1]}`)
  }

  const opciones = argumentos.filter(argumento => argumento.startsWith('--'))
  const opcionesSolo = opciones.filter(
    opcion => opcion === '--solo' || opcion.startsWith('--solo='),
  )
  if (opcionesSolo.length > 1) {
    throw new Error('El comando apply solo admite un --solo')
  }
  const opcionesExcepto = opciones.filter(opcion => opcion.startsWith('--excepto='))
  if (opcionesExcepto.length > 1) {
    throw new Error('El comando baseline solo admite un --excepto con lista separada por comas')
  }

  const valida = opcion => {
    if (comando === 'baseline') {
      return opcion === '--si'
        || (opcion.startsWith('--excepto=') && opcion.length > '--excepto='.length)
    }
    if (comando === 'apply') {
      return opcion.startsWith('--solo=') && opcion.length > '--solo='.length
    }
    return false
  }
  const desconocida = opciones.find(opcion => !valida(opcion))
  if (desconocida) throw new Error(`Argumento desconocido para ${comando}: ${desconocida}`)
  if (comando === 'baseline' && opcionesExcepto.length) {
    const nombres = opcionesExcepto[0].slice('--excepto='.length)
      .split(',').map(nombre => nombre.trim()).filter(Boolean)
    if (!nombres.length) throw new Error('La opción --excepto exige al menos una migración')
    if (new Set(nombres).size !== nombres.length) {
      throw new Error('La opción --excepto no admite migraciones repetidas')
    }
  }
  return comando
}

export const excepcionesDeBaseline = argumentos => {
  const opcion = argumentos.find(argumento => argumento.startsWith('--excepto='))
  if (!opcion) return []
  return opcion.slice('--excepto='.length)
    .split(',').map(nombre => nombre.trim()).filter(Boolean)
}

export const seleccionarMigracionesParaBaseline = (pendientes, excepciones) => {
  const pendientesPorNombre = new Set(pendientes.map(migracion => migracion.name))
  const inexistentes = excepciones.filter(nombre => !pendientesPorNombre.has(nombre))
  if (inexistentes.length) {
    throw new Error(
      `No se puede excluir una migración que no está pendiente: ${inexistentes.join(', ')}`,
    )
  }

  const excepto = new Set(excepciones)
  for (const migracion of pendientes) {
    if (excepto.has(migracion.name)) continue
    const requisitoPendiente = (DEPENDENCIAS_POR_MIGRACION.get(migracion.name) || [])
      .find(requisito => excepto.has(requisito))
    if (requisitoPendiente) {
      throw new Error(
        `No se puede marcar ${migracion.name}: queda pendiente su requisito ${requisitoPendiente}`,
      )
    }
  }
  return pendientes.filter(migracion => !excepto.has(migracion.name))
}

const migracionesEnDisco = () => ordenarNombresDeMigracion(readdirSync(RAIZ)
  .filter(f => f.startsWith('migration-') && f.endsWith('.sql'))
  .filter(f => !JAMAS_EJECUTAR.has(f)))
  .map(name => {
    const sql = readFileSync(path.join(RAIZ, name), 'utf8')
    return { name, sql, checksum: huella(sql) }
  })

const conectar = async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('❌ Falta DATABASE_URL (cadena de conexión directa de Postgres).')
    console.error('   Supabase → Configuración → Base de datos → Connection string → URI.')
    console.error('   Ojo: NO es SUPABASE_URL, que apunta a la API.')
    process.exit(1)
  }
  // Supabase exige TLS pero presenta un certificado que Node no trae en su
  // almacén; el canal va cifrado igual. Un Postgres local —el de las pruebas—
  // no habla TLS, así que exigirlo ahí solo impediría probar la herramienta.
  const local = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url)
  const client = new pg.Client({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
  })
  await client.connect()
  return client
}

// El registro tiene que existir antes de poder consultarlo. Se aplica siempre:
// su SQL es idempotente, así que repetirlo no cuesta nada.
const asegurarRegistro = async client => {
  await client.query(readFileSync(path.join(RAIZ, REGISTRO), 'utf8'))
}

const aplicadas = async client => {
  const { rows } = await client.query('select name, checksum, source, applied_at from schema_migrations')
  return new Map(rows.map(r => [r.name, r]))
}

// Un .sql ya aplicado no se edita nunca: quien lo lea creerá que la base dice
// lo que dice el archivo, y no es verdad. Sin comparar huellas, un archivo
// cambiado se ve idéntico a uno intacto.
const editadasTrasAplicar = (disco, registro) => disco.filter(m => {
  const fila = registro.get(m.name)
  return fila && fila.checksum !== m.checksum
})

const estado = async client => {
  const disco = migracionesEnDisco()
  const registro = await aplicadas(client)
  const pendientes = disco.filter(m => !registro.has(m.name))
  const editadas = editadasTrasAplicar(disco, registro)
  // Estaban en el registro pero ya no en el disco: alguien borró un .sql
  // aplicado. No es fatal, pero conviene saberlo.
  const huerfanas = [...registro.keys()].filter(
    name => !disco.some(m => m.name === name) && name !== REGISTRO,
  )
  return { disco, registro, pendientes, editadas, huerfanas }
}

const mostrarEstado = ({ disco, registro, pendientes, editadas, huerfanas }) => {
  console.log(`\n📋 ${disco.length} migraciones en disco · ${registro.size} registradas como aplicadas\n`)

  if (editadas.length) {
    console.log('⚠️  EDITADAS DESPUÉS DE APLICARSE (la base ya no dice lo que dice el archivo):')
    for (const m of editadas) console.log(`      · ${m.name}`)
    console.log('   Lo correcto es un archivo NUEVO con el cambio, no tocar el aplicado.\n')
  }
  if (huerfanas.length) {
    console.log('⚠️  REGISTRADAS PERO SIN ARCHIVO (alguien borró un .sql aplicado):')
    for (const name of huerfanas) console.log(`      · ${name}`)
    console.log('')
  }
  if (!pendientes.length) {
    console.log('✅ No hay migraciones pendientes.')
    return
  }
  console.log(`🕒 PENDIENTES (${pendientes.length}):`)
  for (const m of pendientes) console.log(`      · ${m.name}`)
  console.log('\n   Aplícalas con:  npm run migrate -w @botpanel/server')
}

const baseline = async (client, argumentos) => {
  const excepciones = excepcionesDeBaseline(argumentos)
  const excepto = new Set(excepciones)
  const { pendientes } = await estado(client)
  const marcar = seleccionarMigracionesParaBaseline(pendientes, excepciones)

  if (!marcar.length) {
    console.log('✅ No queda nada por marcar: el registro ya está al día.')
    return
  }

  console.log(`\n📋 Se marcarán ${marcar.length} migraciones como YA APLICADAS, SIN ejecutarlas:\n`)
  for (const m of marcar) console.log(`      · ${m.name}`)
  if (excepto.size) {
    console.log(`\n   Se dejan pendientes a propósito: ${[...excepto].join(', ')}`)
  }

  if (!argumentos.includes('--si')) {
    console.log('\n⚠️  ESTO ES UNA AFIRMACIÓN, NO UNA COMPROBACIÓN.')
    console.log('   Marcar una migración que en realidad NUNCA se corrió la deja')
    console.log('   invisible para siempre: el ejecutor no volverá a proponerla.')
    console.log('   Comprueba antes contra la base real:')
    console.log('       npm run verify:drift -w @botpanel/server')
    console.log('   y excluye lo que falte por aplicar:')
    console.log('       npm run migrate:baseline -w @botpanel/server -- --excepto=a.sql,b.sql --si')
    console.log('\n   Añade --si para confirmar.')
    process.exit(1)
  }

  for (const m of marcar) {
    await client.query(
      `insert into schema_migrations (name, checksum, source) values ($1, $2, 'baseline')
       on conflict (name) do nothing`,
      [m.name, m.checksum],
    )
  }
  console.log(`\n✅ ${marcar.length} migraciones registradas como aplicadas (baseline).`)
}

const aplicar = async (client, argumentos) => {
  const { registro, pendientes, editadas } = await estado(client)

  // Si el registro está vacío, o solo tiene el suyo propio, nadie hizo el
  // baseline: correr las 34 de golpe contra una base que ya las tiene sería,
  // en el mejor caso, ruido, y en el peor, destruir datos.
  const soloElRegistro = registro.size <= 1
  if (soloElRegistro && pendientes.length > 3) {
    console.error('\n❌ El registro está vacío y hay muchas migraciones pendientes.')
    console.error('   Eso significa que esta base nunca hizo el baseline. Aplicarlas')
    console.error('   todas ahora correría de nuevo cosas que ya están puestas.')
    console.error('\n   Empieza por:  npm run migrate:baseline -w @botpanel/server')
    process.exit(1)
  }

  if (editadas.length) {
    console.error('\n❌ Hay migraciones editadas después de aplicarse:')
    for (const m of editadas) console.error(`      · ${m.name}`)
    console.error('\n   Revierte el archivo o crea uno nuevo con el cambio. No se aplica nada.')
    process.exit(1)
  }

  const argumentoSolo = argumentos.find(
    argumento => argumento === '--solo' || argumento.startsWith('--solo='),
  )
  let porAplicar
  try {
    porAplicar = seleccionarMigracionesParaAplicar(
      pendientes,
      argumentoSolo === undefined ? undefined : argumentoSolo.slice('--solo='.length),
    )
  } catch (error) {
    console.error(`\n❌ ${error.message}`)
    process.exit(1)
  }

  if (!porAplicar.length) {
    console.log('✅ No hay migraciones pendientes.')
    return
  }

  console.log(`\n🚀 Aplicando ${porAplicar.length} migraciones:\n`)
  for (const m of porAplicar) {
    process.stdout.write(`   · ${m.name} … `)
    // Cada una en su transacción: si la número 3 falla, las dos primeras
    // quedan aplicadas y registradas, y se reintenta desde la que rompió.
    // Postgres soporta DDL transaccional, así que una migración a medias no
    // existe: o entra entera o no entra.
    try {
      await client.query('begin')
      await client.query(m.sql)
      await client.query(
        `insert into schema_migrations (name, checksum, source) values ($1, $2, 'runner')`,
        [m.name, m.checksum],
      )
      await client.query('commit')
      console.log('ok')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      console.log('FALLÓ')
      console.error(`\n❌ ${m.name}: ${error.message}`)
      console.error('   Nada de esta migración quedó aplicado. Las anteriores sí.')
      process.exit(1)
    }
  }
  console.log(`\n✅ ${porAplicar.length} migraciones aplicadas y registradas.`)
}

const main = async () => {
  const argumentos = process.argv.slice(2)
  let comando
  try {
    comando = validarArgumentosCli(argumentos)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exit(1)
  }
  const client = await conectar()
  try {
    await asegurarRegistro(client)
    if (comando === 'status') mostrarEstado(await estado(client))
    else if (comando === 'baseline') await baseline(client, argumentos)
    else if (comando === 'apply') await aplicar(client, argumentos)
    else {
      console.error(`Comando desconocido: ${comando} (status | baseline | apply)`)
      process.exit(1)
    }
  } finally {
    await client.end()
  }
}

const ejecutadoDirectamente = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (ejecutadoDirectamente) {
  main().catch(error => {
    console.error(`❌ ${error.message}`)
    process.exit(1)
  })
}

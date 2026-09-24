import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const migracion = readFileSync(
  `${serverDir}/migration-2026-09-23-el-menu-responde-al-instante.sql`,
  'utf8',
)
const schema = readFileSync(`${serverDir}/schema.sql`, 'utf8')
const rutas = readFileSync(`${serverDir}/src/routes/webhooks.routes.ts`, 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// TOCAR UN BOTÓN NO ESPERA TRES SEGUNDOS
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño (2026-09-23): «el tiempo de respuesta en WhatsApp lo más
// rápido posible; antes parecía lento, como de 3 segundos».
//
// Era literal, y la causa estaba escondida en una decisión razonable:
// `webhooks.routes.ts` convierte las respuestas interactivas en
// `kind: 'text'` —a propósito, para que el menú no tenga que emparejar dos
// formatos— y la cola abría su ventana de silencio de 3 s para TODO lo que
// fuera texto. Resultado: **cada toque del menú esperaba tres segundos** por
// una ventana que existe para juntar mensajes escritos a trozos.
//
// ⚠️ LA MITAD QUE HAY QUE PROTEGER: el texto ESCRITO sigue agrupándose. Sin
// eso, tres mensajes seguidos se contestan tres veces — y cada saliente se
// paga.

/** El cuerpo de una función SQL, desde su `create` hasta su `$$;`. */
const cuerpoDe = (fuente, nombre) => {
  const desde = fuente.lastIndexOf(`create or replace function public.${nombre}`)
  expect(desde, `${nombre} debe existir`).toBeGreaterThanOrEqual(0)
  const hasta = fuente.indexOf('$$;', desde)
  expect(hasta, `${nombre} debe cerrar su cuerpo`).toBeGreaterThan(desde)
  return fuente.slice(desde, hasta + 3)
}

describe('los dos proveedores marcan lo ELEGIDO', () => {
  it('Meta y YCloud distinguen un toque de un texto escrito', () => {
    // Los dos convierten la respuesta interactiva en texto —eso NO cambia— pero
    // ahora la marcan para que la cola no la haga esperar.
    const marcas = rutas.match(/interactivo: true/g) || []
    expect(marcas.length, 'lo deben marcar Meta y YCloud').toBe(2)
  })

  it('y solo cuando es botón o interactivo, nunca un texto escrito', () => {
    const condiciones = rutas.match(
      /message\.type === 'button' \|\| message\.type === 'interactive'/g,
    ) || []
    expect(condiciones.length).toBe(2)
  })
})

describe('la cola deja de esperar por lo elegido', () => {
  for (const [donde, fuente] of [['la migración', migracion], ['el consolidado', schema]]) {
    describe(donde, () => {
      const enqueue = () => cuerpoDe(fuente, 'enqueue_webhook_event')

      it('lo interactivo no cuenta como texto libre', () => {
        expect(enqueue()).toMatch(
          /content,interactivo.*::boolean, false\) = false/s,
        )
      })

      it('entra con `now()`, como ya hacían fotos y ubicaciones', () => {
        expect(enqueue()).toContain(
          'case when v_es_texto_libre then v_quiet_until else now() end',
        )
      })

      it('una elección pendiente NO la retrasa un texto posterior', () => {
        const cuerpo = enqueue()
        const update = cuerpo.slice(cuerpo.indexOf('update public.webhook_inbound_events'))
        expect(update).toMatch(/queued\.payload #>> '\{content,interactivo\}'/)
      })

      it('y una elección SÍ separa conversaciones, como una foto', () => {
        const cuerpo = enqueue()
        const frontera = cuerpo.slice(cuerpo.indexOf('boundary.payload'))
        expect(frontera).toMatch(/boundary\.payload #>> '\{content,interactivo\}'/)
      })

      it('⚠️ el texto ESCRITO sigue esperando su ventana', () => {
        const cuerpo = enqueue()
        // Se comprueba que la ventana EXISTE y que se aplica solo al texto
        // libre, no su duración: el número vive en cada fuente y cambió el
        // 2026-09-23 (3 s → 300 ms en el consolidado). Lo que no puede
        // desaparecer es el agrupado — sin él, tres mensajes seguidos se
        // contestan tres veces, y cada saliente se paga.
        expect(cuerpo).toMatch(/v_quiet_until := v_received_at \+ interval/)
        expect(cuerpo).toContain('if v_es_texto_libre then')
      })
    })
  }

  it('la variable vieja ya no se USA en ninguna de las dos', () => {
    // `v_is_text` mentía: no distinguía lo escrito de lo elegido. Se mira el
    // USO y no la palabra, porque la migración la nombra a propósito en un
    // comentario para explicar el renombrado.
    for (const [donde, fuente] of [['migración', migracion], ['consolidado', schema]]) {
      const enqueue = cuerpoDe(fuente, 'enqueue_webhook_event')
      expect(enqueue, `${donde}: sigue asignando v_is_text`).not.toMatch(/v_is_text\s*:=/)
      expect(enqueue, `${donde}: sigue leyendo v_is_text`).not.toMatch(/if v_is_text\b/)
      expect(enqueue, `${donde}: sigue declarando v_is_text`).not.toMatch(/v_is_text boolean/)
    }
  })
})

describe('el comportamiento se comprueba en PostgreSQL real', () => {
  it('la verificación mide los tiempos, no lee el SQL', () => {
    const sql = readFileSync(`${serverDir}/tests/sql/verificar-esquema.sql`, 'utf8')
    expect(sql).toContain('el menú tiene que responder al instante')
    expect(sql).toContain('El texto escrito dejó de agruparse')
  })
})

describe('la ventana baja a 300 ms, medida contra producción', () => {
  const ventana = readFileSync(
    `${serverDir}/migration-2026-09-23-ventana-de-300ms.sql`,
    'utf8',
  )

  it('el consolidado y su migración usan 300 ms', () => {
    for (const [donde, fuente] of [['consolidado', schema], ['migración', ventana]]) {
      expect(cuerpoDe(fuente, 'enqueue_webhook_event'), donde).toContain(
        "v_quiet_until := v_received_at + interval '300 milliseconds'",
      )
    }
  })

  it('NO se pone a cero: el agrupado se queda', () => {
    // Quitarla del todo quitaría el agrupado entero, que es una pieza con
    // nombre y pruebas (`_inboxBatch`), no un retraso suelto. La red sigue
    // valiendo para dos webhooks casi simultáneos.
    const enqueue = cuerpoDe(schema, 'enqueue_webhook_event')
    expect(enqueue).toContain('_inboxBatch')
    expect(enqueue).toContain('greatest(queued.available_at, v_quiet_until)')
  })

  it('deja escrito POR QUÉ ese número y cuál es el suelo real', () => {
    // El dato que lo justifica tiene que sobrevivir al commit: sin él, el
    // siguiente que lo lea creerá que es arbitrario y lo subirá «por si acaso».
    expect(ventana).toMatch(/5,67/)
    expect(ventana).toMatch(/1000 ms/)
  })
})

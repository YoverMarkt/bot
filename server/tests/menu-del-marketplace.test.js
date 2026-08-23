import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PAGINA, VER_MAS, VOLVER, elegir, paso, verCategorias, verNegocios,
} from '../dist/services/marketplace-menu.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL MENÚ DEL MARKETPLACE
//
// Lo que ve quien escribe al número de Umbani. Se prueba entero sin base
// porque es una función pura, y eso es justo lo que permite cubrir los casos
// que en producción costarían un mensaje cada uno.
// ═══════════════════════════════════════════════════════════════════════════

const cat = (code, label, emoji = null, locales = 1) => ({ code, label, emoji, locales })
const neg = (slug, name, type = 'pizzería') => ({
  id: `id-${slug}`, slug, name, type, prep_min: 30,
})

const CATEGORIAS = [
  cat('pizzerias', 'Pizzerías', '🍕', 2),
  cat('hamburguesas', 'Hamburguesas', '🍔', 2),
  cat('mariscos', 'Mariscos y ceviches', '🐟', 1),
]

describe('la portada', () => {
  it('saluda una sola vez y ofrece las categorías', () => {
    const r = verCategorias(CATEGORIAS, 0, true)
    expect(r.reply).toContain('Umbani')
    expect(r.reply).toContain('¿Qué deseas pedir?')
    expect(r.options).toEqual(['🍕 Pizzerías', '🍔 Hamburguesas', '🐟 Mariscos y ceviches'])
    // Al volver al menú no se vuelve a saludar: sería un mensaje que se paga.
    expect(verCategorias(CATEGORIAS, 0, false).reply).not.toContain('Umbani')
  })

  it('sin locales lo dice, en vez de enseñar una lista vacía', () => {
    const r = verCategorias([], 0, true)
    expect(r.options).toEqual([])
    expect(r.reply).toMatch(/no tenemos locales/i)
  })

  it('pagina de nueve en nueve, porque la décima fila es «Ver más»', () => {
    // ⚠️ Una lista de WhatsApp admite DIEZ filas. Con diez categorías más el
    // botón, la última se perdería sin que nada avisara.
    const muchas = Array.from({ length: 14 }, (_, i) => cat(`c${i}`, `Categoría ${i}`))
    const primera = verCategorias(muchas, 0)
    expect(primera.options).toHaveLength(PAGINA + 1)
    expect(primera.options).toHaveLength(10)
    expect(primera.options.at(-1)).toBe(VER_MAS)

    const segunda = verCategorias(muchas, 1)
    expect(segunda.options).toHaveLength(5)
    expect(segunda.options).not.toContain(VER_MAS)
  })
})

describe('elegir una opción', () => {
  const opciones = ['🍕 Pizzerías', '🍔 Hamburguesas', VER_MAS]

  it('acepta el texto exacto que devuelve WhatsApp', () => {
    expect(elegir('🍕 Pizzerías', opciones)).toBe('🍕 Pizzerías')
  })

  it('acepta el número de la fila, que es como responde mucha gente', () => {
    expect(elegir('2', opciones)).toBe('🍔 Hamburguesas')
    expect(elegir('9', opciones)).toBeNull()
    expect(elegir('0', opciones)).toBeNull()
  })

  it('acepta el nombre sin emoji, sin tildes y sin mayúsculas', () => {
    expect(elegir('pizzerias', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('PIZZERÍAS', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('  hamburguesas ', opciones)).toBe('🍔 Hamburguesas')
  })

  it('no adivina cuando no hay nada parecido', () => {
    expect(elegir('quiero una moto', opciones)).toBeNull()
    expect(elegir('', opciones)).toBeNull()
  })
})

describe('navegar', () => {
  const enPortada = { vista: 'categorias', pagina: 0 }

  it('elegir una categoría pide sus locales, sin inventárselos', () => {
    const r = paso({
      mensaje: 'pizzerias', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    // No responde todavía: dice al llamador qué consultar.
    expect(r.vista).toEqual({ vista: 'negocios', categoria: 'pizzerias', pagina: 0 })
    expect(r.negocioElegido).toBeUndefined()
  })

  it('elegir un local devuelve el local, y ahí termina el menú', () => {
    const negocios = [neg('pizza-uno', 'Pizza Uno'), neg('pizza-dos', 'Pizza Dos')]
    const r = paso({
      mensaje: 'Pizza Dos',
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios,
    })
    expect(r.negocioElegido?.slug).toBe('pizza-dos')
  })

  it('«Volver» regresa a la portada, no a la página en la que estaba', () => {
    const r = paso({
      mensaje: VOLVER,
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 3 },
      categorias: CATEGORIAS, negocios: [neg('x', 'X')],
    })
    expect(r.vista).toEqual({ vista: 'categorias', pagina: 0 })
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('un mensaje que no casa repite la lista en vez de dejar al cliente colgado', () => {
    const r = paso({
      mensaje: 'aaaa', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toMatch(/No te entendí/)
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('si la categoría se queda sin locales mientras miraba, no deja una calle sin salida', () => {
    // El último local pudo cerrar entre el menú y esta respuesta.
    const r = verNegocios(CATEGORIAS[0], [], 0)
    expect(r.options).toEqual([VOLVER])
    expect(r.reply).toMatch(/no hay locales abiertos/i)
  })

  it('si la categoría desapareció del todo, vuelve a la portada', () => {
    const r = paso({
      mensaje: 'lo que sea',
      vista: { vista: 'negocios', categoria: 'ya-no-existe', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.vista.vista).toBe('categorias')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UN MENSAJE VACÍO ES REPINTAR, NO EQUIVOCARSE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Fallo REAL del 2026-08-23, visto por el dueño en su teléfono: tocaba
// «🍕 Pizzerías» y el bot le contestaba «🙏 No te entendí» — con la lista de
// locales correcta debajo. La vista avanzaba bien; solo el texto mentía.
//
// El porqué: elegir una categoría devuelve una vista SIN texto para que el
// llamador consulte los locales y vuelva a llamar. En esa segunda llamada el
// mensaje ya se consumió y llega vacío, y `elegir('')` devuelve null — que se
// trataba como «no casó ninguna opción».
describe('repintar la vista tras elegir una categoría', () => {
  const negocios = [neg('pizza-uno', 'Pizza Uno')]
  const enNegocios = { vista: 'negocios', categoria: 'pizzerias', pagina: 0 }

  it('con el mensaje vacío pinta los locales SIN reprochar nada', () => {
    const r = paso({ mensaje: '', vista: enNegocios, categorias: CATEGORIAS, negocios })
    expect(r.reply).not.toContain('No te entendí')
    expect(r.reply).toContain('Elige un local')
    expect(r.options).toContain('Pizza Uno')
  })

  it('y en la portada, igual', () => {
    const r = paso({
      mensaje: '', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).not.toContain('No te entendí')
  })

  // ⚠️ Lo que NO puede perderse: quien de verdad escribe cualquier cosa
  // estando en el menú sí tiene que saber que no se le entendió.
  it('pero una respuesta que no casa SIGUE diciendo que no se entendió', () => {
    const r = paso({
      mensaje: 'quiero un helado de mora',
      vista: enNegocios, categorias: CATEGORIAS, negocios,
    })
    expect(r.reply).toContain('No te entendí')
    expect(r.options).toContain('Pizza Uno')
  })

  it('el recorrido entero: categoría → repintado → local', () => {
    // Es el camino que el dueño no podía completar.
    const elegida = paso({
      mensaje: '🍕 Pizzerías', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(elegida.vista.categoria).toBe('pizzerias')

    const pintada = paso({
      mensaje: '', vista: elegida.vista, categorias: CATEGORIAS, negocios,
    })
    expect(pintada.reply).not.toContain('No te entendí')

    const local = paso({
      mensaje: 'Pizza Uno', vista: pintada.vista, categorias: CATEGORIAS, negocios,
    })
    expect(local.negocioElegido?.slug).toBe('pizza-uno')
  })
})

// ⚠️ `saludar` existía en `verCategorias` desde el principio y NADIE lo ponía
// en `true`: el saludo de bienvenida estaba construido y desconectado, así que
// el primerísimo mensaje de alguien que nunca había escrito recibía «🙏 No te
// entendí» como bienvenida a Umbani. Mismo patrón que `shopping_locked`.
describe('el primer mensaje de alguien que nunca ha escrito', () => {
  it('recibe la bienvenida, no un reproche', () => {
    const r = paso({
      mensaje: 'Hola buenas noches',
      vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
      primerContacto: true,
    })
    expect(r.reply).not.toContain('No te entendí')
    expect(r.reply).toContain('Bienvenido')
    expect(r.options.length).toBeGreaterThan(0)
  })

  it('pero quien YA conocía el menú sí recibe el aviso', () => {
    const r = paso({
      mensaje: 'Hola buenas noches',
      vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
      primerContacto: false,
    })
    expect(r.reply).toContain('No te entendí')
  })
})

describe('el reparto de tipos en categorías', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../migration-2026-08-21-categorias-del-marketplace.sql', import.meta.url)),
    'utf8',
  )
  const panel = readFileSync(
    fileURLToPath(new URL('../../apps/admin/src/features/clients/business-types.ts', import.meta.url)),
    'utf8',
  )

  const tiposDelPanel = () => [...panel.matchAll(/\{\s*value:\s*'([^']+)'/g)].map(([, v]) => v)
  const tiposRepartidos = () => [...sql.matchAll(/\('([^']+)','[a-z_]+'\)/g)].map(([, t]) => t)

  it('encuentra ambas listas (si no, todo lo demás pasaría en falso)', () => {
    expect(tiposDelPanel().length).toBeGreaterThanOrEqual(31)
    expect(tiposRepartidos().length).toBeGreaterThanOrEqual(31)
  })

  it('cada tipo del desplegable cae en una categoría', () => {
    // Un tipo sin categoría deja a sus locales invisibles en el menú, y nada
    // falla: simplemente nadie los encuentra nunca.
    const repartidos = new Set(tiposRepartidos())
    const huerfanos = tiposDelPanel().filter(tipo => !repartidos.has(tipo))
    expect(
      huerfanos,
      huerfanos.length
        ? 'Estos tipos no están en ninguna categoría del marketplace, así que sus\n'
          + `locales no saldrán nunca en el menú:\n${huerfanos.map(t => `  · ${t}`).join('\n')}`
        : '',
    ).toEqual([])
  })

  it('ningún tipo cae en dos categorías', () => {
    // Si pudiera, el mismo local saldría dos veces y el cliente no sabría si
    // son dos sitios distintos. Lo impide la clave primaria; esto lo vigila
    // también en el texto, que es donde se escribe el error.
    const repartidos = tiposRepartidos()
    const repetidos = repartidos.filter((t, i) => repartidos.indexOf(t) !== i)
    expect(repetidos).toEqual([])
    expect(sql).toContain('business_type text primary key')
  })

  it('el menú nunca ofrece una categoría vacía', () => {
    expect(sql).toMatch(/having count\(b\.id\) > 0/)
    // Y «disponible» significa que puede recibir un pedido AHORA.
    for (const condicion of ['b.active', 'b.suspended is not true', 'b.takes_orders', 'b.storefront_enabled']) {
      expect(sql, condicion).toContain(condicion)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL COMANDO MENÚ Y EL BLOQUEO DE FLUJO (fase 5)
// ═══════════════════════════════════════════════════════════════════════════

describe('el comando MENÚ', () => {
  it('se reconoce escrito como sea', async () => {
    const { esComandoMenu } = await import('../dist/services/marketplace-menu.js')
    for (const forma of ['menu', 'menú', 'MENU', 'MENÚ', 'Menú', '  menu  ', 'MENÚ!', 'inicio', 'cancelar']) {
      expect(esComandoMenu(forma), forma).toBe(true)
    }
  })

  it('no se dispara con un mensaje que solo lo contiene', async () => {
    const { esComandoMenu } = await import('../dist/services/marketplace-menu.js')
    // «quiero ver el menu de pizzas» es una búsqueda, no el comando global.
    for (const frase of ['quiero ver el menu de pizzas', 'menu del dia', '', 'menudo lio']) {
      expect(esComandoMenu(frase), frase).toBe(false)
    }
  })
})

describe('volver al menú con un pedido en marcha', () => {
  it('NO borra nada sin preguntar', async () => {
    const { responderAlMenu, SI_REINICIAR, NO_CONTINUAR } =
      await import('../dist/services/marketplace-menu.js')
    // El cliente pudo escribir «menú» buscando ayuda, no queriendo tirar lo
    // que llevaba — y la mini app de ese local sigue abierta en su teléfono.
    const r = responderAlMenu(
      { bloqueado: true, negocio: { name: 'El Puerto', slug: 'el-puerto' } },
      CATEGORIAS,
    )
    expect(r.vista.vista).toBe('confirmando_reinicio')
    expect(r.reply).toContain('El Puerto')
    expect(r.options).toEqual([SI_REINICIAR, NO_CONTINUAR])
  })

  it('sin pedido en marcha, vuelve al menú directo', async () => {
    const { responderAlMenu } = await import('../dist/services/marketplace-menu.js')
    const r = responderAlMenu({ bloqueado: false, negocio: null }, CATEGORIAS)
    expect(r.vista.vista).toBe('categorias')
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('«sí» reinicia y «no» conserva el pedido', async () => {
    const { resolverReinicio, SI_REINICIAR, NO_CONTINUAR } =
      await import('../dist/services/marketplace-menu.js')
    const estado = { bloqueado: true, negocio: { name: 'El Puerto', slug: 'el-puerto' } }

    expect(resolverReinicio(SI_REINICIAR, estado, CATEGORIAS).reinicia).toBe(true)
    expect(resolverReinicio('1', estado, CATEGORIAS).reinicia).toBe(true)

    const no = resolverReinicio(NO_CONTINUAR, estado, CATEGORIAS)
    expect(no.reinicia).toBe(false)
    expect(no.respuesta.reply).toContain('El Puerto')
  })

  it('ante una respuesta ambigua NO decide por el cliente', async () => {
    const { resolverReinicio } = await import('../dist/services/marketplace-menu.js')
    // Tirar un carrito por un «ok» ambiguo es lo único que no tiene vuelta
    // atrás: se repite la pregunta.
    const r = resolverReinicio('ok', { bloqueado: true, negocio: { name: 'X', slug: 'x' } }, CATEGORIAS)
    expect(r.reinicia).toBe(false)
    expect(r.respuesta.vista.vista).toBe('confirmando_reinicio')
  })
})

describe('intentar empezar otra cosa con un pedido abierto', () => {
  it('dice dónde lo tiene y cómo salir, en el mismo mensaje', async () => {
    const { recordarPedidoEnProceso } = await import('../dist/services/marketplace-menu.js')
    // ⚠️ Cada respuesta se paga: no se gasta un mensaje en decir solo «no».
    const r = recordarPedidoEnProceso({ name: 'El Puerto' })
    expect(r.reply).toContain('El Puerto')

    // ⚠️ CAMBIADO EL 2026-08-23, y la intención es la MISMA: decirle cómo
    // salir. Antes el texto mandaba «escribe *MENÚ*»… y escribir MENÚ llevaba
    // a una pregunta que MENÚ no podía responder, así que el cliente se
    // quedaba dando vueltas. Ahora se le dan las dos salidas de verdad.
    expect(r.options).toHaveLength(2)
    expect(r.options.join(' ')).toMatch(/Empezar de nuevo/)
    expect(r.options.join(' ')).toMatch(/Seguir mi pedido/)
    expect(r.vista.vista).toBe('confirmando_reinicio')
  })

  // ⚠️ EL BUCLE que vivió el dueño: «sigue enviando y enviando lo mismo».
  // MENÚ se comprueba antes que la vista, así que escribirlo estando ya en la
  // confirmación volvía a preguntar lo mismo, para siempre.
  //
  // Pedir el menú DOS VECES no es ambiguo: es la misma petición repetida.
  it('un segundo MENÚ confirma en vez de volver a preguntar', async () => {
    const entrada = await import('../dist/services/marketplace-entry.js')
    const fuente = readFileSync(
      fileURLToPath(new URL('../src/services/marketplace-entry.ts', import.meta.url)),
      'utf8',
    )
    expect(entrada.handleMarketplaceMessage).toBeTypeOf('function')
    // La rama existe y suelta el local, que es lo que rompe el bucle.
    expect(fuente).toMatch(/vista\.vista === 'confirmando_reinicio'[\s\S]{0,400}soltarLocal: true/)
  })
})

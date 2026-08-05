import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const repo = require('../dist/db/repositories/product-options')

// ═══════════════════════════════════════════════════════════════════════════
// EL REPOSITORIO DEL MOTOR DE OPCIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// Es la capa por la que el DUEÑO escribe su catálogo. Lo único que hay que
// vigilar aquí, y no es poco:
//
//   · que TODA consulta filtre por `business_id` — sin eso, un negocio edita
//     la carta de otro y la foránea compuesta no lo impediría, porque el id
//     que llega ya es el correcto para esa fila;
//   · que las escrituras inyecten el `business_id` recibido, sin dejar que
//     venga en los datos;
//   · que las lecturas pidan columnas EXPLÍCITAS: un `select('*')` aquí se
//     llevaría el embedding de 1536 números al panel.

afterEach(() => { vi.restoreAllMocks() })

const NEGOCIO = '98a67b29-7a2c-47eb-94cb-f465c391e16f'

/** Encadenable de Supabase: cada método devuelve el mismo objeto. */
function encadenable(resultado = { data: [], error: null }) {
  const cadena = {}
  const registro = { eqs: [], select: null, insert: null, update: null, borrado: false }
  for (const metodo of ['select', 'eq', 'order', 'insert', 'update', 'delete', 'single', 'maybeSingle', 'not']) {
    cadena[metodo] = vi.fn((...args) => {
      if (metodo === 'select' && args.length) registro.select = args[0]
      if (metodo === 'eq') registro.eqs.push(args)
      if (metodo === 'insert') registro.insert = args[0]
      if (metodo === 'update') registro.update = args[0]
      if (metodo === 'delete') registro.borrado = true
      return cadena
    })
  }
  cadena.then = (resolve) => Promise.resolve(resultado).then(resolve)
  cadena.__registro = registro
  return cadena
}

const espiar = (resultado) => {
  const cadena = encadenable(resultado)
  const from = vi.spyOn(client, 'from').mockReturnValue(cadena)
  return { cadena, from, registro: cadena.__registro }
}

describe('lecturas del motor de opciones', () => {
  it('los grupos se filtran por negocio y piden columnas explícitas', async () => {
    const { from, registro } = espiar({ data: [{ id: 'g1' }], error: null })

    const filas = await repo.getOptionGroups(NEGOCIO)

    expect(from).toHaveBeenCalledWith('option_groups')
    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    // Ni un `*`: el panel no necesita —ni debe recibir— lo que no se pidió.
    expect(registro.select).not.toContain('*')
    expect(registro.select).toContain('pricing_strategy')
    expect(filas).toEqual([{ id: 'g1' }])
  })

  it('las opciones también, y sin traer el negocio de vuelta', async () => {
    const { from, registro } = espiar({ data: [], error: null })
    await repo.getOptions(NEGOCIO)
    expect(from).toHaveBeenCalledWith('options')
    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(registro.select).not.toContain('business_id')
  })

  it('buscar por id exige negocio Y id, nunca solo el id', async () => {
    const { registro } = espiar({ data: { id: 'g1' }, error: null })

    await repo.getOptionGroupById(NEGOCIO, 'g1')

    // El id solo diría «esa fila existe»; con el negocio dice «es suya».
    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(registro.eqs).toContainEqual(['id', 'g1'])
  })

  it('una opción que no existe devuelve null, no undefined', async () => {
    espiar({ data: null, error: null })
    await expect(repo.getOptionById(NEGOCIO, 'no-existe')).resolves.toBeNull()
  })

  it('si la base falla al leer, se lanza en vez de devolver una lista vacía', async () => {
    espiar({ data: null, error: { message: 'conexión caída' } })
    // Devolver [] sería peor que fallar: el panel diría «no tienes opciones»
    // y el dueño creería que se le borró la carta.
    await expect(repo.getOptionGroups(NEGOCIO)).rejects.toThrow(/conexión caída/)
  })

  it('las plantillas y sus ítems se filtran igual', async () => {
    const primera = espiar({ data: [], error: null })
    await repo.getOptionTemplates(NEGOCIO)
    expect(primera.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const segunda = espiar({ data: [], error: null })
    await repo.getOptionTemplateItems(NEGOCIO)
    expect(segunda.from).toHaveBeenCalledWith('option_template_items')
    expect(segunda.registro.eqs).toContainEqual(['business_id', NEGOCIO])
  })

  it('el uso de plantillas solo mira los grupos que tienen una', async () => {
    const { cadena, registro } = espiar({ data: [{ option_template_id: 'p1' }], error: null })
    const filas = await repo.getOptionTemplateUsage(NEGOCIO)
    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(cadena.not).toHaveBeenCalledWith('option_template_id', 'is', null)
    expect(filas).toEqual([{ option_template_id: 'p1' }])
  })
})

describe('escrituras del motor de opciones', () => {
  it('crear inyecta el business_id recibido', async () => {
    const { from, registro } = espiar({ data: { id: 'g1' }, error: null })

    await repo.createOptionGroup(NEGOCIO, { name: 'Término' })

    expect(from).toHaveBeenCalledWith('option_groups')
    expect(registro.insert).toEqual({ name: 'Término', business_id: NEGOCIO })
  })

  // El negocio lo pone SIEMPRE el repositorio, encima de lo que traigan los
  // datos: si el de fuera ganara, bastaría con mandarlo en el cuerpo.
  it('un business_id en los datos no puede ganarle al del argumento', async () => {
    const { registro } = espiar({ data: {}, error: null })

    await repo.createOption(NEGOCIO, { name: 'X', business_id: 'negocio-de-otro' })

    expect(registro.insert.business_id).toBe(NEGOCIO)
  })

  it('actualizar filtra por negocio e id, y sella la fecha', async () => {
    const { registro } = espiar({ data: null, error: null })

    await repo.updateOptionGroup(NEGOCIO, 'g1', { name: 'Nuevo' })

    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(registro.eqs).toContainEqual(['id', 'g1'])
    expect(registro.update.updated_at).toEqual(expect.any(String))
  })

  it('borrar nunca va solo por id', async () => {
    const { registro } = espiar({ data: null, error: null })

    await repo.deleteOption(NEGOCIO, 'o1')

    expect(registro.borrado).toBe(true)
    expect(registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(registro.eqs).toContainEqual(['id', 'o1'])
  })

  it('las plantillas y sus ítems se escriben con las mismas reglas', async () => {
    const crear = espiar({ data: {}, error: null })
    await repo.createOptionTemplate(NEGOCIO, { name: 'Sabores' })
    expect(crear.registro.insert.business_id).toBe(NEGOCIO)

    vi.restoreAllMocks()
    const item = espiar({ data: {}, error: null })
    await repo.createOptionTemplateItem(NEGOCIO, { name: 'Hawaiana' })
    expect(item.from).toHaveBeenCalledWith('option_template_items')
    expect(item.registro.insert.business_id).toBe(NEGOCIO)

    vi.restoreAllMocks()
    const editar = espiar({ data: null, error: null })
    await repo.updateOptionTemplateItem(NEGOCIO, 'i1', { name: 'Otra' })
    expect(editar.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const borrar = espiar({ data: null, error: null })
    await repo.deleteOptionTemplate(NEGOCIO, 'p1')
    expect(borrar.registro.eqs).toContainEqual(['business_id', NEGOCIO])
    expect(borrar.registro.borrado).toBe(true)
  })

  it('editar y borrar una plantilla filtran por negocio', async () => {
    const editar = espiar({ data: null, error: null })
    await repo.updateOptionTemplate(NEGOCIO, 'p1', { name: 'X' })
    expect(editar.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const borrar = espiar({ data: null, error: null })
    await repo.deleteOptionGroup(NEGOCIO, 'g1')
    expect(borrar.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const item = espiar({ data: null, error: null })
    await repo.deleteOptionTemplateItem(NEGOCIO, 'i1')
    expect(item.registro.eqs).toContainEqual(['business_id', NEGOCIO])
  })

  it('editar una opción y un ítem también filtran por negocio', async () => {
    const opcion = espiar({ data: null, error: null })
    await repo.updateOption(NEGOCIO, 'o1', { name: 'X' })
    expect(opcion.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const buscarPlantilla = espiar({ data: { id: 'p1' }, error: null })
    await repo.getOptionTemplateById(NEGOCIO, 'p1')
    expect(buscarPlantilla.registro.eqs).toContainEqual(['business_id', NEGOCIO])

    vi.restoreAllMocks()
    const buscarItem = espiar({ data: { id: 'i1' }, error: null })
    await repo.getOptionTemplateItemById(NEGOCIO, 'i1')
    expect(buscarItem.registro.eqs).toContainEqual(['business_id', NEGOCIO])
  })
})

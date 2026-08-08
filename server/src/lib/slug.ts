// La dirección de la tienda de un negocio: `/t/<slug>`.
//
// Viaja en un WhatsApp y la lee una persona, así que importa que sea corta y
// que se entienda: `monster-pizza` dice de quién es; `monster-pizza-1785656324571`
// parece un identificador de sistema y ocupa el doble.

/**
 * El nombre del negocio convertido en dirección.
 *
 * ⚠️ Las tildes se CONVIERTEN, no se borran. La versión anterior hacía
 * `replace(/[^a-z0-9-]/g, '')` sobre el nombre en crudo, así que «Heladería»
 * acababa en `heladera` —sin la i— y «Cafetería Ñandú» en `cafetera-and`.
 * Normalizar primero deja `heladeria` y `cafeteria-nandu`, que es lo que el
 * dueño esperaría ver.
 *
 * Devuelve cadena vacía si del nombre no queda nada utilizable —un nombre solo
 * en caracteres que no son latinos—, y ahí decide quien llame: aquí no se
 * inventa una dirección.
 */
export const slugify = (nombre: string): string => nombre
  .normalize('NFD')
  // Se quitan los diacríticos DESPUÉS de separar la letra de su tilde: así la
  // letra base sobrevive en vez de perderse entera.
  .replace(/[̀-ͯ]/g, '')
  // La eñe no lleva diacrítico separable en NFD para todos los casos, y sin
  // esto «ñ» desaparecería del nombre.
  .replace(/ñ/gi, 'n')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  // Guiones de sobra al principio, al final o repetidos: «Pizza  —  Don Pepe»
  // no puede dar `pizza---don-pepe`.
  .replace(/^-+|-+$/g, '')
  .slice(0, 60)
  .replace(/-+$/g, '')

/**
 * El primer slug libre a partir de un nombre.
 *
 * `existe` decide: se le pasa la comprobación contra la base en vez de
 * consultarla aquí, para que esto siga siendo una función pura y se pueda
 * probar sin levantar nada.
 *
 * El sufijo numérico solo aparece cuando de verdad hay choque —«Pizzería Don
 * Pepe» y otra «Pizzería Don Pepe» distinta—, que es lo que el `Date.now()`
 * anterior hacía SIEMPRE por si acaso.
 */
export const slugLibre = async (
  nombre: string,
  existe: (slug: string) => Promise<boolean>,
  /** Cuántas variantes se prueban antes de rendirse. */
  intentos = 50,
): Promise<string> => {
  const base = slugify(nombre) || 'negocio'
  if (!await existe(base)) return base

  for (let numero = 2; numero <= intentos; numero += 1) {
    const candidato = `${base}-${numero}`
    if (!await existe(candidato)) return candidato
  }

  // Cincuenta negocios con el mismo nombre es un caso que no va a ocurrir,
  // pero rendirse en silencio daría un slug repetido y el alta fallaría con un
  // error de restricción que no explica nada. El reloj garantiza unicidad.
  return `${base}-${Date.now()}`
}

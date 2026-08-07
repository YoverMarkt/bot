import type {
  BusinessTemplate,
  TemplateCategory,
  TemplateGroup,
} from '../db/types'

// ══════════════════════════════════════════════════════════════════════════
// PLANTILLAS POR TIPO DE NEGOCIO
//
// Con qué catálogo NACE un negocio recién creado: sus categorías y los grupos
// de opciones típicos de cada una. Es lo que convierte «dar de alta una
// hamburguesería» en cargar datos en vez de escribirlo todo a mano.
//
// Los grupos cuelgan de la CATEGORÍA, nunca de un producto, porque al crear el
// negocio todavía no existe ninguno (migration-2026-08-05-grupos-por-categoria).
//
// ⚠️ El tipo solo RECOMIENDA al crear. La RPC `apply_business_template` no
// toca un negocio que ya tenga catálogo, así que esto jamás pisa decisiones
// manuales ni negocios existentes. Es la misma regla de `takes_orders`,
// `chat_mode` y `storefront_enabled`.
//
// Los nombres de tipo tienen que existir en el desplegable del panel
// (`apps/admin/src/features/clients/business-types.ts`) o el tipo no se puede
// elegir y la plantilla queda muerta. Lo vigila `plantillas-negocio.test.js`.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Misma normalización que usa el panel: minúsculas, sin espacios de sobra y
 * sin acentos, para que «Hamburguesería» y «hamburgueseria» sean el mismo
 * tipo. Se duplica a propósito —son cinco líneas— porque el panel es un
 * paquete aparte y no comparte código con el servidor.
 */
const normalizeBusinessType = (value: string): string => value
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

// ── Grupos que se repiten en muchas cartas ────────────────────────────────

const terminoDeLaCarne: TemplateGroup = {
  nombre: 'Término de la carne',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Término medio' },
    { nombre: 'Tres cuartos' },
    { nombre: 'Bien cocida' },
  ],
}

const extrasHamburguesa: TemplateGroup = {
  nombre: 'Extras',
  tipo: 'multiple',
  max: 6,
  opciones: [
    { nombre: 'Queso extra', recargo: 0.75 },
    { nombre: 'Tocino', recargo: 1 },
    { nombre: 'Huevo', recargo: 0.75 },
    { nombre: 'Doble carne', recargo: 2.5 },
    { nombre: 'Aguacate', recargo: 1 },
  ],
}

/**
 * Quitar ingredientes no cuesta nada, pero tiene que poder pedirse: si el
 * cliente no encuentra «sin cebolla» lo escribe en las notas, y las notas no
 * las lee la cocina hasta que el pedido ya está armado.
 */
const retirarIngredientes: TemplateGroup = {
  nombre: 'Retira ingredientes',
  tipo: 'multiple',
  max: 8,
  opciones: [
    { nombre: 'Sin cebolla' },
    { nombre: 'Sin tomate' },
    { nombre: 'Sin lechuga' },
    { nombre: 'Sin salsas' },
    { nombre: 'Sin pepinillos' },
  ],
}

const puntoDePicante: TemplateGroup = {
  nombre: 'Punto de picante',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Sin picante' },
    { nombre: 'Suave' },
    { nombre: 'Picante' },
    { nombre: 'Muy picante' },
  ],
}

const tamanoPorcion: TemplateGroup = {
  nombre: 'Tamaño',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Pequeño', recargo: 0 },
    { nombre: 'Mediano', recargo: 1.5 },
    { nombre: 'Grande', recargo: 3 },
  ],
}

const acompananteIncluido: TemplateGroup = {
  nombre: 'Acompañante',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Papas fritas' },
    { nombre: 'Arroz' },
    { nombre: 'Ensalada' },
    { nombre: 'Menestra' },
    { nombre: 'Patacones' },
  ],
}

const bebidaIncluida: TemplateGroup = {
  nombre: 'Bebida incluida',
  tipo: 'single',
  obligatorio: true,
  min: 1,
  max: 1,
  opciones: [
    { nombre: 'Jugo natural' },
    { nombre: 'Cola personal' },
    { nombre: 'Agua' },
    { nombre: 'Té helado' },
  ],
}

// ── Categorías que se repiten ─────────────────────────────────────────────

const bebidas = (orden: number): TemplateCategory => ({ nombre: 'Bebidas', orden })
const postres = (orden: number): TemplateCategory => ({ nombre: 'Postres', orden })
const acompanantes = (orden: number): TemplateCategory => ({ nombre: 'Acompañantes', orden })

/**
 * El almuerzo ecuatoriano: sopa, segundo, guarnición y bebida, y los cuatro
 * obligatorios. Es el caso que no cabía en el modelo viejo —sin grupos
 * obligatorios no se puede armar— y por el que existe el motor de opciones.
 */
const gruposDelAlmuerzo: TemplateGroup[] = [
  {
    nombre: 'Sopa',
    tipo: 'single',
    obligatorio: true,
    min: 1,
    max: 1,
    opciones: [
      { nombre: 'Sopa del día' },
      { nombre: 'Crema del día' },
      // Un ajuste NEGATIVO: quien no quiere sopa paga menos. Es la razón por
      // la que `price_adjustment` admite negativos.
      { nombre: 'Sin sopa', recargo: -0.5 },
    ],
  },
  {
    nombre: 'Segundo',
    tipo: 'single',
    obligatorio: true,
    min: 1,
    max: 1,
    opciones: [
      { nombre: 'Pollo' },
      { nombre: 'Carne' },
      { nombre: 'Pescado', recargo: 0.5 },
      { nombre: 'Vegetariano' },
    ],
  },
  { ...acompananteIncluido, nombre: 'Guarnición' },
  bebidaIncluida,
]

const plantilla = (categorias: TemplateCategory[]): BusinessTemplate => ({ categorias })

// ── El catálogo, tipo por tipo ────────────────────────────────────────────
// La clave va normalizada: así entra igual «Hamburguesería» que lo que el
// panel manda de verdad.

const PLANTILLAS: Record<string, BusinessTemplate> = {
  hamburgueseria: plantilla([
    {
      nombre: 'Hamburguesas',
      orden: 0,
      grupos: [terminoDeLaCarne, extrasHamburguesa, retirarIngredientes],
    },
    { nombre: 'Combos', orden: 1, grupos: [acompananteIncluido, bebidaIncluida] },
    acompanantes(2),
    bebidas(3),
  ]),

  'comida rapida': plantilla([
    { nombre: 'Hamburguesas', orden: 0, grupos: [extrasHamburguesa, retirarIngredientes] },
    { nombre: 'Salchipapas', orden: 1, grupos: [tamanoPorcion, retirarIngredientes] },
    { nombre: 'Hot dogs', orden: 2, grupos: [retirarIngredientes] },
    { nombre: 'Combos', orden: 3, grupos: [acompananteIncluido, bebidaIncluida] },
    bebidas(4),
  ]),

  almuerzos: plantilla([
    { nombre: 'Almuerzos', orden: 0, grupos: gruposDelAlmuerzo },
    { nombre: 'Platos a la carta', orden: 1, grupos: [acompananteIncluido] },
    bebidas(2),
    postres(3),
  ]),

  'menu ejecutivo': plantilla([
    { nombre: 'Menú ejecutivo', orden: 0, grupos: gruposDelAlmuerzo },
    { nombre: 'Platos a la carta', orden: 1, grupos: [acompananteIncluido] },
    bebidas(2),
    postres(3),
  ]),

  'comida tipica': plantilla([
    { nombre: 'Platos típicos', orden: 0, grupos: [tamanoPorcion, acompananteIncluido] },
    { nombre: 'Sopas y caldos', orden: 1, grupos: [tamanoPorcion] },
    acompanantes(2),
    bebidas(3),
  ]),

  desayunos: plantilla([
    {
      nombre: 'Desayunos',
      orden: 0,
      grupos: [
        {
          nombre: 'Huevos',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Revueltos' },
            { nombre: 'Fritos' },
            { nombre: 'Tortilla' },
            { nombre: 'Sin huevos', recargo: -0.5 },
          ],
        },
        bebidaIncluida,
      ],
    },
    { nombre: 'Bolones y tigrillos', orden: 1, grupos: [retirarIngredientes] },
    { nombre: 'Panadería', orden: 2 },
    bebidas(3),
  ]),

  asadero: plantilla([
    { nombre: 'Asados', orden: 0, grupos: [terminoDeLaCarne, acompananteIncluido] },
    { nombre: 'Combos familiares', orden: 1, grupos: [acompananteIncluido, bebidaIncluida] },
    acompanantes(2),
    bebidas(3),
  ]),

  parrillada: plantilla([
    {
      nombre: 'Parrilladas',
      orden: 0,
      grupos: [
        // El caso de `quantity`: una parrillada de cuatro porciones se arma
        // repartiéndolas entre cortes, no eligiendo uno solo.
        {
          nombre: 'Elige tus cortes',
          tipo: 'quantity',
          obligatorio: true,
          min: 1,
          max: 8,
          opciones: [
            { nombre: 'Lomo fino', recargo: 2 },
            { nombre: 'Chuleta' },
            { nombre: 'Chorizo' },
            { nombre: 'Morcilla' },
            { nombre: 'Pollo' },
            { nombre: 'Costilla', recargo: 1.5 },
          ],
        },
        terminoDeLaCarne,
      ],
    },
    { nombre: 'Platos individuales', orden: 1, grupos: [terminoDeLaCarne, acompananteIncluido] },
    acompanantes(2),
    bebidas(3),
  ]),

  'pollo asado': plantilla([
    {
      nombre: 'Pollo asado',
      orden: 0,
      grupos: [
        {
          nombre: 'Presa',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Pollo entero' },
            { nombre: 'Medio pollo' },
            { nombre: 'Cuarto de pollo' },
          ],
        },
        acompananteIncluido,
      ],
    },
    { nombre: 'Broaster', orden: 1, grupos: [acompananteIncluido] },
    acompanantes(2),
    bebidas(3),
  ]),

  marisqueria: plantilla([
    { nombre: 'Ceviches', orden: 0, grupos: [tamanoPorcion, puntoDePicante] },
    { nombre: 'Encebollados', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Arroces y platos marinos', orden: 2, grupos: [acompananteIncluido] },
    { nombre: 'Sopas', orden: 3, grupos: [tamanoPorcion] },
    bebidas(4),
  ]),

  sushi: plantilla([
    {
      nombre: 'Rolls',
      orden: 0,
      grupos: [
        {
          nombre: 'Salsas',
          tipo: 'multiple',
          max: 4,
          opciones: [
            { nombre: 'Soya' },
            { nombre: 'Teriyaki' },
            { nombre: 'Acevichada', recargo: 0.5 },
            { nombre: 'Sriracha' },
          ],
        },
        { ...retirarIngredientes, opciones: [{ nombre: 'Sin palta' }, { nombre: 'Sin queso crema' }, { nombre: 'Sin ajonjolí' }] },
      ],
    },
    { nombre: 'Combos', orden: 1 },
    { nombre: 'Entradas', orden: 2 },
    bebidas(3),
  ]),

  'comida mexicana': plantilla([
    { nombre: 'Tacos', orden: 0, grupos: [puntoDePicante, retirarIngredientes] },
    { nombre: 'Burritos y quesadillas', orden: 1, grupos: [puntoDePicante, retirarIngredientes] },
    { nombre: 'Nachos', orden: 2, grupos: [puntoDePicante] },
    bebidas(3),
  ]),

  'comida china': plantilla([
    { nombre: 'Chaulafán', orden: 0, grupos: [tamanoPorcion] },
    { nombre: 'Tallarines', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Chifa combinados', orden: 2, grupos: [tamanoPorcion, acompananteIncluido] },
    bebidas(3),
  ]),

  'comida saludable': plantilla([
    {
      nombre: 'Bowls',
      orden: 0,
      grupos: [
        {
          nombre: 'Base',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Quinua' },
            { nombre: 'Arroz integral' },
            { nombre: 'Hojas verdes' },
          ],
        },
        {
          nombre: 'Proteína',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Pollo' },
            { nombre: 'Atún' },
            { nombre: 'Tofu' },
            { nombre: 'Sin proteína', recargo: -1 },
          ],
        },
        {
          nombre: 'Toppings',
          tipo: 'multiple',
          max: 5,
          opciones: [
            { nombre: 'Aguacate', recargo: 1 },
            { nombre: 'Semillas' },
            { nombre: 'Queso', recargo: 0.75 },
            { nombre: 'Frutos secos', recargo: 1 },
          ],
        },
      ],
    },
    { nombre: 'Ensaladas', orden: 1 },
    { nombre: 'Wraps', orden: 2 },
    bebidas(3),
  ]),

  heladeria: plantilla([
    {
      nombre: 'Helados',
      orden: 0,
      grupos: [
        {
          nombre: 'Sabores',
          tipo: 'quantity',
          obligatorio: true,
          min: 1,
          max: 4,
          opciones: [
            { nombre: 'Vainilla' },
            { nombre: 'Chocolate' },
            { nombre: 'Frutilla' },
            { nombre: 'Mora' },
            { nombre: 'Ron pasas' },
          ],
        },
        {
          nombre: 'Toppings',
          tipo: 'multiple',
          max: 4,
          opciones: [
            { nombre: 'Chispas' },
            { nombre: 'Salsa de chocolate', recargo: 0.5 },
            { nombre: 'Galleta', recargo: 0.5 },
            { nombre: 'Crema chantillí', recargo: 0.75 },
          ],
        },
      ],
    },
    { nombre: 'Copas y sundaes', orden: 1 },
    { nombre: 'Malteadas', orden: 2 },
  ]),

  pasteleria: plantilla([
    {
      nombre: 'Tortas',
      orden: 0,
      grupos: [
        {
          nombre: 'Tamaño',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: '10 porciones' },
            { nombre: '20 porciones', recargo: 12 },
            { nombre: '30 porciones', recargo: 24 },
          ],
        },
        {
          nombre: 'Relleno',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Manjar' },
            { nombre: 'Chocolate' },
            { nombre: 'Frutas' },
            { nombre: 'Sin relleno' },
          ],
        },
      ],
    },
    { nombre: 'Porciones individuales', orden: 1 },
    { nombre: 'Bocaditos', orden: 2 },
    bebidas(3),
  ]),

  postres: plantilla([
    { nombre: 'Postres', orden: 0, grupos: [tamanoPorcion] },
    { nombre: 'Tortas', orden: 1 },
    bebidas(2),
  ]),

  batidos: plantilla([
    {
      nombre: 'Batidos',
      orden: 0,
      grupos: [
        {
          nombre: 'Frutas',
          tipo: 'multiple',
          obligatorio: true,
          min: 1,
          max: 3,
          opciones: [
            { nombre: 'Frutilla' },
            { nombre: 'Mora' },
            { nombre: 'Banana' },
            { nombre: 'Mango' },
            { nombre: 'Maracuyá' },
          ],
        },
        {
          nombre: 'Con qué se prepara',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Leche' },
            { nombre: 'Agua', recargo: -0.25 },
            { nombre: 'Yogurt', recargo: 0.5 },
          ],
        },
        tamanoPorcion,
      ],
    },
    { nombre: 'Jugos', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Snacks', orden: 2 },
  ]),

  jugos: plantilla([
    {
      nombre: 'Jugos naturales',
      orden: 0,
      grupos: [
        {
          nombre: 'Fruta',
          tipo: 'multiple',
          obligatorio: true,
          min: 1,
          max: 3,
          opciones: [
            { nombre: 'Naranja' },
            { nombre: 'Mora' },
            { nombre: 'Maracuyá' },
            { nombre: 'Tomate de árbol' },
            { nombre: 'Papaya' },
          ],
        },
        tamanoPorcion,
      ],
    },
    { nombre: 'Batidos', orden: 1, grupos: [tamanoPorcion] },
    { nombre: 'Desayunos', orden: 2 },
  ]),

  carniceria: plantilla([
    {
      nombre: 'Cortes de res',
      orden: 0,
      grupos: [
        {
          nombre: 'Preparación',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Entero' },
            { nombre: 'En bistec' },
            { nombre: 'En trozos' },
            { nombre: 'Molido' },
          ],
        },
      ],
    },
    { nombre: 'Cortes de cerdo', orden: 1 },
    { nombre: 'Pollo', orden: 2 },
    { nombre: 'Embutidos', orden: 3 },
    { nombre: 'Preparados y adobados', orden: 4 },
  ]),

  'emprendimiento de comida': plantilla([
    { nombre: 'Nuestros platos', orden: 0, grupos: [tamanoPorcion, retirarIngredientes] },
    { nombre: 'Combos', orden: 1, grupos: [bebidaIncluida] },
    bebidas(2),
  ]),

  // Los que ya existían en el desplegable y también son cocina.
  pizzeria: plantilla([
    {
      nombre: 'Pizzas',
      orden: 0,
      grupos: [
        {
          nombre: 'Tamaño',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Personal' },
            { nombre: 'Mediana', recargo: 4 },
            { nombre: 'Familiar', recargo: 8 },
          ],
        },
        {
          nombre: 'Ingredientes extra',
          tipo: 'multiple',
          max: 6,
          opciones: [
            { nombre: 'Queso extra', recargo: 1.5 },
            { nombre: 'Peperoni', recargo: 1.5 },
            { nombre: 'Champiñones', recargo: 1 },
            { nombre: 'Jamón', recargo: 1.5 },
          ],
        },
      ],
    },
    { nombre: 'Combos', orden: 1, grupos: [bebidaIncluida] },
    acompanantes(2),
    bebidas(3),
  ]),

  restaurante: plantilla([
    { nombre: 'Entradas', orden: 0 },
    { nombre: 'Platos fuertes', orden: 1, grupos: [acompananteIncluido] },
    { nombre: 'Sopas', orden: 2, grupos: [tamanoPorcion] },
    postres(3),
    bebidas(4),
  ]),

  cafeteria: plantilla([
    {
      nombre: 'Café',
      orden: 0,
      grupos: [
        {
          nombre: 'Tamaño',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Pequeño' },
            { nombre: 'Mediano', recargo: 0.5 },
            { nombre: 'Grande', recargo: 1 },
          ],
        },
        {
          nombre: 'Tipo de leche',
          tipo: 'single',
          obligatorio: true,
          min: 1,
          max: 1,
          opciones: [
            { nombre: 'Entera' },
            { nombre: 'Deslactosada' },
            { nombre: 'De almendras', recargo: 0.75 },
            { nombre: 'Sin leche' },
          ],
        },
      ],
    },
    { nombre: 'Panadería', orden: 1 },
    postres(2),
    { nombre: 'Sánduches', orden: 3, grupos: [retirarIngredientes] },
  ]),

  panaderia: plantilla([
    { nombre: 'Pan del día', orden: 0 },
    { nombre: 'Pastelería', orden: 1 },
    { nombre: 'Bocaditos', orden: 2 },
    bebidas(3),
  ]),
}

/**
 * La plantilla del tipo, o `null` si ese tipo no tiene ninguna —que es lo
 * normal: una ferretería o una perfumería no traen carta.
 *
 * Casa primero por tipo exacto y después por contención, igual que las
 * recomendaciones del panel: un tipo escrito a mano como «hamburguesería
 * gourmet» debe nacer con la carta de hamburguesería. Ante varias plantillas
 * candidatas gana la de nombre más largo, que es la más específica: «comida
 * rápida» no puede perder contra un hipotético «comida».
 */
export const templateForBusinessType = (type?: string | null): BusinessTemplate | null => {
  const normalized = normalizeBusinessType(type || '')
  if (!normalized) return null

  const exacta = PLANTILLAS[normalized]
  if (exacta) return exacta

  const candidatas = Object.keys(PLANTILLAS)
    .filter(clave => normalized.includes(clave))
    .sort((a, b) => b.length - a.length)

  return candidatas.length ? PLANTILLAS[candidatas[0]] as BusinessTemplate : null
}

/** Los tipos con plantilla. Lo usa la prueba que los contrasta con el panel. */
export const businessTypesWithTemplate = (): string[] => Object.keys(PLANTILLAS)

// ══════════════════════════════════════════════════════════════════════════
// CUÁNTO TARDA CADA TIPO DE NEGOCIO
//
// Con qué tiempo de preparación NACE un negocio, igual que nace con su carta.
// Antes era 30 minutos para todos, escrito a mano en la ruta de la tienda: una
// heladería y un asadero ofrecían las mismas franjas, y una de las dos siempre
// mentía.
//
// ⚠️ Misma regla que las plantillas y las capacidades: **solo recomienda al
// crear**. En cuanto el negocio existe manda su dueño desde el panel, y nada
// de aquí vuelve a tocarlo. El dueño conoce su cocina; esto solo evita que
// empiece con un número inventado.
//
// El defecto de los tipos que no están listados son 25 minutos, que es lo que
// tarda una cocina normal y el valor por defecto de la columna en la base.
// ══════════════════════════════════════════════════════════════════════════

const MINUTOS_POR_TIPO: Record<string, number> = {
  // Se sirve al momento: ya está hecho, solo hay que despacharlo.
  heladeria: 10,
  postres: 10,
  batidos: 10,
  jugos: 10,
  // Se arma en el mostrador.
  cafeteria: 15,
  panaderia: 15,
  pasteleria: 15,
  desayunos: 15,
  tienda: 15,
  farmacia: 15,
  supermercado: 15,
  ferreteria: 15,
  perfumeria: 15,
  // Cocina rápida, pensada para salir deprisa.
  'comida rapida': 20,
  hamburgueseria: 20,
  sushi: 20,
  'comida china': 20,
  // Cocina de plato, que es el caso normal (y el defecto de la columna).
  pizzeria: 25,
  restaurante: 25,
  almuerzos: 25,
  'menu ejecutivo': 25,
  'comida tipica': 25,
  'comida mexicana': 25,
  'comida saludable': 25,
  'emprendimiento de comida': 25,
  // Carbón y leña: no se acelera, y prometer menos deja al cliente esperando
  // en la puerta.
  asadero: 40,
  parrillada: 40,
  'pollo asado': 40,
  marisqueria: 40,
  carniceria: 40,
}

/** Lo que tarda una cocina normal, y el defecto de la columna en la base. */
export const PREP_TIME_POR_DEFECTO = 25

/**
 * Los minutos con los que nace un negocio de este tipo.
 *
 * Casa igual que `templateForBusinessType` —exacto primero, después por
 * contención y gana el más largo— para que un tipo escrito a mano como
 * «heladería artesanal» herede los diez minutos de la heladería en vez de
 * caer al defecto.
 */
export const prepTimeForBusinessType = (type?: string | null): number => {
  const normalized = normalizeBusinessType(type || '')
  if (!normalized) return PREP_TIME_POR_DEFECTO

  const exacto = MINUTOS_POR_TIPO[normalized]
  if (exacto) return exacto

  const candidatos = Object.keys(MINUTOS_POR_TIPO)
    .filter(clave => normalized.includes(clave))
    .sort((a, b) => b.length - a.length)

  return candidatos.length ? MINUTOS_POR_TIPO[candidatos[0]] : PREP_TIME_POR_DEFECTO
}

/** Los tipos con tiempo propio. Lo usa la prueba que los contrasta con el panel. */
export const businessTypesWithPrepTime = (): string[] => Object.keys(MINUTOS_POR_TIPO)

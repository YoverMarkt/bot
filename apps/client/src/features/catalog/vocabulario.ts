// ── El catálogo habla el oficio del local ─────────────────────────────
//
// ⚠️ Pedido del dueño (2026-09-14): «cada cliente creado haga solo referencias
// a cosas de ese negocio; no puede ser posible que un local de almuerzos diga
// pizza». Y tenía razón: la ayuda del catálogo ponía de ejemplo «Pizza Familiar
// Pepperoni» y «Sabores de pizza» a TODOS los locales, incluida una
// almuercería. Para alguien que no es técnico, un ejemplo que no es de su
// oficio no orienta: despista.
//
// ⚠️ Es solo VOCABULARIO. No cambia una sola capacidad ni un dato: los mismos
// grupos, las mismas opciones y el mismo motor. Lo único que cambia es cómo se
// llaman las cosas en la pantalla del dueño.
//
// ⚠️ El tipo se busca NORMALIZADO —sin tildes y en minúsculas— porque en la
// base conviven «pizzería» y «pizzeria»: el alta guarda la etiqueta que se
// escribió y las plantillas usan la clave sin tilde. Comparar en crudo dejaría
// a Monster Pizza con el vocabulario genérico.

export interface Vocabulario {
  /** Un producto de ESTE oficio, para el campo del nombre. */
  ejemploProducto: string
  /** Cómo llama este oficio a lo que cambia el precio: tamaños, presentaciones… */
  tamanos: string
  /** Un ejemplo de tamaño real. */
  ejemploTamano: string
  /** Un grupo de elección típico del oficio. */
  ejemploGrupo: string
  /** Las opciones de ese grupo, para la ayuda. */
  ejemploOpciones: string
}

const GENERICO: Vocabulario = {
  ejemploProducto: 'Ej: Plato del día',
  tamanos: 'Tamaños',
  ejemploTamano: 'pequeño $5, grande $8',
  ejemploGrupo: 'Elige tu acompañante',
  ejemploOpciones: 'arroz, ensalada, papas',
}

const POR_TIPO: Record<string, Vocabulario> = {
  almuerzos: {
    ejemploProducto: 'Ej: Almuerzo del día',
    tamanos: 'Tamaños',
    ejemploTamano: 'normal $3.50, ejecutivo $5',
    ejemploGrupo: 'Elige tu segundo',
    ejemploOpciones: 'pollo apanado, moro de costilla, pescado',
  },
  desayunos: {
    ejemploProducto: 'Ej: Desayuno completo',
    tamanos: 'Tamaños',
    ejemploTamano: 'simple $2.50, completo $4',
    ejemploGrupo: 'Elige tu bebida',
    ejemploOpciones: 'café, jugo, batido',
  },
  heladeria: {
    ejemploProducto: 'Ej: Helado de mora',
    tamanos: 'Presentaciones',
    ejemploTamano: 'vasito $1.50, litro $6',
    ejemploGrupo: 'Elige tu sabor',
    ejemploOpciones: 'mora, chocolate, vainilla',
  },
  pizzeria: {
    ejemploProducto: 'Ej: Pizza de pepperoni',
    tamanos: 'Tamaños',
    ejemploTamano: 'mediana $8, familiar $14',
    ejemploGrupo: 'Elige tu sabor',
    ejemploOpciones: 'pepperoni, hawaiana, vegetariana',
  },
  hamburgueseria: {
    ejemploProducto: 'Ej: Hamburguesa doble',
    tamanos: 'Tamaños',
    ejemploTamano: 'simple $4, doble $6',
    ejemploGrupo: 'Agrega extras',
    ejemploOpciones: 'queso, tocino, huevo',
  },
  marisqueria: {
    ejemploProducto: 'Ej: Ceviche de camarón',
    tamanos: 'Tamaños',
    ejemploTamano: 'personal $8, familiar $20',
    ejemploGrupo: 'Elige tu acompañante',
    ejemploOpciones: 'chifles, canguil, patacones',
  },
  asadero: {
    ejemploProducto: 'Ej: Pollo asado',
    tamanos: 'Presas',
    ejemploTamano: 'cuarto $4, entero $14',
    ejemploGrupo: 'Elige tu acompañante',
    ejemploOpciones: 'papas, arroz, ensalada',
  },
  parrillada: {
    ejemploProducto: 'Ej: Parrillada mixta',
    tamanos: 'Tamaños',
    ejemploTamano: 'para uno $12, para dos $22',
    ejemploGrupo: 'Término de la carne',
    ejemploOpciones: 'jugoso, tres cuartos, bien cocido',
  },
  sushi: {
    ejemploProducto: 'Ej: Roll California',
    tamanos: 'Tamaños',
    ejemploTamano: '8 piezas $9, 16 piezas $16',
    ejemploGrupo: 'Elige tu salsa',
    ejemploOpciones: 'soya, teriyaki, picante',
  },
  pasteleria: {
    ejemploProducto: 'Ej: Torta de chocolate',
    tamanos: 'Tamaños',
    ejemploTamano: 'porción $2.50, entera $20',
    ejemploGrupo: 'Elige el relleno',
    ejemploOpciones: 'manjar, mora, chocolate',
  },
  postres: {
    ejemploProducto: 'Ej: Cheesecake de mora',
    tamanos: 'Tamaños',
    ejemploTamano: 'porción $3, entero $18',
    ejemploGrupo: 'Elige la salsa',
    ejemploOpciones: 'mora, chocolate, sin salsa',
  },
  batidos: {
    ejemploProducto: 'Ej: Batido de fresa',
    tamanos: 'Tamaños',
    ejemploTamano: 'mediano $2, grande $3',
    ejemploGrupo: 'Elige la leche',
    ejemploOpciones: 'entera, deslactosada, de almendras',
  },
  jugos: {
    ejemploProducto: 'Ej: Jugo de naranja',
    tamanos: 'Tamaños',
    ejemploTamano: 'vaso $1.50, jarra $5',
    ejemploGrupo: '¿Con azúcar?',
    ejemploOpciones: 'normal, poca, sin azúcar',
  },
  carniceria: {
    ejemploProducto: 'Ej: Lomo fino',
    tamanos: 'Cortes',
    ejemploTamano: 'libra $6, kilo $13',
    ejemploGrupo: 'Cómo lo quieres',
    ejemploOpciones: 'entero, en filetes, molido',
  },
  panaderia: {
    ejemploProducto: 'Ej: Pan de yuca',
    tamanos: 'Presentaciones',
    ejemploTamano: 'unidad $0.30, docena $3',
    ejemploGrupo: 'Elige el relleno',
    ejemploOpciones: 'queso, dulce, sin relleno',
  },
  cafeteria: {
    ejemploProducto: 'Ej: Capuchino',
    tamanos: 'Tamaños',
    ejemploTamano: 'pequeño $2, grande $3',
    ejemploGrupo: 'Elige la leche',
    ejemploOpciones: 'entera, deslactosada, de almendras',
  },
  restaurante: GENERICO,
}

/** Sin tildes y en minúsculas: en la base conviven «pizzería» y «pizzeria». */
const normalizar = (valor: string): string => valor
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{M}+/gu, '')
  .replace(/[^a-z0-9]/g, '')

/**
 * El vocabulario de este local, o el genérico si su tipo no tiene uno.
 *
 * ⚠️ Falla hacia el GENÉRICO y nunca hacia el de otro oficio: un ejemplo
 * neutro («Plato del día») no ayuda mucho, pero uno equivocado desorienta —
 * que es justo el problema que esto viene a resolver.
 */
export function vocabularioDe(tipo?: string | null): Vocabulario {
  const clave = normalizar(String(tipo || ''))
  if (!clave) return GENERICO
  if (POR_TIPO[clave]) return POR_TIPO[clave]
  // «pizzerias», «heladerías»… el plural del alta no debería perder el oficio.
  const singular = clave.replace(/s$/, '')
  return POR_TIPO[singular] || GENERICO
}

// Color de marca del negocio.
//
// El dueño elige un color en su panel y la tienda se pinta con él. El riesgo
// obvio es el contraste: si alguien elige amarillo, el texto blanco encima
// desaparece. Por eso el texto NO se elige a mano — se calcula por luminancia.
//
// El valor ya viene validado del servidor, pero se vuelve a comprobar aquí
// antes de tocar un estilo: es un dato que escribe un usuario.

const HEX = /^#[0-9a-fA-F]{6}$/

/** Luminancia relativa (WCAG). Decide si encima va texto negro o blanco. */
const luminancia = (hex: string) => {
  const canal = (inicio: number) => {
    const valor = Number.parseInt(hex.slice(inicio, inicio + 2), 16) / 255
    return valor <= 0.03928 ? valor / 12.92 : ((valor + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5)
}

/** Negro o blanco: el que se lea sobre ese fondo. */
export const textoSobre = (hex: string) => (luminancia(hex) > 0.45 ? '#0B0B0C' : '#FFFFFF')

export function aplicarColorDeMarca(color?: string | null) {
  const raiz = document.documentElement
  if (typeof color !== 'string' || !HEX.test(color.trim())) return
  const hex = color.trim()
  raiz.style.setProperty('--acento', hex)
  raiz.style.setProperty('--acento-texto', textoSobre(hex))
}

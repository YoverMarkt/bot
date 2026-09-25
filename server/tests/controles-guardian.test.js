import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fuentes, lineasDeComentario, raiz } from './pantallas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LOS PANELES NO LLEVAN CONTROLES A PELO
// ═══════════════════════════════════════════════════════════════════════════
//
// Un `<button>`, `<select>`, `<input>` o `<textarea>` escrito a mano en una
// pantalla de los paneles es un control que se sale del sistema: sin el foco
// visible, sin el estado deshabilitado y sin el tema oscuro que los
// componentes de `@botpanel/ui` traen gratis — y con clases copiadas que
// imitan al de verdad hasta que alguien cambia uno y no el otro.
//
// Nace el 2026-09-24. La checklist de preparación de pedidos salió con
// `<button>` a pelo y una barra dibujada a mano, teniendo `Button` y
// `Progress` en el paquete, y el dueño lo vio al primer vistazo. Al medirlo
// quedaban 16 repartidos entre los dos paneles; se migraron los 13 que tenían
// componente y este guardián impide que vuelvan.
//
// ⚠️ LA MINI APP (`apps/store`) QUEDA FUERA A PROPÓSITO. Tiene su propia línea
// de food delivery y el dueño la quiere libre de evolucionar por su cuenta:
// «menos la mini app, que eso tiene su propio diseño, incluso puede cambiar
// con el tiempo». `packages/ui` también: ahí viven las primitivas, y son lo
// único que SÍ puede tocar la etiqueta nativa.

const CARPETAS = ['apps/client/src', 'apps/admin/src']

/** La etiqueta nativa que abre la línea, si la hay (`<Button` no cuenta). */
const CONTROL = /<(button|input|select|textarea)(?=[\s>/]|$)/

/**
 * Los únicos nativos con permiso: shadcn no tiene selector de archivos ni de
 * color. El de archivo va oculto y lo dispara un `Button` del sistema; el de
 * color es la muestra junto a un `Input` con el hexadecimal.
 */
const NATIVOS_PERMITIDOS = /type=["'](file|color)["']/

/** Los atributos de la etiqueta, que pueden venir en varias líneas. */
function etiquetaDesde(lineas, i) {
  const trozo = []
  for (let j = i; j < Math.min(lineas.length, i + 15); j++) {
    trozo.push(lineas[j])
    if (/\/?>\s*$/.test(lineas[j]) || lineas[j].includes('/>')) break
  }
  return trozo.join(' ')
}

function controlesAPelo(lineas) {
  const comentarios = lineasDeComentario(lineas)
  const pillados = []
  lineas.forEach((linea, i) => {
    if (comentarios.has(i)) return
    const hallado = CONTROL.exec(linea)
    if (!hallado) return
    if (hallado[1] === 'input' && NATIVOS_PERMITIDOS.test(etiquetaDesde(lineas, i))) return
    pillados.push({ linea: i, control: hallado[1] })
  })
  return pillados
}

const REEMPLAZO = {
  button: 'Button (variant="link" para los que parecen enlace)',
  input: 'Input, o Checkbox para las casillas',
  select: 'Select con SelectTrigger / SelectContent / SelectItem',
  textarea: 'Textarea',
}

describe('los paneles usan los controles del sistema', () => {
  it('ninguna pantalla escribe un control a pelo', () => {
    const culpables = []
    for (const carpeta of CARPETAS) {
      for (const archivo of fuentes(carpeta)) {
        const lineas = readFileSync(path.join(raiz, archivo), 'utf8').split('\n')
        for (const { linea, control } of controlesAPelo(lineas)) {
          culpables.push(`${archivo}:${linea + 1} → <${control}> — usa ${REEMPLAZO[control]}`)
        }
      }
    }

    expect(culpables, 'Estos controles van con su componente de @botpanel/ui '
      + `(carga la skill shadcn-ui antes de escribir la pantalla):\n${culpables.join('\n')}`)
      .toEqual([])
  })

  it('caza de verdad un control a pelo', () => {
    // Un guardián que nunca ha visto lo que persigue no sirve de nada.
    const pillados = controlesAPelo([
      '  <button',
      '    type="button"',
      '  >',
      '  <Button variant="link">Quitar</Button>',
      '  <select id="tipo">',
      '  <input type="checkbox" />',
    ])
    expect(pillados.map(p => p.control)).toEqual(['button', 'select', 'input'])
  })

  it('deja pasar lo que shadcn no tiene y lo que solo se nombra en un comentario', () => {
    const pillados = controlesAPelo([
      '    <input',
      '      id="business-logo"',
      '      type="file"',
      '      className="hidden"',
      '    />',
      '    <input type="color" value={color} />',
      '    {/* `Button` y no un `<button>` a pelo:',
      '        lo exige el sistema de diseño. */}',
      '    // un <select> nativo no hereda el tema oscuro',
    ])
    expect(pillados).toEqual([])
  })
})

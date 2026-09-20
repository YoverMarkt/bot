import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import FormularioDireccion from '../src/components/FormularioDireccion'

// ═══════════════════════════════════════════════════════════════════════════
// UN SOLO FORMULARIO DE DIRECCIÓN
// ═══════════════════════════════════════════════════════════════════════════
//
// Había DOS —la pantalla del primer «Agregar» y otro propio dentro del
// checkout— haciendo lo mismo con distinta cara. El del checkout enterraba el
// pin abajo, detrás de un `select`, y el pin es el dato que hace que el
// repartidor llegue: una calle escrita en un barrio sin numerar puede ser
// cualquier sitio. Lo vio el dueño probando La Abuelita (2026-09-19).

const pintar = () => renderToStaticMarkup(
  <FormularioDireccion onGuardar={async () => 'id-1'} onListo={() => {}} />,
)

describe('el formulario de dirección', () => {
  it('pone el pin ARRIBA, antes de los campos que hay que escribir', () => {
    // No es orden estético: escribir en el teclado de un móvil es la parte
    // cara, y el camino de un toque tiene que ir primero.
    const html = pintar()
    const pin = html.indexOf('Usar mi ubicación actual')
    const calle = html.indexOf('Calle y número')
    expect(pin).toBeGreaterThan(-1)
    expect(pin).toBeLessThan(calle)
  })

  it('las etiquetas se ELIGEN, no se escriben', () => {
    // Con un campo libre el cliente podía guardar «Fffffff» y quedarse con una
    // libreta de direcciones que no distingue una de otra.
    const html = pintar()
    for (const tipo of ['Casa', 'Departamento', 'Oficina', 'Hotel', 'Otro']) {
      expect(html).toContain(`>${tipo}<`)
    }
    expect(html).not.toContain('<select')
  })

  it('no deja guardar una dirección vacía', () => {
    // El pin no sustituye a la calle escrita: lleva al edificio, no al piso,
    // y en un barrio sin numerar la referencia es lo único que sirve.
    const html = pintar()
    const boton = html.lastIndexOf('<button', html.indexOf('Guardar mi dirección'))
    expect(html.slice(boton, html.indexOf('Guardar mi dirección'))).toContain('disabled=""')
  })

  it('el texto del botón se puede cambiar según dónde se use', () => {
    const html = renderToStaticMarkup(
      <FormularioDireccion
        onGuardar={async () => 'id-1'}
        onListo={() => {}}
        textoGuardar="Guardar dirección"
      />,
    )
    expect(html).toContain('Guardar dirección')
  })
})

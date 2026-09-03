import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// LA PANTALLA EN BLANCO DEL ARRANQUE
//
// El dueño lo describió exacto (2026-09-02): «el Bienvenido a Umbani sale muy
// rápido y luego se queda en blanco un buen rato, y de ahí aparece el menú».
//
// Medido contra producción con red móvil lenta, que es como se abre esto desde
// el navegador de WhatsApp:
//
//     0,9 – 3,3 s   «Bienvenido a Umbani»
//     3,5 – 6,8 s   PANTALLA EN BLANCO      ← 3,3 segundos
//     7,1 s         la tienda
//
// La causa era un `return null` en la fase 'cargando' con el comentario «el
// esqueleto del HTML sigue a la vista». No sigue: `createRoot(...).render()`
// VACÍA el contenedor al montar, así que la bienvenida del index.html
// desaparece en ese instante y `null` no la sustituye por nada.
//
// ⚠️ Esto NO se puede probar con un render: la tienda no tiene DOM en las
// pruebas a propósito (cada dependencia se paga en el presupuesto de tamaño).
// Se vigila sobre el fuente, que es exactamente donde estaba el fallo — y es
// el mismo enfoque que `schedule.test.js` usa para la implementación única.
// ═══════════════════════════════════════════════════════════════════════════

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

describe('el arranque no deja la pantalla en blanco', () => {
  it('la fase «cargando» pinta la bienvenida, nunca null', () => {
    const linea = /if \(estado\.fase === 'cargando'\) return ([^\n]*)/.exec(app)
    expect(linea, 'desapareció la rama de carga; revisa este guardián').not.toBe(null)
    expect(linea![1]).toContain('<Bienvenida')
    // El fallo exacto que se corrigió, escrito para que no vuelva.
    expect(linea![1]).not.toMatch(/^null/)
  })

  it('el componente existe y dice lo mismo que el HTML', () => {
    expect(app).toContain('const Bienvenida')
    // ⚠️ Las dos copias tienen que decir lo mismo o el relevo se nota: el
    // cliente vería cambiar el texto a mitad de carga.
    for (const trozo of ['Bienvenido a Umbani', 'Abriendo tu tienda']) {
      expect(app, `falta «${trozo}» en App.tsx`).toContain(trozo)
      expect(html, `falta «${trozo}» en index.html`).toContain(trozo)
    }
  })

  it('y reutiliza las clases del HTML, sin CSS nuevo', () => {
    // Si no comparten clases, el tamaño y la posición saltan en el relevo.
    for (const clase of ['vz-boot', 'vz-logo', 'vz-t', 'vz-s']) {
      expect(app, `App.tsx no usa .${clase}`).toContain(clase)
      expect(html, `index.html no define .${clase}`).toContain(clase)
    }
  })
})

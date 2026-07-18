import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

// El CSP del servidor (script-src 'self') bloquea scripts inline: los
// index.html de los paneles deben cargar todo JS como archivo externo.
const PANELS = [
  ['client', new URL('../../apps/client/index.html', import.meta.url)],
  ['admin', new URL('../../apps/admin/index.html', import.meta.url)],
]

describe('paneles compatibles con el CSP', () => {
  for (const [name, url] of PANELS) {
    it(`el index.html de ${name} no trae scripts inline y usa theme-boot externo`, () => {
      const html = fs.readFileSync(url, 'utf8')
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
      expect(html).toContain('theme-boot.js')
      const boot = fs.readFileSync(new URL(`../../apps/${name}/public/theme-boot.js`, import.meta.url), 'utf8')
      expect(boot).toContain(`bp-theme-${name}`)
    })
  }
})

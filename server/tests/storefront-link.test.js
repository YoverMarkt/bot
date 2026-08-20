import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const {
  buildStorefrontUrl,
  createStorefrontLinkService,
  RESEND_COOLDOWN_MS,
  storefrontAvailable,
  storefrontInvite,
} = require('../dist/services/storefront-link')

// El enlace que el bot le manda al cliente para abrir la tienda.
//
// Lo arma el CÓDIGO, nunca la IA: un modelo que "recuerde" una URL manda a la
// gente a una pantalla de error. Y como el token solo se guarda hasheado, un
// enlace ya enviado no se puede reconstruir — cada petición crea uno nuevo, y
// por eso hace falta un freno para que un "hola" repetido no llene la tabla.

const negocio = (extra = {}) => ({
  id: 'negocio-1',
  name: 'Pizzería Roma',
  slug: 'pizza-roma',
  storefront_enabled: true,
  takes_orders: true,
  ...extra,
})

function montar(overrides = {}) {
  const database = {
    resolveCustomer: vi.fn().mockResolvedValue({ id: 'cliente-1' }),
    createStorefrontSession: vi.fn().mockResolvedValue({ id: 'sesion-1' }),
    ...overrides.database,
  }
  let ahora = 1_000_000
  const service = createStorefrontLinkService({
    database,
    baseUrl: overrides.baseUrl || (() => 'https://tienda.ejemplo.com'),
    now: () => ahora,
  })
  return { service, database, avanzar: ms => { ahora += ms } }
}

describe('el enlace de la tienda', () => {
  describe('a quién se le ofrece', () => {
    it('a un negocio con tienda y pedidos', () => {
      expect(storefrontAvailable(negocio())).toBe(true)
    })

    // Es el caso de la barbería: mandarla a una app vacía es peor que no
    // mandar nada.
    it('a nadie que no venda', () => {
      expect(storefrontAvailable(negocio({ takes_orders: false }))).toBe(false)
    })

    it('a nadie con la tienda apagada', () => {
      expect(storefrontAvailable(negocio({ storefront_enabled: false }))).toBe(false)
    })

    // Sin slug no hay URL posible, y media URL es peor que ninguna.
    it('a nadie sin slug', () => {
      expect(storefrontAvailable(negocio({ slug: null }))).toBe(false)
      expect(storefrontAvailable(null)).toBe(false)
    })
  })

  describe('cómo se arma la URL', () => {
    // Corto a propósito: el slug NO viaja porque el token ya identifica al
    // negocio, y en un chat cada carácter cuenta.
    it('es solo la base y el token', () => {
      expect(buildStorefrontUrl({
        baseUrl: 'https://tienda.ejemplo.com',
        slug: 'pizza-roma',
        token: 'abc123',
      })).toBe('https://tienda.ejemplo.com/s/abc123')
    })

    it('no filtra el slug del negocio en el enlace', () => {
      const url = buildStorefrontUrl({
        baseUrl: 'https://x.com', slug: 'hostal-vista-andina-1784175667831', token: 'abc',
      })
      expect(url).not.toContain('hostal-vista-andina')
    })

    // El enlace lo lee una persona en un chat: si mide como un párrafo, no lo
    // toca. Con un dominio propio queda aún más corto.
    it('cabe en un mensaje de WhatsApp', () => {
      const url = buildStorefrontUrl({
        baseUrl: 'https://web-production-3433c.up.railway.app',
        slug: 'hostal-vista-andina-1784175667831',
        token: 'a'.repeat(22),
      })
      expect(url.length).toBeLessThan(80)
    })

    it('tolera una barra de más al final', () => {
      expect(buildStorefrontUrl({
        baseUrl: 'https://tienda.ejemplo.com///',
        slug: 'pizza-roma',
        token: 'abc',
      })).toBe('https://tienda.ejemplo.com/s/abc')
    })

    it('escapa lo que va en la URL', () => {
      const url = buildStorefrontUrl({
        baseUrl: 'https://x.com', slug: 'a b', token: 'a+b/c=',
      })
      expect(url).toBe('https://x.com/s/a%2Bb%2Fc%3D')
    })

    // Antes de mandar un enlace roto, mejor no mandar ninguno.
    it('devuelve null si falta cualquier pieza', () => {
      expect(buildStorefrontUrl({ baseUrl: '', slug: 'x', token: 't' })).toBeNull()
      expect(buildStorefrontUrl({ baseUrl: 'https://x.com', slug: '', token: 't' })).toBeNull()
      expect(buildStorefrontUrl({ baseUrl: 'https://x.com', slug: 'x', token: '' })).toBeNull()
    })

    it('rechaza una base que no es una dirección web', () => {
      expect(buildStorefrontUrl({
        baseUrl: 'tienda.ejemplo.com', slug: 'x', token: 't',
      })).toBeNull()
    })
  })

  describe('el texto que acompaña', () => {
    it('habla de la carta en un negocio de comida', () => {
      const texto = storefrontInvite(negocio(), 'https://x.com/s/z')
      expect(texto).toContain('carta')
      expect(texto).toContain('https://x.com/s/z')
    })

    // El cliente tiene que saber que caduca; si no, volverá con un enlace
    // muerto pensando que la tienda se rompió.
    // Antes decía "vence en 6 h". Ya no vence: lo que protege el enlace es
    // tener que confirmar el número de WhatsApp, no el reloj. Sí se avisa de
    // que es personal, que es lo que evita que el cliente lo reenvíe pensando
    // que hace un favor y mande a su amigo a una pantalla de "pide el tuyo".
    it('avisa de que el enlace es personal y no vence', () => {
      const texto = storefrontInvite({ takes_orders: true }, 'https://x.com/s/tok')
      expect(texto).toContain('personal')
      expect(texto).toContain('no vence')
      expect(texto).not.toMatch(/vence en \d+ ?h/)
    })

    // En un chat, un bloque de texto con un enlace dentro se lee como
    // publicidad y el cliente lo pasa de largo.
    it('no ocupa media pantalla del chat', () => {
      const texto = storefrontInvite(negocio(), 'https://x.com/s/abcdefghijklmnopqrstuv')
      expect(texto.split('\n')).toHaveLength(3)
    })
  })

  describe('emitir el enlace', () => {
    it('crea el cliente y su sesión, y devuelve la URL', async () => {
      const { service, database } = montar()
      const url = await service.issueLink({
        business: negocio(), phone: '593991716574', name: 'Ana',
      })

      expect(url).toMatch(/^https:\/\/tienda\.ejemplo\.com\/s\/.+/)
      expect(database.resolveCustomer).toHaveBeenCalledWith({
        businessId: 'negocio-1', phone: '593991716574', name: 'Ana',
      })
      const sesion = database.createStorefrontSession.mock.calls[0][0]
      expect(sesion.businessId).toBe('negocio-1')
      expect(sesion.customerId).toBe('cliente-1')
      // El token en claro NUNCA se guarda: solo su huella.
      expect(sesion.tokenHash).toHaveLength(64)
      expect(url).not.toContain(sesion.tokenHash)
    })

    it('cada enlace es distinto', async () => {
      const { service, avanzar } = montar()
      const uno = await service.issueLink({ business: negocio(), phone: '593991716574' })
      avanzar(RESEND_COOLDOWN_MS + 1)
      const dos = await service.issueLink({ business: negocio(), phone: '593991716574' })
      expect(uno).not.toBe(dos)
    })

    // Sin freno, cada "hola" crearía una sesión y el cliente vería el mismo
    // mensaje repetido, que parece un bot roto.
    it('no lo repite si se acaba de mandar', async () => {
      const { service, database } = montar()
      await service.issueLink({ business: negocio(), phone: '593991716574' })
      const segundo = await service.issueLink({ business: negocio(), phone: '593991716574' })

      expect(segundo).toBeNull()
      expect(database.createStorefrontSession).toHaveBeenCalledTimes(1)
    })

    it('vuelve a mandarlo pasado el tiempo de espera', async () => {
      const { service, avanzar } = montar()
      await service.issueLink({ business: negocio(), phone: '593991716574' })
      avanzar(RESEND_COOLDOWN_MS + 1)
      expect(await service.issueLink({ business: negocio(), phone: '593991716574' })).toBeTruthy()
    })

    it('el freno es por contacto, no para todos', async () => {
      const { service } = montar()
      await service.issueLink({ business: negocio(), phone: '111' })
      expect(await service.issueLink({ business: negocio(), phone: '222' })).toBeTruthy()
    })

    it('con `force` se salta el freno', async () => {
      const { service } = montar()
      await service.issueLink({ business: negocio(), phone: '111' })
      expect(await service.issueLink({ business: negocio(), phone: '111', force: true })).toBeTruthy()
    })

    it('no toca la base si el negocio no tiene tienda', async () => {
      const { service, database } = montar()
      const url = await service.issueLink({
        business: negocio({ storefront_enabled: false }), phone: '111',
      })
      expect(url).toBeNull()
      expect(database.resolveCustomer).not.toHaveBeenCalled()
    })

    // En local sin BASE_URL no se puede construir una URL que alguien pueda
    // abrir: mejor callar que mandar algo que no funciona.
    it('devuelve null sin dirección pública configurada', async () => {
      const { service } = montar({ baseUrl: () => null })
      expect(await service.issueLink({ business: negocio(), phone: '111' })).toBeNull()
    })

    // Un fallo aquí no puede tumbar la conversación: el cliente sigue siendo
    // atendido por chat, como antes de que la tienda existiera.
    it('si la base falla, se calla en vez de romper', async () => {
      const { service } = montar({
        database: { resolveCustomer: vi.fn().mockRejectedValue(new Error('base caída')) },
      })
      await expect(service.issueLink({ business: negocio(), phone: '111' }))
        .resolves.toBeNull()
    })

    it('un fallo no consume el freno: al siguiente mensaje se reintenta', async () => {
      const database = {
        resolveCustomer: vi.fn()
          .mockRejectedValueOnce(new Error('caída'))
          .mockResolvedValue({ id: 'cliente-1' }),
        createStorefrontSession: vi.fn().mockResolvedValue({ id: 's' }),
      }
      const { service } = montar({ database })
      expect(await service.issueLink({ business: negocio(), phone: '111' })).toBeNull()
      expect(await service.issueLink({ business: negocio(), phone: '111' })).toBeTruthy()
    })
  })

  // Este bloque nace de un fallo real: el módulo exportaba `issueStorefrontLink`
  // pero la conversación pedía `issueLink`, y un `as` a ciegas dejó pasar la
  // diferencia. Todos los tests seguían verdes porque inyectan simulacros; solo
  // se vio probando contra el servidor de verdad. Aquí se fija el contrato.
  describe('el contrato con el bot', () => {
    it('expone las funciones con los nombres que el bot importa', () => {
      const modulo = require('../dist/services/storefront-link')
      expect(typeof modulo.issueStorefrontLink).toBe('function')
      expect(typeof modulo.storefrontInvite).toBe('function')
    })

    it('la conversación las cablea por esos nombres', () => {
      const fuente = fs.readFileSync('dist/services/bot-conversation.js', 'utf8')
      expect(fuente).toContain('issueStorefrontLink')
      expect(fuente).toContain('storefrontInvite')
    })
  })
})

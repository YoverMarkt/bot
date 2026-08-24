import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  SALDO_MINIMO_USD,
  NOMBRE_CANAL_PLATAFORMA,
  checkAllCredentials,
  checkBusinessCredentials,
  checkPlatformCredentials,
} = require('../dist/services/credential-monitor')

const BASE_URL = 'https://web-production-3433c.up.railway.app'

const negocio = (extra = {}) => ({
  id: 'biz-1',
  name: 'Hostal Vista Andina',
  active: true,
  suspended: false,
  whatsapp_provider: 'ycloud',
  whatsapp_number: '+593991716574',
  ycloud_number: '+593991716574',
  ycloud_api_key: 'clave-de-prueba',
  ...extra,
})

// Cuenta sana: número conectado, webhook bien apuntado y saldo suficiente.
const clienteSano = (extra = {}) => ({
  listPhoneNumbers: async () => [{ phoneNumber: '+593991716574', status: 'CONNECTED' }],
  listWebhooks: async () => [{
    id: 'wh-1',
    url: `${BASE_URL}/webhook/ycloud`,
    status: 'active',
    enabledEvents: ['whatsapp.inbound_message.received'],
  }],
  getBalance: async () => ({ amount: 25, currency: 'USD' }),
  getTelegramBotName: async () => 'bot_de_prueba',
  ...extra,
})

const codigos = problemas => problemas.map(p => p.code)

describe('vigilancia de credenciales', () => {
  it('no reporta nada cuando la cuenta está sana', async () => {
    const problemas = await checkBusinessCredentials(
      negocio(), clienteSano(), { baseUrl: BASE_URL },
    )
    expect(problemas).toEqual([])
  })

  describe('cosas que dejan al bot incomunicado', () => {
    it('detecta que falta la API Key', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ ycloud_api_key: '' }), clienteSano(), { baseUrl: BASE_URL },
      )
      expect(codigos(problemas)).toContain('sin_api_key')
      expect(problemas[0].severity).toBe('error')
    })

    it('detecta una API Key que el proveedor rechaza', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => { throw new Error('401 Unauthorized') },
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('api_key_rechazada')
    })

    it('detecta que el número no está en la cuenta', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => [{ phoneNumber: '+593000000000', status: 'CONNECTED' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('numero_ajeno')
    })

    it('detecta un número que dejó de estar conectado', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listPhoneNumbers: async () => [{ phoneNumber: '+593991716574', status: 'FLAGGED' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('numero_desconectado')
    })
  })

  // Lo que realmente pasó en julio de 2026: el webhook quedó apuntando mal y
  // sin entregar, mientras todo lo demás se veía perfecto.
  describe('el webhook, que es donde se rompió', () => {
    it('detecta que no hay ningún webhook activo', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{ id: 'w', url: `${BASE_URL}/webhook/ycloud`, status: 'disabled' }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('sin_webhook')
    })

    it('detecta un webhook apuntando a otro dominio', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{
          id: 'w',
          url: 'https://dominio-viejo.up.railway.app/webhook/ycloud',
          status: 'active',
          enabledEvents: ['whatsapp.inbound_message.received'],
        }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('webhook_desviado')
    })

    it('detecta un webhook que no escucha los mensajes entrantes', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        listWebhooks: async () => [{
          id: 'w', url: `${BASE_URL}/webhook/ycloud`, status: 'active', enabledEvents: [],
        }],
      }), { baseUrl: BASE_URL })
      expect(codigos(problemas)).toContain('webhook_sin_evento')
    })
  })

  describe('saldo', () => {
    it('avisa antes de quedarse sin servicio, no después', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        getBalance: async () => ({ amount: 0.5, currency: 'USD' }),
      }), { baseUrl: BASE_URL })
      const saldo = problemas.find(p => p.code === 'saldo_bajo')
      expect(saldo).toBeTruthy()
      expect(saldo.severity).toBe('aviso')
      expect(SALDO_MINIMO_USD).toBeGreaterThan(0)
    })

    it('no convierte un saldo ilegible en un problema del canal', async () => {
      const problemas = await checkBusinessCredentials(negocio(), clienteSano({
        getBalance: async () => { throw new Error('sin permiso') },
      }), { baseUrl: BASE_URL })
      expect(problemas).toEqual([])
    })
  })

  describe('Telegram', () => {
    it('detecta un token que Telegram no reconoce', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ whatsapp_provider: 'telegram', telegram_bot_token: 'token-malo' }),
        clienteSano({ getTelegramBotName: async () => null }),
      )
      expect(codigos(problemas)).toContain('token_invalido')
    })

    it('detecta que se eligió Telegram y no se puso el token', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ whatsapp_provider: 'telegram', telegram_bot_token: '' }),
        clienteSano(),
      )
      expect(codigos(problemas)).toEqual(['sin_token'])
    })

    it('reporta el rechazo de Telegram sin filtrar el token', async () => {
      const problemas = await checkBusinessCredentials(
        negocio({ whatsapp_provider: 'telegram', telegram_bot_token: 'token-malo' }),
        clienteSano({ getTelegramBotName: async () => { throw new Error('401 Unauthorized') } }),
      )
      expect(codigos(problemas)).toContain('token_invalido')
      expect(problemas[0].message).not.toContain('token-malo')
    })
  })

  // Un negocio a medio configurar: existe, está activo y no puede recibir nada.
  it('avisa del negocio que se quedó sin canal a medio configurar', async () => {
    const problemas = await checkBusinessCredentials(
      negocio({ whatsapp_provider: '', telegram_bot_token: '' }), clienteSano(),
    )
    expect(codigos(problemas)).toEqual(['sin_proveedor'])
    expect(problemas[0].severity).toBe('aviso')
  })

  describe('revisión de toda la plataforma', () => {
    it('omite negocios inactivos o suspendidos', async () => {
      const problemas = await checkAllCredentials([
        negocio({ id: 'a', active: false, ycloud_api_key: '' }),
        negocio({ id: 'b', suspended: true, ycloud_api_key: '' }),
      ], clienteSano(), { baseUrl: BASE_URL })
      expect(problemas).toEqual([])
    })

    it('un negocio que falla no impide revisar los demás', async () => {
      const problemas = await checkAllCredentials([
        negocio({ id: 'a' }),
        negocio({ id: 'b', ycloud_api_key: '' }),
      ], clienteSano(), { baseUrl: BASE_URL })
      expect(problemas).toHaveLength(1)
      expect(problemas[0].businessId).toBe('b')
    })

    // El bucle no puede rendirse por uno: la revisión existe para enterarse de
    // los problemas de TODOS, y el que revienta suele ser el que más importa.
    //
    // Se rompe por donde NO hay red: una fila con un dato imposible de leer.
    // Los fallos del proveedor ya los caza `checkBusinessCredentials` por
    // dentro, así que probar con esos no demostraría nada de este `catch`.
    it('un negocio ilegible no impide revisar los demás', async () => {
      const ilegible = negocio({
        id: 'a',
        whatsapp_provider: { toString() { throw new Error('fila corrupta') } },
      })
      const problemas = await checkAllCredentials(
        [ilegible, negocio({ id: 'b' })],
        clienteSano(),
        { baseUrl: BASE_URL },
      )
      expect(codigos(problemas)).toEqual(['revision_fallida'])
      expect(problemas[0].businessId).toBe('a')
      expect(problemas[0].severity).toBe('aviso')
    })

    it('identifica el negocio de cada problema', async () => {
      const problemas = await checkAllCredentials(
        [negocio({ id: 'biz-x', name: 'Pizzería', ycloud_api_key: '' })],
        clienteSano(), { baseUrl: BASE_URL },
      )
      expect(problemas[0].businessId).toBe('biz-x')
      expect(problemas[0].businessName).toBe('Pizzería')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL NÚMERO DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// Estas pruebas fijan la corrección del 2026-08-23. Hasta ese día el vigilante
// era CIEGO en producción: todos los locales son de marketplace, y
// `'marketplace'` no caía en ninguna rama de `checkBusinessCredentials`, así
// que la revisión devolvía «todo en orden» sin llamar a YCloud ni una vez.
// El aviso `saldo_bajo` («0.5 USD») llevaba 209 apariciones y se apagó solo.

const canalDePlataforma = (extra = {}) => ({
  apiKey: 'clave-de-la-plataforma',
  number: '+593991716574',
  webhookSecret: 'whsec_de_prueba',
  endpointId: 'endpoint-de-prueba',
  ...extra,
})

/** Lanza si alguien lo llama: así se demuestra que NO se consultó nada. */
const clienteQueNoDebeUsarse = () => ({
  listPhoneNumbers: async () => { throw new Error('no debería llamarse') },
  listWebhooks: async () => { throw new Error('no debería llamarse') },
  getBalance: async () => { throw new Error('no debería llamarse') },
  getTelegramBotName: async () => { throw new Error('no debería llamarse') },
})

describe('el canal de la plataforma', () => {
  it('no reporta nada cuando el número del marketplace está sano', async () => {
    const problemas = await checkPlatformCredentials(
      canalDePlataforma(), clienteSano(), { baseUrl: BASE_URL },
    )
    expect(problemas).toEqual([])
  })

  // La regresión concreta: con 0.5 USD el número no puede ENVIAR, y ese aviso
  // dejó de sonar el día que el local pasó al marketplace.
  it('vuelve a avisar del saldo bajo del número del marketplace', async () => {
    const problemas = await checkPlatformCredentials(canalDePlataforma(), clienteSano({
      getBalance: async () => ({ amount: 0.5, currency: 'USD' }),
    }), { baseUrl: BASE_URL })
    const saldo = problemas.find(p => p.code === 'saldo_bajo')
    expect(saldo).toBeTruthy()
    expect(saldo.severity).toBe('aviso')
  })

  it('hace las MISMAS preguntas que a un negocio con número propio', async () => {
    const roto = clienteSano({
      listPhoneNumbers: async () => [{ phoneNumber: '+593000000000', status: 'CONNECTED' }],
      listWebhooks: async () => [{ id: 'w', url: 'https://otro.dominio/webhook/ycloud', status: 'active', enabledEvents: [] }],
    })
    const codes = codigos(await checkPlatformCredentials(
      canalDePlataforma(), roto, { baseUrl: BASE_URL },
    ))
    expect(codes).toContain('numero_ajeno')
    expect(codes).toContain('webhook_desviado')
    expect(codes).toContain('webhook_sin_evento')
  })

  // El problema no pertenece a ningún local: cargárselo a uno elegido a dedo
  // sería la misma confusión que la base prohíbe con el número.
  it('atribuye los problemas a la PLATAFORMA, nunca a un negocio', async () => {
    const problemas = await checkPlatformCredentials(canalDePlataforma(), clienteSano({
      getBalance: async () => ({ amount: 0, currency: 'USD' }),
    }), { baseUrl: BASE_URL })
    expect(problemas[0].businessId).toBeNull()
    expect(problemas[0].businessName).toBe(NOMBRE_CANAL_PLATAFORMA)
  })

  // YCloud puede decir que la cuenta está perfecta y el número seguir mudo: sin
  // Signing Secret el webhook responde 503 en producción.
  it('avisa de lo que YCloud no puede ver: el secreto y el endpoint', async () => {
    const codes = codigos(await checkPlatformCredentials(
      canalDePlataforma({ webhookSecret: null, endpointId: null }),
      clienteSano(), { baseUrl: BASE_URL },
    ))
    expect(codes).toContain('plataforma_sin_secreto')
    expect(codes).toContain('plataforma_sin_endpoint')
  })

  // El canal puede responder y aun así no poder mandar nada: la API Key sirve
  // pero el número no está puesto. YCloud contesta que sí a la primera pregunta.
  it('detecta un canal con clave válida y sin número', async () => {
    const problemas = await checkPlatformCredentials(
      canalDePlataforma({ number: '' }), clienteSano(), { baseUrl: BASE_URL },
    )
    expect(codigos(problemas)).toContain('sin_numero')
  })

  // YCloud puede estar a medias: los números responden y los webhooks no. No
  // poder MIRAR el webhook no es lo mismo que no tenerlo, así que es aviso.
  it('no confunde un webhook ilegible con un webhook roto', async () => {
    const problemas = await checkPlatformCredentials(canalDePlataforma(), clienteSano({
      listWebhooks: async () => { throw new Error('502 Bad Gateway') },
    }), { baseUrl: BASE_URL })
    const aviso = problemas.find(p => p.code === 'webhook_no_verificable')
    expect(aviso).toBeTruthy()
    expect(aviso.severity).toBe('aviso')
  })

  it('avisa cuando no hay número de marketplace configurado', async () => {
    const problemas = await checkPlatformCredentials(
      null, clienteQueNoDebeUsarse(), { baseUrl: BASE_URL },
    )
    expect(codigos(problemas)).toEqual(['plataforma_sin_canal'])
    expect(problemas[0].severity).toBe('error')
  })
})

describe('un negocio del marketplace no tiene credenciales propias', () => {
  // No es un detalle: es el fallo entero. Un local de marketplace no tiene
  // nada que revisar —eso es correcto—, pero hasta el 2026-08-23 se llegaba a
  // esa conclusión por caída, y NADIE revisaba el número que sí importa.
  it('no consulta al proveedor por un local sin canal propio', async () => {
    const problemas = await checkBusinessCredentials(
      negocio({
        whatsapp_provider: 'marketplace',
        whatsapp_number: null,
        ycloud_number: null,
        ycloud_api_key: null,
      }),
      clienteQueNoDebeUsarse(),
      { baseUrl: BASE_URL },
    )
    expect(problemas).toEqual([])
  })

  it('la configuración REAL de producción no produce ni un aviso por negocio', async () => {
    const problemas = await checkAllCredentials([{
      id: 'e758ca17-1db8-4acd-8c45-f9dbe01389b9',
      name: 'Monster Pizza',
      active: true,
      suspended: false,
      whatsapp_provider: 'marketplace',
      whatsapp_number: null,
      ycloud_number: null,
      ycloud_api_key: null,
      ycloud_webhook_endpoint_id: null,
      telegram_bot_token: null,
    }], clienteQueNoDebeUsarse(), { baseUrl: BASE_URL })
    expect(problemas).toEqual([])
  })
})

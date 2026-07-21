import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { normalizeChannelIdentifier } = require('../dist/types/channels')
const {
  ChannelResolutionConflictError,
  resolveBusinessChannel,
} = require('../dist/services/channel-resolution')

describe('identificadores exactos de canal', () => {
  it('normaliza únicamente el formato del teléfono y conserva todos los dígitos', () => {
    expect(normalizeChannelIdentifier('phone', '+593 (99) 911-1222'))
      .toBe('593999111222')
    expect(normalizeChannelIdentifier('phone', '593999111222'))
      .toBe('593999111222')
    expect(normalizeChannelIdentifier('phone', '0999111222')).toBeNull()
    expect(normalizeChannelIdentifier('phone', '00593999111222')).toBeNull()
  })

  it('no confunde países distintos aunque compartan los últimos nueve dígitos', () => {
    const ecuador = normalizeChannelIdentifier('phone', '+593999111222')
    const colombia = normalizeChannelIdentifier('phone', '+573999111222')

    expect(ecuador).not.toBe(colombia)
    expect(ecuador).toBe('593999111222')
    expect(colombia).toBe('573999111222')
  })

  it('rechaza letras, extensiones y longitudes fuera de E.164', () => {
    expect(normalizeChannelIdentifier('phone', '593ABC999111222')).toBeNull()
    expect(normalizeChannelIdentifier('phone', '+593999111222 ext 4')).toBeNull()
    expect(normalizeChannelIdentifier('phone', '1234567')).toBeNull()
    expect(normalizeChannelIdentifier('phone', '1234567890123456')).toBeNull()
  })

  it('trata IDs opacos con trim y comparación sensible a mayúsculas', () => {
    expect(normalizeChannelIdentifier('account_id', '  Phone_ID_A  '))
      .toBe('Phone_ID_A')
    expect(normalizeChannelIdentifier('account_id', 'Phone_ID_A'))
      .not.toBe(normalizeChannelIdentifier('account_id', 'phone_id_a'))
    expect(normalizeChannelIdentifier('account_id', 'id\ninyectado')).toBeNull()
    expect(normalizeChannelIdentifier('account_id', '\tid-con-tabs\t')).toBeNull()
  })

  it('resuelve dentro del namespace exacto y usa el primer alias válido', async () => {
    const business = { id: 'business-a' }
    const database = {
      getBusinessByChannel: vi.fn(async address => (
        address.provider === 'meta' && address.identifierType === 'phone'
          ? business
          : null
      )),
    }

    const resolved = await resolveBusinessChannel(database, [
      {
        provider: 'meta',
        identifierType: 'account_id',
        identifier: 'missing-id',
      },
      {
        provider: 'meta',
        identifierType: 'phone',
        identifier: '+593 999 111 222',
      },
    ])

    expect(resolved).toEqual({
      business,
      address: {
        provider: 'meta',
        identifierType: 'phone',
        identifier: '593999111222',
      },
    })
    expect(database.getBusinessByChannel).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ycloud' }),
    )
  })

  it('falla cerrado si dos señales apuntan a tenants distintos', async () => {
    const database = {
      getBusinessByChannel: vi.fn(async address => (
        address.identifierType === 'account_id'
          ? { id: 'business-a' }
          : { id: 'business-b' }
      )),
    }

    await expect(resolveBusinessChannel(database, [
      {
        provider: 'meta',
        identifierType: 'account_id',
        identifier: 'meta-phone-a',
      },
      {
        provider: 'meta',
        identifierType: 'phone',
        identifier: '+593999111222',
      },
    ])).rejects.toBeInstanceOf(ChannelResolutionConflictError)
  })

  it('propaga errores de base y no los convierte en negocio inexistente', async () => {
    const database = {
      getBusinessByChannel: vi.fn().mockRejectedValue(new Error('BD no disponible')),
    }

    await expect(resolveBusinessChannel(database, [{
      provider: 'ycloud',
      identifierType: 'phone',
      identifier: '+593999111222',
    }])).rejects.toThrow('BD no disponible')
  })
})

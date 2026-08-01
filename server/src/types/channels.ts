export type ChannelProvider = 'meta' | 'ycloud'
export type WhatsAppProvider = ChannelProvider
export type ChannelIdentifierType = 'phone' | 'account_id'

export interface ChannelAddress {
  provider: ChannelProvider
  identifierType: ChannelIdentifierType
  identifier: string
}

export interface WhatsAppChannelAddress extends ChannelAddress {
  provider: WhatsAppProvider
}

export function normalizeChannelIdentifier(
  identifierType: ChannelIdentifierType,
  value?: string | null,
): string | null {
  // PostgreSQL btrim(text) elimina espacios ASCII; mantener la misma regla
  // evita que el webhook consulte una clave distinta de la derivada en SQL.
  const trimmed = String(value || '').replace(/^ +| +$/g, '')
  if (!trimmed) return null

  if (identifierType === 'phone') {
    // Solo normaliza formato: nunca infiere país ni compara sufijos.
    if (!/^\+?[0-9 ().-]+$/.test(trimmed)) return null
    const digits = trimmed.replace(/[+ ().-]/g, '')
    return /^[1-9][0-9]{7,14}$/.test(digits) ? digits : null
  }

  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if ([...trimmed].length > 255 || hasControlCharacter) {
    return null
  }
  return trimmed
}

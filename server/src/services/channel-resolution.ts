import {
  normalizeChannelIdentifier,
  type ChannelAddress,
} from '../types/channels'

interface ChannelBusiness {
  id: string
}

interface ChannelResolverDatabase<TBusiness extends ChannelBusiness> {
  getBusinessByChannel(address: ChannelAddress): Promise<TBusiness | null>
}

export interface ResolvedBusinessChannel<
  TBusiness extends ChannelBusiness,
  TAddress extends ChannelAddress = ChannelAddress,
> {
  address: TAddress
  business: TBusiness
}

export class ChannelResolutionConflictError extends Error {
  constructor() {
    super('Los identificadores del canal apuntan a negocios distintos')
    this.name = 'ChannelResolutionConflictError'
  }
}

export async function resolveBusinessChannel<
  TBusiness extends ChannelBusiness,
  TAddress extends ChannelAddress,
>(
  database: ChannelResolverDatabase<TBusiness>,
  addresses: TAddress[],
): Promise<ResolvedBusinessChannel<TBusiness, TAddress> | null> {
  const seen = new Set<string>()
  const candidates = addresses.flatMap((address) => {
    const canonical = normalizeChannelIdentifier(
      address.identifierType,
      address.identifier,
    )
    if (!canonical) return []
    const normalized = { ...address, identifier: canonical } as TAddress
    const key = `${normalized.provider}:${normalized.identifierType}:${canonical}`
    if (seen.has(key)) return []
    seen.add(key)
    return [normalized]
  })

  const matches = await Promise.all(candidates.map(async address => ({
    address,
    business: await database.getBusinessByChannel(address),
  })))
  const resolved = matches.filter((match): match is {
    address: TAddress
    business: TBusiness
  } => Boolean(match.business))
  if (!resolved.length) return null

  const businessIds = new Set(resolved.map(match => match.business.id))
  if (businessIds.size !== 1) throw new ChannelResolutionConflictError()
  return resolved[0] || null
}

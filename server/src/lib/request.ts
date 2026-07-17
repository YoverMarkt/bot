import type { Request } from 'express'

// Debe usarse únicamente después de authClient, que verifica ambos claims.
export function getClientBusinessId(request: Request): string {
  return (request.user as Express.ClientUserClaims).businessId
}

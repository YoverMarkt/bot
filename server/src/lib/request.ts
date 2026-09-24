import type { Request } from 'express'

// Debe usarse únicamente después de authClient, que verifica ambos claims.
export function getClientBusinessId(request: Request): string {
  return (request.user as Express.ClientUserClaims).businessId
}

/**
 * Quién está actuando, para poder firmar lo que hace.
 *
 * Solo después de `authClient`, que ya verificó que ese usuario sigue activo y
 * pertenece a ese negocio. Devuelve null si el claim no viniera: es una firma
 * de auditoría, no una autorización — quien autoriza es el middleware.
 */
export function getClientUserId(request: Request): string | null {
  const claims = request.user as Express.ClientUserClaims & { userId?: unknown }
  return typeof claims?.userId === 'string' ? claims.userId : null
}

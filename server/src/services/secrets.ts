// Campos que nunca deben salir completos de la API hacia el navegador.
export const BUSINESS_SECRET_FIELDS = [
  'ycloud_api_key',
  'meta_token',
  'meta_verify_token',
  'kapso_api_key',
  'kapso_verify_token',
  'telegram_bot_token',
] as const

export type BusinessSecretField = (typeof BUSINESS_SECRET_FIELDS)[number]
export type BusinessRecord = Record<string, unknown>
export type CredentialStatus = Record<BusinessSecretField, boolean>

export function sanitizeBusinessForAdmin(
  business: BusinessRecord | null | undefined,
): (BusinessRecord & { credential_status: CredentialStatus }) | null | undefined {
  if (business == null) return business as null | undefined

  const safe: BusinessRecord = { ...business }
  const credential_status = {} as CredentialStatus

  for (const field of BUSINESS_SECRET_FIELDS) {
    credential_status[field] = Boolean(safe[field])
    delete safe[field]
  }

  return { ...safe, credential_status }
}

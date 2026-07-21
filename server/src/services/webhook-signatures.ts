import crypto from 'node:crypto'

export const YCLOUD_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

interface ParsedYCloudSignature {
  timestamp: number
  signatures: Buffer[]
}

function parseYCloudSignature(
  header: string | string[] | undefined,
): ParsedYCloudSignature | null {
  if (typeof header !== 'string') return null

  let timestampText: string | undefined
  const signatureTexts: string[] = []
  for (const component of header.split(',')) {
    const separator = component.indexOf('=')
    if (separator < 1) continue
    const key = component.slice(0, separator).trim()
    const value = component.slice(separator + 1).trim()
    if (key === 't' && timestampText === undefined) timestampText = value
    if (key === 's') signatureTexts.push(value)
  }

  if (!timestampText || !/^\d+$/.test(timestampText)) return null
  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null

  const signatures = signatureTexts.flatMap((signature) => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return []
    return [Buffer.from(signature, 'hex')]
  })
  return signatures.length ? { timestamp, signatures } : null
}

export function verifyYCloudSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | string[] | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = YCLOUD_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  if (!rawBody || !secret.trim()) return false
  const parsed = parseYCloudSignature(signatureHeader)
  if (!parsed) return false
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.timestamp}.`, 'utf8')
    .update(rawBody)
    .digest()

  return parsed.signatures.some(candidate => (
    candidate.length === expected.length
      && crypto.timingSafeEqual(candidate, expected)
  ))
}

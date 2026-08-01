export const DEFAULT_META_GRAPH_API_VERSION = 'v25.0'

const META_GRAPH_VERSION_PATTERN = /^v[1-9][0-9]*\.0$/

export function validMetaGraphApiVersion(value: string | undefined): boolean {
  return typeof value === 'string' && META_GRAPH_VERSION_PATTERN.test(value.trim())
}

export function metaGraphApiVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.META_GRAPH_API_VERSION?.trim()
  if (!configured) return DEFAULT_META_GRAPH_API_VERSION
  if (!validMetaGraphApiVersion(configured)) {
    throw new Error('META_GRAPH_API_VERSION debe usar el formato vN.0')
  }
  return configured
}

export function metaGraphUrl(...segments: string[]): string {
  const path = segments.map(segment => encodeURIComponent(segment)).join('/')
  return `https://graph.facebook.com/${metaGraphApiVersion()}/${path}`
}

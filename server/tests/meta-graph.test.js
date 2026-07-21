import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  DEFAULT_META_GRAPH_API_VERSION,
  metaGraphApiVersion,
  metaGraphUrl,
} = require('../dist/config/meta-graph')
const originalVersion = process.env.META_GRAPH_API_VERSION

afterEach(() => {
  if (originalVersion === undefined) delete process.env.META_GRAPH_API_VERSION
  else process.env.META_GRAPH_API_VERSION = originalVersion
})

describe('versión de Meta Graph API', () => {
  it('usa la versión vigente centralizada por defecto', () => {
    delete process.env.META_GRAPH_API_VERSION
    expect(DEFAULT_META_GRAPH_API_VERSION).toBe('v25.0')
    expect(metaGraphApiVersion()).toBe('v25.0')
    expect(metaGraphUrl('phone/a', 'messages')).toBe(
      'https://graph.facebook.com/v25.0/phone%2Fa/messages',
    )
  })

  it('permite una actualización explícita con formato seguro', () => {
    process.env.META_GRAPH_API_VERSION = 'v26.0'
    expect(metaGraphUrl('phone-a')).toBe(
      'https://graph.facebook.com/v26.0/phone-a',
    )
  })

  it('falla cerrado ante una versión manipulada', () => {
    process.env.META_GRAPH_API_VERSION = 'v25.0/../../otro-host'
    expect(() => metaGraphUrl('phone-a')).toThrow(/formato vN\.0/)
  })
})

export interface BotMediaBusiness {
  id: string
  name: string
}

export interface BotMediaProduct {
  name?: string | null
  brand?: string | null
  external_sku?: string | null
  image_url?: string | null
  video_url?: string | null
}

export interface BotMediaHistoryMessage {
  content?: string | null
}

interface BotMediaDatabase {
  getProducts(businessId: string): Promise<BotMediaProduct[]>
}

interface BotMediaLogger {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
}

export interface BotMediaDependencies {
  database: BotMediaDatabase
  logger?: BotMediaLogger
}

export interface SendRequestedProductMediaInput {
  business: BotMediaBusiness
  text: string
  reply: string
  history: BotMediaHistoryMessage[]
  products: BotMediaProduct[]
  preFiltered: boolean
  wantsImage: boolean
  wantsVideo: boolean
  send(message: string): Promise<unknown>
  sendImage?: (url: string, caption?: string) => Promise<unknown>
  sendVideo?: (url: string, caption?: string) => Promise<unknown>
}

const normalize = (value?: string | null): string => (value || '').toLowerCase()

function productScore(product: BotMediaProduct, text: string): number {
  const haystack = normalize(text)
  const name = normalize(product.name)
  if (name.length > 4 && haystack.includes(name)) return 100

  const sku = normalize(product.external_sku)
  if (sku.length >= 4 && haystack.includes(sku)) return 90

  const brand = normalize(product.brand)
  if (brand.length > 2 && haystack.includes(brand)) return 50

  const tokens = [...new Set(
    name.split(/[\s/",()-]+/).filter(token => token.length >= 6),
  )]
  return tokens.filter(token => haystack.includes(token)).length
}

function findTargetProduct(
  products: BotMediaProduct[],
  layers: string[],
): BotMediaProduct | null {
  for (const layer of layers) {
    let best: BotMediaProduct | null = null
    let bestScore = 0
    for (const product of products) {
      const score = productScore(product, layer)
      if (score > bestScore) {
        bestScore = score
        best = product
      }
    }
    if (bestScore >= 2) return best
  }
  return null
}

function createBotMedia(dependencies: BotMediaDependencies) {
  const { database } = dependencies
  const logger = dependencies.logger || console

  async function sendRequestedProductMedia(
    input: SendRequestedProductMediaInput,
  ): Promise<boolean> {
    const {
      business, text, reply, history, products, preFiltered,
      wantsImage, wantsVideo, send, sendImage, sendVideo,
    } = input
    if (!wantsImage && !wantsVideo) return false

    try {
      const fullCatalog = preFiltered
        ? await database.getProducts(business.id)
        : products
      const layers = [
        text,
        reply,
        ...history.slice().reverse().slice(0, 8).map(message => message.content || ''),
      ]
      const target = findTargetProduct(fullCatalog, layers)

      if (!target) {
        logger.log(`ℹ️  [${business.name}] pidió foto/video pero no identifiqué con certeza el producto → no se envía media`)
        return false
      }

      const hasImage = Boolean(target.image_url?.startsWith('http'))
      const hasVideo = Boolean(target.video_url?.startsWith('http'))
      const sendTargetImage = async () => {
        try {
          await sendImage?.(target.image_url as string, target.name || undefined)
          logger.log(`🖼️  Imagen enviada: ${target.name}`)
        } catch (error) {
          logger.error('❌ img:', error instanceof Error ? error.message : error)
        }
      }
      const sendTargetVideo = async () => {
        try {
          await sendVideo?.(target.video_url as string, target.name || undefined)
          logger.log(`🎬 Video enviado: ${target.name}`)
        } catch (error) {
          logger.error('❌ video:', error instanceof Error ? error.message : error)
        }
      }
      const noMedia = 'De ese producto todavía no tengo foto ni video 🙏, pero con gusto le doy todos los detalles.'

      if (wantsImage && wantsVideo) {
        if (hasImage && sendImage) await sendTargetImage()
        if (hasVideo && sendVideo) await sendTargetVideo()
        if (!hasImage && !hasVideo) await send(noMedia)
        else if (!hasImage) await send('De ese producto no tengo foto, solo el video 👆')
        else if (!hasVideo) await send('De ese producto no tengo video, solo la foto 👆')
      } else if (wantsImage) {
        if (hasImage && sendImage) await sendTargetImage()
        else if (hasVideo && sendVideo) {
          await send('De ese producto no tengo foto, pero le comparto un video 👇')
          await sendTargetVideo()
        } else await send(noMedia)
      } else if (wantsVideo) {
        if (hasVideo && sendVideo) await sendTargetVideo()
        else if (hasImage && sendImage) {
          await send('De ese producto no tengo video, pero le comparto una foto 👇')
          await sendTargetImage()
        } else await send(noMedia)
      }
      return true
    } catch (error) {
      logger.error(
        '❌ envío de media:',
        error instanceof Error ? error.message : error,
      )
      return false
    }
  }

  return { sendRequestedProductMedia }
}

const media = createBotMedia({
  database: require('../db') as BotMediaDatabase,
})

export const sendRequestedProductMedia = media.sendRequestedProductMedia
export { createBotMedia, findTargetProduct, productScore }

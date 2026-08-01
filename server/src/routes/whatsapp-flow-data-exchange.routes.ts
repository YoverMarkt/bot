import crypto from 'node:crypto'
import type { Request } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import {
  createWhatsAppFlowDataExchangeService,
  FlowDataExchangeError,
  type FlowDataExchangeRequest,
  type WhatsAppFlowDataExchangeDependencies,
} from '../services/whatsapp-flow-data-exchange'
import { quoteLodging } from '../services/lodging'

const YCLOUD_FLOW_DATA_EXCHANGE_PATH =
  '/webhook/ycloud/flows/data-exchange'
const MAX_FLOW_DATA_EXCHANGE_BYTES = 64 * 1024

const db = require('../db') as WhatsAppFlowDataExchangeDependencies
const productionDependencies: WhatsAppFlowDataExchangeDependencies = {
  ...db,
  quoteLodging,
}

// Adaptador de transporte del piloto: YCloud entrega JSON plano por HTTPS.
// La lógica de negocio vive en un servicio que recibe el contrato normalizado;
// un futuro adaptador Meta podrá descifrar RSA/AES-GCM y llamar al mismo
// servicio sin duplicar validaciones, catálogo ni cálculo de totales.
function requestSize(request: Request): number {
  if (request.rawBody) return request.rawBody.length
  try {
    return Buffer.byteLength(JSON.stringify(request.body ?? {}), 'utf8')
  } catch {
    return MAX_FLOW_DATA_EXCHANGE_BYTES + 1
  }
}

function createWhatsAppFlowDataExchangeRouter(
  dependencies: WhatsAppFlowDataExchangeDependencies = productionDependencies,
) {
  const router = createRouter()
  const exchange = createWhatsAppFlowDataExchangeService(dependencies)
  // YCloud puede entregar Flows de muchos negocios desde IPs compartidas.
  // Un límite único de 240/min por IP haría que un tenant bloquee al resto.
  const providerSafetyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 12_000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes del proveedor.' },
  })
  const sessionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes del formulario.' },
    keyGenerator: (request) => {
      const token = request.body
        && typeof request.body === 'object'
        && !Array.isArray(request.body)
        && typeof request.body.flow_token === 'string'
        ? request.body.flow_token.trim()
        : ''
      if (token && token.length <= 512 && /^[A-Za-z0-9_-]+$/.test(token)) {
        return `flow:${crypto.createHash('sha256').update(token).digest('hex')}`
      }
      return `ip:${ipKeyGenerator(request.ip || '')}`
    },
  })

  router.post(
    YCLOUD_FLOW_DATA_EXCHANGE_PATH,
    providerSafetyLimiter,
    sessionLimiter,
    async (req, res) => {
      if (requestSize(req) > MAX_FLOW_DATA_EXCHANGE_BYTES) {
        return res.status(413).json({
          error: 'La solicitud del formulario es demasiado grande.',
        })
      }
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({
          error: 'La solicitud del formulario no es válida.',
        })
      }

      try {
        const response = await exchange(req.body as FlowDataExchangeRequest)
        return res.status(200).json(response)
      } catch (error) {
        if (error instanceof FlowDataExchangeError) {
          return res.status(error.status).json({ error: error.publicMessage })
        }
        // No se registra body ni flow_token. El detalle técnico tampoco se
        // devuelve al proveedor, para no filtrar nombres de tablas o credenciales.
        console.error('❌ WhatsApp Flow data_exchange: error interno')
        return res.status(503).json({
          error: 'No pudimos continuar el formulario. Vuelve al chat e intenta nuevamente.',
        })
      }
    },
  )

  return router
}

export = createWhatsAppFlowDataExchangeRouter()

// ── ARRANQUE DEL SERVIDOR ───────────────────────────────────────────
// Este archivo solo compone Express, monta routers y levanta procesos.
// Las rutas, autenticación y lógica de negocio viven en sus módulos tipados.
import path from 'node:path'
import type { Server } from 'node:http'
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import { assertEnvironment } from './config/environment'
import { asyncHandler } from './middleware/async'
import { activeClientGuard } from './middleware/auth'
import { securityHeaders } from './middleware/security-headers'
import * as bot from './services/bot-entry'
import * as retell from './integrations/retell'
import * as tunnel from './services/tunnel'
import { setupTelegram } from './integrations/telegram'
import authRouter = require('./routes/auth.routes')
import adminRouter = require('./routes/admin.routes')
import businessRouter = require('./routes/business.routes')
import sessionsRouter = require('./routes/sessions.routes')
import salesRouter = require('./routes/sales.routes')
import reportsRouter = require('./routes/reports.routes')
import bookingsRouter = require('./routes/bookings.routes')
import productsRouter = require('./routes/products.routes')
import ordersRouter = require('./routes/orders.routes')
import webhooksRouter = require('./routes/webhooks.routes')
import lodgingRouter = require('./routes/lodging.routes')

interface StartupDatabase {
  getProductImageById(productId: string): Promise<{ image_url?: string | null } | null>
  getExpiredBusinesses(): Promise<Array<{ id: string; name: string }>>
  suspendBusiness(businessId: string, reason: string): Promise<unknown>
}

interface OperationalError extends Error {
  status?: number
  publicMessage?: string
}

type CorsCallback = (error: Error | null, allow?: boolean) => void
type Cors = (options: {
  origin(origin: string | undefined, callback: CorsCallback): void
}) => RequestHandler

const cors = require('cors') as Cors
const db = require('./db') as StartupDatabase

// Al compilar, __dirname es server/dist. Estas raíces conservan exactamente
// las ubicaciones usadas antes desde server/index.js.
const serverRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(serverRoot, '..')
dotenv.config({ path: path.join(serverRoot, '.env') })
const environment = assertEnvironment(process.env)

const app = express()
let httpServer: Server | null = null
let shuttingDown = false

// Railway/producción corre detrás de un proxy. Express necesita la IP real
// para que express-rate-limit no agrupe a todos los visitantes.
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(securityHeaders)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'apagado ordenado')
}

function shutdown(signal: string, error?: unknown): void {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = error ? 1 : 0
  console.error(`${error ? '🛑' : '⏹️'} ${signal}:`, errorMessage(error))
  const forceExit = setTimeout(() => process.exit(exitCode), 10_000)
  forceExit.unref()
  if (!httpServer) {
    process.exit(exitCode)
    return
  }
  httpServer.close(() => process.exit(exitCode))
}

process.on('uncaughtException', error => shutdown('uncaughtException', error))
process.on('unhandledRejection', reason => shutdown('unhandledRejection', reason))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

function logEnvironment(): void {
  if (environment.recommendedMissing.length) {
    console.warn(
      '⚠️  Faltan variables recomendadas:',
      environment.recommendedMissing.join(', '),
      '\n   Meta necesita META_VERIFY_TOKEN + META_APP_SECRET; en local BASE_URL/WEBHOOK_SECRET son opcionales.',
    )
  }
  console.log('✅ Variables de entorno críticas: OK')
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || !process.env.BASE_URL) return callback(null, true)
    try {
      return callback(null, origin === new URL(process.env.BASE_URL).origin)
    } catch {
      return callback(new Error('BASE_URL inválida'))
    }
  },
}))

// Capturar raw body para verificar firmas de webhooks.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => { (req as Request).rawBody = buffer },
}))

const noCacheHtml = (response: Response, filePath: string): void => {
  if (filePath.endsWith('.html')) {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}

const clientDist = path.join(projectRoot, 'apps/client/dist')
const adminDist = path.join(projectRoot, 'apps/admin/dist')
app.use('/app', express.static(clientDist, { setHeaders: noCacheHtml }))
app.get('/app/*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
app.use('/app-admin', express.static(adminDist, { setHeaders: noCacheHtml }))
app.get('/app-admin/*', (_req, res) => res.sendFile(path.join(adminDist, 'index.html')))
app.get(['/admin', '/admin/*'], (_req, res) => res.redirect('/app-admin'))
app.get(['/client', '/client/*'], (_req, res) => res.redirect('/app'))
app.get('/', (_req, res) => res.redirect('/app-admin'))

app.use(authRouter)
// El login se resuelve en authRouter. Toda ruta cliente posterior revalida
// usuario, negocio y permisos actuales antes de llegar a su router.
app.use('/api/client', activeClientGuard)
app.use(adminRouter)
app.use(businessRouter)
app.use(sessionsRouter)
app.use(salesRouter)
app.use(reportsRouter)
app.use(bookingsRouter)
app.use(productsRouter)
app.use(ordersRouter)
app.use(webhooksRouter)
app.use(lodgingRouter)

const retellLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})
const telegramLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})
app.use('/webhook/telegram', telegramLimiter)
app.post('/api/retell/llm', retellLimiter, retell.verifyRetellLLMRequest, retell.handleRetellLLM)
app.post(
  '/api/retell/call-events',
  retellLimiter,
  retell.verifyRetellRequest,
  retell.handleRetellCallEvent,
)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() })
})

app.get('/api/images/:productId', asyncHandler(async (req: Request, res: Response) => {
  const product = await db.getProductImageById(req.params.productId)
  if (!product?.image_url) return res.status(404).send('No image')

  if (product.image_url.startsWith('data:')) {
    const [header = '', base64 = ''] = product.image_url.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
    const buffer = Buffer.from(base64, 'base64')
    res.set('Content-Type', mimeType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(buffer)
  }

  return res.redirect(product.image_url)
}))

const handleHttpError: ErrorRequestHandler = (error: OperationalError, req, res, next) => {
  const requestId = req.headers['x-request-id'] || 'sin-id'
  console.error(`❌ HTTP ${req.method} ${req.path} [${requestId}]:`, errorMessage(error))
  if (res.headersSent) return next(error)
  return res.status(error.status || 500).json({
    error: error.publicMessage || 'Error interno del servidor',
  })
}
app.use(handleHttpError)

async function checkExpiredClients(): Promise<void> {
  try {
    const expired = await db.getExpiredBusinesses()
    for (const business of expired) {
      await db.suspendBusiness(business.id, 'Plan vencido — renovación requerida')
      console.log(`⛔ Auto-suspendido por vencimiento: ${business.name}`)
    }
    if (expired.length) {
      console.log(`⏰ Verificación: ${expired.length} cliente(s) suspendido(s) por vencimiento`)
    }
  } catch (error) {
    console.error('Error verificando vencimientos:', errorMessage(error))
  }
}

const port = process.env.PORT || 3000
httpServer = app.listen(port, () => {
  logEnvironment()
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${port}`)
  console.log(`👑 Admin:   http://localhost:${port}/app-admin`)
  console.log(`👤 Cliente: http://localhost:${port}/app`)
  console.log(`📡 Webhook: http://localhost:${port}/webhook\n`)

  setTimeout(checkExpiredClients, 3000)
  setInterval(checkExpiredClients, 60 * 60 * 1000)

  setupTelegram(app, bot.handleMessage).then(() => {
    if (process.env.BASE_URL) console.log(`🌐 Producción: ${process.env.BASE_URL}`)
  }).catch(error => console.error('❌ Telegram setup:', errorMessage(error)))

  if (!process.env.BASE_URL) {
    setTimeout(() => {
      tunnel.startTunnel(port)
        .then(state => console.log(`🌐 Túnel automático: ${state.url}`))
        .catch(error => {
          console.log('⚠️  No se pudo auto-iniciar el túnel:', errorMessage(error))
        })
    }, 2500)
  }
})

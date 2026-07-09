// ── ARRANQUE DEL SERVIDOR (Fase 1 de ARQUITECTURA.md) ────────────────
// Este archivo solo levanta el server: setup, estáticos, montaje de
// routers y arranque. Las rutas viven en routes/, la auth en middleware/
// y la lógica compartida en services/.
const express = require('express')
const cors    = require('cors')
const path    = require('path')
const fs      = require('fs')
require('dotenv').config()

const db     = require('./db')
const bot    = require('./bot')
const retell = require('./retell')
const tunnel = require('./tunnel')
const { setupTelegram } = require('./telegram')
const app    = express()

// Railway/producción corre detrás de un proxy: sin esto express-rate-limit
// no ve la IP real (bloquearía a todos) y puede lanzar error por X-Forwarded-For.
app.set('trust proxy', 1)

// ── RED DE SEGURIDAD: el server NUNCA debe caerse por un error aislado ──
process.on('uncaughtException', (err) => {
  console.error('🛑 uncaughtException (server sigue vivo):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('🛑 unhandledRejection (server sigue vivo):', reason?.message || reason)
})

// ── CHEQUEO DE ENTORNO (avisa fuerte si falta algo crítico en el deploy) ──
function checkEnv() {
  const critical = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']
  const recommended = ['BASE_URL', 'WEBHOOK_SECRET']
  const missing = critical.filter(k => !process.env[k] || !String(process.env[k]).trim())
  const missingRec = recommended.filter(k => !process.env[k] || !String(process.env[k]).trim())
  if (missing.length) {
    console.error('\n❌ FALTAN variables CRÍTICAS (el panel/login no funcionará):', missing.join(', '))
    console.error('   Configúralas en Railway → Variables antes de usar en producción.\n')
  }
  if (missingRec.length) {
    console.warn('⚠️  Faltan variables recomendadas en producción:', missingRec.join(', '),
      '\n   BASE_URL desactiva el túnel local y fija la URL; WEBHOOK_SECRET protege los webhooks.')
  }
  if (!missing.length) console.log('✅ Variables de entorno críticas: OK')
}

app.use(cors({ origin: '*' }))
// Capturar raw body para verificar firmas de webhooks (Meta, usado en routes/webhooks.routes.js)
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf } }))

// Paneles — el HTML NO se cachea (siempre última versión); así un cambio en el
// panel se ve al recargar, sin quedar pegado en una versión vieja del navegador.
const noCacheHtml = (res, filePath) => {
  if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
}
app.use('/admin',  express.static(path.join(__dirname, '../admin'),  { setHeaders: noCacheHtml }))
app.use('/client', express.static(path.join(__dirname, '../client'), { setHeaders: noCacheHtml }))
app.get('/', (_, res) => res.redirect('/admin'))

// ══════════════════════════════════════════
// RUTAS (Fase 1 — ver ARQUITECTURA.md)
// ══════════════════════════════════════════
app.use(require('./routes/auth.routes'))      // login admin + login cliente (con rate-limit)
app.use(require('./routes/admin.routes'))     // panel superadmin: negocios, facturación, settings, túnel, simulador
app.use(require('./routes/business.routes'))  // datos del negocio, políticas/prompt, onboarding, equipo
app.use(require('./routes/sessions.routes'))  // conversaciones, sesiones, etiquetas, responder
app.use(require('./routes/sales.routes'))     // ventas manuales + quote
app.use(require('./routes/reports.routes'))   // reportes, dashboard, clientes, alertas
app.use(require('./routes/bookings.routes'))  // horarios y reservas
app.use(require('./routes/products.routes'))  // catálogo + media (Cloudinary) + reindex
app.use(require('./routes/orders.routes'))    // pedidos del bot (núcleo de dinero)
app.use(require('./routes/webhooks.routes'))  // webhooks WhatsApp (Meta/YCloud/Kapso) con firmas y anti-duplicados

// ══════════════════════════════════════════
// RETELL AI — Custom LLM + Call Events
// ══════════════════════════════════════════
app.post('/api/retell/llm',         retell.handleRetellLLM)
app.post('/api/retell/call-events', retell.handleRetellCallEvent)

// HEALTH
app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

// ── LIVE RELOAD (solo en desarrollo) ─────────────────────
if (!process.env.BASE_URL) {
  const lrClients = new Set()

  app.get('/dev-reload', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.flushHeaders()
    res.write('data: connected\n\n')
    lrClients.add(res)
    req.on('close', () => lrClients.delete(res))
  })

  const notify = () => lrClients.forEach(c => c.write('data: reload\n\n'))
  const dirs   = [path.join(__dirname, '../admin'), path.join(__dirname, '../client')]
  dirs.forEach(d => fs.watch(d, { recursive: true }, (_, f) => { if (f?.endsWith('.html') || f?.endsWith('.js') || f?.endsWith('.css')) notify() }))
  console.log('♻️  Live-reload activo')
}

// ── IMÁGENES DE PRODUCTOS ─────────────────────────────────
// Convierte base64 almacenado en BD a imagen servida por URL real
app.get('/api/images/:productId', async (req, res) => {
  const product = await db.getProductById(req.params.productId)
  if (!product?.image_url) return res.status(404).send('No image')

  if (product.image_url.startsWith('data:')) {
    const [header, base64] = product.image_url.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
    const buffer = Buffer.from(base64, 'base64')
    res.set('Content-Type', mimeType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(buffer)
  }

  res.redirect(product.image_url)
})

// SPA fallbacks
app.get('/admin/*',  (_, res) => res.sendFile(path.join(__dirname, '../admin/index.html')))
app.get('/client/*', (_, res) => res.sendFile(path.join(__dirname, '../client/index.html')))

async function checkExpiredClients() {
  try {
    const expired = await db.getExpiredBusinesses()
    for (const biz of expired) {
      await db.suspendBusiness(biz.id, 'Plan vencido — renovación requerida')
      console.log(`⛔ Auto-suspendido por vencimiento: ${biz.name}`)
    }
    if (expired.length) console.log(`⏰ Verificación: ${expired.length} cliente(s) suspendido(s) por vencimiento`)
  } catch(e) {
    console.error('Error verificando vencimientos:', e.message)
  }
}

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  checkEnv()
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${PORT}`)
  console.log(`👑 Admin:   http://localhost:${PORT}/admin`)
  console.log(`👤 Cliente: http://localhost:${PORT}/client`)
  console.log(`📡 Webhook: http://localhost:${PORT}/webhook\n`)

  // Verificar vencimientos al arrancar y cada hora
  setTimeout(checkExpiredClients, 3000)
  setInterval(checkExpiredClients, 60 * 60 * 1000)

  // Telegram bot (polling local / webhook en producción)
  setupTelegram(app, bot.handleMessage).then(() => {
    if (process.env.BASE_URL) console.log(`🌐 Producción: ${process.env.BASE_URL}`)
  }).catch(e => console.error('❌ Telegram setup:', e.message))

  // Auto-arrancar el túnel al iniciar (solo en local). Queda vivo toda la sesión del
  // servidor → recargar la pestaña NO lo apaga; solo cambia al reiniciar el servidor.
  if (!process.env.BASE_URL) {
    setTimeout(() => {
      tunnel.startTunnel(PORT)
        .then(s => console.log(`🌐 Túnel automático: ${s.url}`))
        .catch(e => console.log('⚠️  No se pudo auto-iniciar el túnel:', e.message))
    }, 2500)
  }
})

// ── RUTAS: CATÁLOGO DEL CLIENTE (productos + media) ──────────────────
// Extraído de index.js (Fase 1 de ARQUITECTURA.md) SIN cambios de
// comportamiento: mismas URLs, misma auth, mismas respuestas.
// Aislamiento multi-tenant: el business_id SIEMPRE sale del JWT.
const express = require('express')
const multer  = require('multer')
const db      = require('../db')
const bot     = require('../bot')
const cloud   = require('../cloudinary')
const { authClient, requirePermission } = require('../middleware/auth')

const router = express.Router()

// Subida de media (imágenes/videos) en memoria → se reenvía a Cloudinary.
// Límite 16MB (tope de WhatsApp para video). multipart no pasa por express.json.
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } })
const mediaUpload = (req, res, next) => uploadMem.single('file')(req, res, err => {
  if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
    .json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Archivo demasiado grande (máx 16MB)' : err.message })
  next()
})

router.get('/api/client/products', authClient, async (req, res) => res.json(await db.getProducts(req.user.businessId)))

router.post('/api/client/products', authClient, requirePermission('catalogo'), async (req, res) => {
  const { name, price } = req.body
  if (!name || !price) return res.status(400).json({ error: 'Nombre y precio requeridos' })
  const { data, error } = await db.createProduct({ ...req.body, business_id: req.user.businessId, price: parseFloat(price), active: true })
  if (error) return res.status(500).json({ error: error.message })
  // Generar embedding en segundo plano (RAG) — no bloquea la respuesta
  bot.indexProduct(data).catch(() => {})
  res.status(201).json(data)
})

router.put('/api/client/products/:id', authClient, requirePermission('catalogo'), async (req, res) => {
  // Estado anterior para limpiar media reemplazada de Cloudinary (aislamiento: debe ser del negocio del JWT)
  const prev = await db.getProductById(req.params.id)
  if (prev && prev.business_id !== req.user.businessId) return res.status(404).json({ error: 'No encontrado' })
  await db.updateProduct(req.user.businessId, req.params.id, req.body)
  // Si se reemplazó/quitó una imagen o video, borrar el archivo anterior de Cloudinary (ahorra storage)
  if (prev) {
    if (prev.image_public_id && req.body.image_public_id !== prev.image_public_id) cloud.deleteMedia(prev.image_public_id, 'image')
    if (prev.video_public_id && req.body.video_public_id !== prev.video_public_id) cloud.deleteMedia(prev.video_public_id, 'video')
  }
  // Re-generar embedding tras editar
  db.getProductById(req.params.id).then(p => p && bot.indexProduct(p)).catch(() => {})
  res.json({ ok: true })
})

router.delete('/api/client/products/:id', authClient, requirePermission('catalogo'), async (req, res) => {
  await db.deleteProduct(req.user.businessId, req.params.id)
  res.json({ ok: true })
})

// ── SUBIR MEDIA DE PRODUCTO (imagen o video) → Cloudinary ─────────
// Recibe un archivo (multipart), lo sube a la carpeta del negocio y
// devuelve { url, public_id, resource_type } para guardar en el producto.
router.post('/api/client/media', authClient, requirePermission('catalogo'), mediaUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' })
    const mime = req.file.mimetype || ''
    if (!mime.startsWith('image/') && !mime.startsWith('video/'))
      return res.status(400).json({ error: 'Solo se permiten imágenes o videos' })
    // Límites estándar de WhatsApp: imagen 5 MB, video 16 MB
    const isVideo = mime.startsWith('video/')
    const max = isVideo ? 16 * 1024 * 1024 : 5 * 1024 * 1024
    if (req.file.size > max) {
      const pesa = (req.file.size / 1024 / 1024).toFixed(1)
      return res.status(413).json({ error: `El archivo supera el límite de WhatsApp (${isVideo ? '16 MB para video' : '5 MB para imagen'}). Tu archivo pesa ${pesa} MB.` })
    }
    if (!(await cloud.isConfigured()))
      return res.status(503).json({ error: 'Cloudinary no está configurado. Agrégalo en el panel de administración → Configuración.' })
    const out = await cloud.uploadMedia(req.file.buffer, req.user.businessId)
    console.log(`☁️  Media subida (${out.resource_type}) para negocio ${req.user.businessId}: ${out.public_id}`)
    res.json(out)
  } catch(e) {
    console.error('❌ subir media:', e.message)
    res.status(500).json({ error: 'No se pudo subir el archivo. Intenta de nuevo.' })
  }
})

// Reindexar (generar embeddings) de los productos que aún no tienen — para catálogos existentes
router.post('/api/client/reindex', authClient, requirePermission('catalogo'), async (req, res) => {
  try {
    const pending = await db.getProductsWithoutEmbedding(req.user.businessId)
    res.json({ ok: true, pending: pending.length, message: pending.length ? `Indexando ${pending.length} productos en segundo plano…` : 'Todos los productos ya están indexados ✓' })
    // Procesar en segundo plano, de a uno (evita rate limits)
    for (const p of pending) { await bot.indexProduct(p) }
    if (pending.length) console.log(`✅ [reindex] ${pending.length} productos indexados`)
  } catch(e) { console.error('❌ reindex:', e.message) }
})

module.exports = router

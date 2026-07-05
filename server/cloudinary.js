// ── CLOUDINARY — media (imágenes + videos) de productos ──────────────
// Una sola cuenta Cloudinary para todo el SaaS. Los archivos se separan
// por carpeta `botpanel/{business_id}` → aislamiento por negocio.
// Las llaves se leen con settings.get (panel > .env), NUNCA hardcodeadas.
const cloudinary = require('cloudinary').v2
const settings = require('./settings')

// Configura el SDK con las llaves globales. Devuelve false si faltan.
async function configure() {
  const cloud_name = await settings.get('cloudinary_cloud_name')
  const api_key    = await settings.get('cloudinary_api_key')
  const api_secret = await settings.get('cloudinary_api_secret')
  if (!cloud_name || !api_key || !api_secret) return false
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true })
  return true
}

async function isConfigured() { return configure() }

// Sube un buffer (imagen o video) a la carpeta del negocio.
// resource_type 'auto' → Cloudinary detecta si es imagen o video.
// Devuelve { url, public_id, resource_type }.
async function uploadMedia(buffer, businessId) {
  if (!(await configure())) throw new Error('Cloudinary no está configurado')
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `botpanel/${businessId}`, resource_type: 'auto' },
      (err, res) => {
        if (err) return reject(err)
        resolve({ url: res.secure_url, public_id: res.public_id, resource_type: res.resource_type })
      }
    )
    stream.end(buffer)
  })
}

// Borra un archivo por public_id (limpieza al reemplazar/eliminar → ahorra storage).
async function deleteMedia(publicId, resourceType = 'image') {
  if (!publicId) return
  if (!(await configure())) return
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType })
    console.log(`🗑️  Cloudinary: borrado ${publicId}`)
  } catch (e) {
    console.error('❌ Cloudinary destroy:', e.message)
  }
}

module.exports = { isConfigured, uploadMedia, deleteMedia }

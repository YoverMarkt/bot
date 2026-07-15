import type { RequestHandler, Router } from 'express'
import multer from 'multer'
import { getClientBusinessId } from '../lib/request'
import { MEDIA_LIMITS, mapMulterError, validateMediaFile } from '../lib/media'
import { createRouter } from '../middleware/async'
import { isConfigured, uploadMedia } from '../integrations/cloudinary'

const auth = require('../middleware/auth') as {
  authClient: RequestHandler
}

type MediaRouter = Router & {
  multipartFileSize: number
}

const router = createRouter() as MediaRouter
router.multipartFileSize = MEDIA_LIMITS.multipart

// El mismo uploader sirve al catálogo y al módulo de hospedaje. El archivo
// siempre se guarda bajo el business_id del JWT; nunca se acepta un tenant del body.
const canUploadBusinessMedia: RequestHandler = (req, res, next) => {
  const user = req.user as Express.ClientUserClaims | undefined
  if (user?.urole === 'owner') return next()
  const permissions = Array.isArray(user?.perms) ? user.perms : []
  if (permissions.includes('catalogo') || permissions.includes('hospedaje')) return next()
  return res.status(403).json({ error: 'No tienes permiso para subir archivos' })
}

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_LIMITS.multipart },
})

const mediaUpload: RequestHandler = (req, res, next) => {
  uploadMemory.single('file')(req, res, error => {
    if (error) {
      const mapped = mapMulterError(error)
      return res.status(mapped.status).json({ error: mapped.error })
    }
    next()
  })
}

router.post(
  '/api/client/media',
  auth.authClient,
  canUploadBusinessMedia,
  mediaUpload,
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' })

      const validationError = validateMediaFile(req.file)
      if (validationError) {
        return res.status(validationError.status).json({ error: validationError.error })
      }
      if (!(await isConfigured())) {
        return res.status(503).json({
          error: 'Cloudinary no está configurado. Agrégalo en el panel de administración → Configuración.',
        })
      }

      const businessId = getClientBusinessId(req)
      const uploaded = await uploadMedia(req.file.buffer, businessId)
      console.log(
        `☁️  Media subida (${uploaded.resource_type}) para negocio ${businessId}: ${uploaded.public_id}`,
      )
      res.json(uploaded)
    } catch (error) {
      console.error('❌ subir media:', (error as Error).message)
      res.status(500).json({ error: 'No se pudo subir el archivo. Intenta de nuevo.' })
    }
  },
)

export = router

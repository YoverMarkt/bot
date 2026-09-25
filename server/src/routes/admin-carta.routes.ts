import type { RequestHandler } from 'express'
import multer from 'multer'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// LEER LA CARTA DE UN LOCAL (SUPERADMIN)
// ═══════════════════════════════════════════════════════════════════════════
//
// Recibe las fotos de la carta y devuelve lo que la IA leyó. **No guarda
// nada**: la propuesta vuelve al panel, una persona la revisa, y solo lo
// revisado viaja con el alta (`POST /api/admin/clients`, campo `carta`).
// Por eso esta ruta no lleva negocio: todavía no existe.
//
// Ver `services/carta-del-local.ts`.

interface ModuloCarta {
  LIMITES: { fotos: number }
  leerCarta(fotos: Array<{ buffer: Buffer, mimetype?: string | null }>): Promise<
    | { ok: true, propuesta: unknown }
    | { ok: false, motivo: string }
  >
}
const carta: ModuloCarta = require('../services/carta-del-local') as typeof import('../services/carta-del-local')

interface ModuloAuth {
  authAdmin: RequestHandler
}
const { authAdmin }: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const errorLog = require('../services/error-log') as typeof import('../services/error-log')

/** Una foto de móvil ronda 2-6 MB; 10 deja margen sin abrir la puerta a vídeos. */
const TAMANO_MAXIMO = 10 * 1024 * 1024

/** Lo que el modelo de visión acepta. Un HEIC se rechaza con un motivo claro. */
const FORMATOS = new Set(['image/jpeg', 'image/png', 'image/webp'])

const subirFotos: RequestHandler = (req, res, next) => {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TAMANO_MAXIMO, files: carta.LIMITES.fotos },
  }).array('fotos', carta.LIMITES.fotos)(req, res, (error: unknown) => {
    if (!error) return next()
    const codigo = (error as { code?: string }).code
    if (codigo === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Cada foto puede pesar como mucho 10 MB' })
    }
    if (codigo === 'LIMIT_FILE_COUNT' || codigo === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: `Como mucho ${carta.LIMITES.fotos} fotos por carta` })
    }
    return res.status(400).json({ error: 'No se pudieron recibir las fotos' })
  })
}

/** Lo que se le dice al superadmin por cada motivo de `leerCarta`. */
const RESPUESTAS: Record<string, { status: number, error: string }> = {
  sin_credencial: {
    status: 503,
    error: 'Falta la clave de OpenAI: agrégala en Configuración para leer cartas',
  },
  sin_productos: {
    status: 422,
    error: 'No encontré productos en la foto. Prueba con una foto más cerca y con buena luz',
  },
}
const FALLO_DE_LECTURA = {
  status: 502,
  error: 'La IA no pudo leer la carta. Vuelve a intentarlo o prueba con otra foto',
}

const router = createRouter()

router.post('/api/admin/carta/leer', authAdmin, subirFotos, async (req, res) => {
  const fotos = (req.files as Express.Multer.File[] | undefined) || []
  if (!fotos.length) return res.status(400).json({ error: 'Sube al menos una foto de la carta' })
  const noEsFoto = fotos.find(foto => !FORMATOS.has(foto.mimetype))
  if (noEsFoto) {
    return res.status(400).json({
      error: 'Las fotos tienen que ser JPG, PNG o WEBP (las de iPhone en HEIC no se leen)',
    })
  }

  const resultado = await carta.leerCarta(fotos.map(foto => ({
    buffer: foto.buffer,
    mimetype: foto.mimetype,
  })))
  if (resultado.ok) return res.json({ propuesta: resultado.propuesta })

  const respuesta = RESPUESTAS[resultado.motivo] || FALLO_DE_LECTURA
  if (respuesta === FALLO_DE_LECTURA) {
    // Que la IA falle no es culpa de la foto: se deja rastro para verlo en el
    // registro de errores si empieza a repetirse.
    void errorLog.recordError({
      category: 'ia',
      code: 'carta_ilegible',
      message: `No se pudo leer una carta: ${resultado.motivo}`,
      context: { fotos: fotos.length },
    })
  }
  return res.status(respuesta.status).json({ error: respuesta.error })
})

export = router

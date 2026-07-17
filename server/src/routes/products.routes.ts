import { createRouter } from '../middleware/async'
import productsCoreRouter = require('./products-core.routes')
import productsMediaRouter = require('./products-media.routes')

const router = createRouter()

router.use(productsCoreRouter)
router.use(productsMediaRouter)

export = router

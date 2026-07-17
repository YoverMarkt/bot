import { createRouter } from '../middleware/async'
import clientsRouter = require('./admin-clients.routes')
import billingRouter = require('./admin-billing.routes')
import providersRouter = require('./admin-providers.routes')
import settingsRouter = require('./admin-settings.routes')
import tunnelRouter = require('./admin-tunnel.routes')
import simulatorRouter = require('./admin-simulator.routes')

const router = createRouter()

router.use(clientsRouter)
router.use(billingRouter)
router.use(providersRouter)
router.use(settingsRouter)
router.use(tunnelRouter)
router.use(simulatorRouter)

export = router

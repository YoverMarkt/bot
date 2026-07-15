import { createRouter } from '../middleware/async'
import profileRouter = require('./business-profile.routes')
import managementRouter = require('./business-management.routes')

const router = createRouter()

router.use(profileRouter)
router.use(managementRouter)

export = router

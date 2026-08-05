import businesses = require('./repositories/businesses')
import users = require('./repositories/client-users')
import policies = require('./repositories/policies')
import billing = require('./repositories/billing')
import products = require('./repositories/products')
import history = require('./repositories/conversation-history')
import sessions = require('./repositories/sessions')
import tags = require('./repositories/conversation-tags')
import bookings = require('./repositories/bookings')
import sales = require('./repositories/sales')
import reporting = require('./repositories/reporting')
import orders = require('./repositories/orders')
import stats = require('./repositories/stats')
import webhookEvents = require('./repositories/webhook-events')
import lodging = require('./repositories/lodging')
import menuModifiers = require('./repositories/menu-modifiers')
import usage = require('./repositories/usage')
import platformErrors = require('./repositories/platform-errors')
import storefront = require('./repositories/storefront')
import catalog = require('./repositories/catalog')
import productOptions = require('./repositories/product-options')

// SIN anotación a propósito: aquí TypeScript infiere el tipo REAL de los 20
// repositorios juntos. Estuvo anotado como `Record<string, unknown>` y eso
// tiraba todos los tipos, obligando a cada consumidor a declarar su interfaz y
// AFIRMARLA con `as` —que el compilador no comprueba—. Así se coló en
// producción un `issueLink` que no existía (2026-08-02).
const database = {
  ...businesses,
  ...users,
  ...policies,
  ...billing,
  ...products,
  ...history,
  ...sessions,
  ...tags,
  ...bookings,
  ...sales,
  ...reporting,
  ...orders,
  ...stats,
  ...webhookEvents,
  ...lodging,
  ...menuModifiers,
  ...usage,
  ...platformErrors,
  ...storefront,
  ...catalog,
  ...productOptions,
}

export = database

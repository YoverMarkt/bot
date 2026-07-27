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

const database: Record<string, unknown> = {
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
}

export = database

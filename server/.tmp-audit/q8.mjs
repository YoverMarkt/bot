import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
const { count, error } = await sb.from('businesses').select('*',{count:'exact',head:true})
  .eq('active',true).not('suspended','is',true).eq('takes_orders',true).eq('storefront_enabled',true)
console.log('con not.is.true →', count, error?.message||'(sin error)')

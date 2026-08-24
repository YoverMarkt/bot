import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
const { count: enMkt, error: e1 } = await sb.from('businesses').select('*',{count:'exact',head:true})
  .eq('active',true).neq('suspended',true).eq('takes_orders',true).eq('storefront_enabled',true)
console.log('Activos → en el marketplace:', enMkt, e1?.message||'')
const { data: cats } = await sb.rpc('marketplace_categories_disponibles')
console.log('Locales según la RPC del menú:', (cats||[]).reduce((a,c)=>a+Number(c.locales),0))
const { count: msgs } = await sb.from('webhook_inbound_events').select('*',{count:'exact',head:true}).gte('received_at', new Date(Date.now()-86400000).toISOString())
console.log('Mensajes hoy (entrantes al número):', msgs)
const { data: plat, error: e2 } = await sb.from('webhook_inbound_events').select('received_at').is('business_id',null).order('received_at',{ascending:false}).limit(1).maybeSingle()
console.log('Último entrante del número de la plataforma:', plat?.received_at, e2?.message||'')
// ¿suspended admite NULL?
const { data: nulos } = await sb.from('businesses').select('id').is('suspended', null)
console.log('Negocios con suspended NULL:', (nulos||[]).length)

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'node:path'

dotenv.config({ path: path.join(__dirname, '../../.env') })

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!url || !key) {
  throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en el servidor')
}

// Cliente único del backend. La service role nunca se exporta al navegador.
const supabase = createClient(url, key)

export = supabase

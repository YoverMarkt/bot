import type { SupabaseClient } from '@supabase/supabase-js'

type UserData = Record<string, unknown>

const db = require('../client') as SupabaseClient

// El email es único globalmente y esta búsqueda se usa únicamente durante login.
const getClientByEmail = async (email: string) => {
  const { data } = await db.from('client_users').select('*').eq('email', email).single()
  return data
}

const getClientUserByBusiness = async (businessId: string) => {
  const { data } = await db
    .from('client_users')
    .select('email')
    .eq('business_id', businessId)
    .eq('role', 'owner')
    .maybeSingle()
  return data
}

const createClientUser = async (data: UserData) => (
  db.from('client_users').insert(data).select().single()
)

const updateClientUser = async (
  businessId: string,
  email: string,
  passwordHash: string | null,
) => {
  const { data: existing, error } = await db
    .from('client_users')
    .select('id')
    .eq('business_id', businessId)
    .eq('role', 'owner')
    .maybeSingle()
  if (error) return { error }

  if (existing) {
    const update: UserData = { email }
    if (passwordHash) update.password_hash = passwordHash
    return db
      .from('client_users')
      .update(update)
      .eq('id', existing.id)
      .eq('business_id', businessId)
      .eq('role', 'owner')
  }

  return db.from('client_users').insert({
    business_id: businessId,
    email,
    password_hash: passwordHash,
    role: 'owner',
  })
}

const getClientUsers = async (businessId: string) => {
  const { data, error } = await db
    .from('client_users')
    .select('id,email,name,role,permissions,created_at')
    .eq('business_id', businessId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data || []
}

const getClientUserById = async (businessId: string, id: string) => {
  const { data } = await db
    .from('client_users')
    .select('*')
    .eq('business_id', businessId)
    .eq('id', id)
    .single()
  return data
}

// Esta vía solo puede modificar empleados; el dueño se administra por separado.
const updateClientUserById = async (
  businessId: string,
  id: string,
  fields: UserData,
) => db
  .from('client_users')
  .update(fields)
  .eq('business_id', businessId)
  .eq('id', id)
  .eq('role', 'employee')

const deleteClientUserById = async (businessId: string, id: string) => db
  .from('client_users')
  .delete()
  .eq('business_id', businessId)
  .eq('id', id)
  .eq('role', 'employee')

export = {
  getClientByEmail,
  getClientUserByBusiness,
  createClientUser,
  updateClientUser,
  getClientUsers,
  getClientUserById,
  updateClientUserById,
  deleteClientUserById,
}

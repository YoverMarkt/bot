import type { SupabaseClient } from '@supabase/supabase-js'

interface TagData {
  name: string
  color?: unknown
}

const db = require('../client') as SupabaseClient

const getTags = async (businessId: string) => {
  const { data } = await db
    .from('conversation_tags')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at')
  return data || []
}

const createTag = async (businessId: string, data: TagData) => db
  .from('conversation_tags')
  .insert({
    business_id: businessId,
    name: data.name,
    color: data.color || '#2a78d6',
  })
  .select()
  .single()

const updateTag = async (businessId: string, id: string, data: TagData) => db
  .from('conversation_tags')
  .update({ name: data.name, color: data.color })
  .eq('business_id', businessId)
  .eq('id', id)

const deleteTag = async (businessId: string, id: string) => db
  .from('conversation_tags')
  .delete()
  .eq('business_id', businessId)
  .eq('id', id)

export = { getTags, createTag, updateTag, deleteTag }

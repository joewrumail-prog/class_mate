import type { Context, Next } from 'hono'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

export async function getUserFromRequest(c: Context): Promise<User | null> {
  const authHeader = c.req.header('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return null

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return null

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return null

  return data.user
}

export async function requireAuth(c: Context, next: Next) {
  const user = await getUserFromRequest(c)
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  c.set('user', user)
  await next()
}

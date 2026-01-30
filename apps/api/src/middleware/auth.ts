import type { Context, Next } from 'hono'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase.js'
import type { AppVariables } from '../types.js'

export async function getUserFromRequest(c: Context<{ Variables: AppVariables }>): Promise<User | null> {
  const authHeader = c.req.header('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return null

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) return null

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) return null

  return data.user
}

export async function requireAuth(c: Context<{ Variables: AppVariables }>, next: Next) {
  const user = await getUserFromRequest(c)
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  c.set('user', user)
  await next()
}

const INVITE_CODE = process.env.INVITE_CODE || ''

const isEduEmail = (email?: string | null) => {
  if (!email) return false
  const lower = email.toLowerCase()
  return lower.endsWith('.edu') || lower.endsWith('@rutgers.edu')
}

export async function requireAccess(c: Context<{ Variables: AppVariables }>, next: Next) {
  const user = await getUserFromRequest(c)
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  const { data: profile, error } = await supabase
    .from('users')
    .select('id, invite_code, is_edu_email')
    .eq('id', user.id)
    .single()

  if (error && error.code !== 'PGRST116') {
    return c.json({ success: false, error: 'Failed to verify access' }, 500)
  }

  const eduAllowed = profile?.is_edu_email || isEduEmail(user.email)
  const inviteAllowed = INVITE_CODE && profile?.invite_code === INVITE_CODE

  if (!eduAllowed && !inviteAllowed) {
    return c.json({ success: false, error: 'Invite code required' }, 403)
  }

  c.set('user', user)
  await next()
}

import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase'

export const userRoutes = new Hono()

// Get user profile
userRoutes.get('/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single()
    
    if (error) throw error
    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404)
    }
    
    return c.json({ success: true, user })
  } catch (error: any) {
    console.error('Get user error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Update user profile
const updateSchema = z.object({
  nickname: z.string().min(2).optional(),
  wechat: z.string().optional().nullable(),
  qq: z.string().optional().nullable(),
  school: z.string().optional().nullable(),
  avatar_url: z.string().url().optional().nullable(),
})

userRoutes.patch('/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    const body = await c.req.json()
    const updates = updateSchema.parse(body)
    
    const { data: user, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single()
    
    if (error) throw error
    
    return c.json({ success: true, user })
  } catch (error: any) {
    console.error('Update user error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Get user notifications
userRoutes.get('/:userId/notifications', async (c) => {
  try {
    const userId = c.req.param('userId')
    const unreadOnly = c.req.query('unread') === 'true'
    
    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)
    
    if (unreadOnly) {
      query = query.eq('is_read', false)
    }
    
    const { data: notifications, error } = await query
    
    if (error) throw error
    
    return c.json({ success: true, notifications: notifications || [] })
  } catch (error: any) {
    console.error('Get notifications error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Mark notifications as read
userRoutes.post('/:userId/notifications/read', async (c) => {
  try {
    const userId = c.req.param('userId')
    const body = await c.req.json()
    const { ids } = body as { ids?: string[] }
    
    let query = supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
    
    if (ids && ids.length > 0) {
      query = query.in('id', ids)
    }
    
    const { error } = await query
    
    if (error) throw error
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Mark read error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Mark single notification as read
userRoutes.post('/:userId/notifications/:notificationId/read', async (c) => {
  try {
    const userId = c.req.param('userId')
    const notificationId = c.req.param('notificationId')
    
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('id', notificationId)
    
    if (error) throw error
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Mark single read error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Mark all notifications as read
userRoutes.post('/:userId/notifications/read-all', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false)
    
    if (error) throw error
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Mark all read error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

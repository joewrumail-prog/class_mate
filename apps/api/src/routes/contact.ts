import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const contactRoutes = new Hono()

/**
 * 发送联系方式请求
 */
const requestSchema = z.object({
  requesterId: z.string().uuid(),
  targetId: z.string().uuid(),
  roomId: z.string().uuid().optional(),
  message: z.string().max(200).optional(),
})

contactRoutes.post('/request', requireAuth, async (c) => {
  try {
    const body = await c.req.json()
    const { requesterId, targetId, roomId, message } = requestSchema.parse(body)

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && requesterId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
    // 不能向自己发送请求
    if (requesterId === targetId) {
      return c.json({ success: false, error: 'Cannot request your own contact' }, 400)
    }
    
    // 检查是否已经是好友
    const { data: isConnected } = await supabase.rpc('are_connected', {
      user_id_1: requesterId,
      user_id_2: targetId,
    })
    
    if (isConnected) {
      return c.json({ success: false, error: 'Already connected' }, 400)
    }
    
    // 检查是否可以发送请求（1小时限制）
    const { data: canRequest } = await supabase.rpc('can_request_contact', {
      p_requester_id: requesterId,
      p_target_id: targetId,
    })
    
    if (!canRequest) {
      return c.json({ 
        success: false, 
        error: 'Cannot send request. Either pending or need to wait 1 hour after rejection.' 
      }, 400)
    }
    
    // 删除旧的请求记录（如果有）
    await supabase
      .from('contact_requests')
      .delete()
      .eq('requester_id', requesterId)
      .eq('target_user_id', targetId)
    
    // 创建新请求
    const { data: request, error } = await supabase
      .from('contact_requests')
      .insert({
        requester_id: requesterId,
        target_user_id: targetId,
        room_id: roomId || null,
        message: message || null,
        status: 'pending',
      })
      .select()
      .single()
    
    if (error) throw error
    
    // 获取请求者信息用于通知
    const { data: requester } = await supabase
      .from('users')
      .select('nickname')
      .eq('id', requesterId)
      .single()
    
    // 获取房间信息（如果有）
    let roomName = ''
    if (roomId) {
      const { data: room } = await supabase
        .from('course_rooms')
        .select('courses(name)')
        .eq('id', roomId)
        .single()
      roomName = room?.courses?.name || ''
    }
    
    // 发送站内通知给目标用户
    await supabase.from('notifications').insert({
      user_id: targetId,
      type: 'contact_request',
      title: 'New contact request',
      content: `${requester?.nickname || 'A classmate'}${roomName ? ` from "${roomName}"` : ''} wants to see your contact info`,
      data: {
        request_id: request.id,
        requester_id: requesterId,
        room_id: roomId,
      },
    })
    
    return c.json({ 
      success: true, 
      message: 'Request sent successfully',
      request,
    })
  } catch (error: any) {
    console.error('Request contact error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 响应联系方式请求（同意/拒绝）
 */
const respondSchema = z.object({
  requestId: z.string().uuid(),
  userId: z.string().uuid(),  // 当前用户（必须是 target）
  accept: z.boolean(),  // true = approve, false = reject
})

contactRoutes.post('/respond', requireAuth, async (c) => {
  try {
    const body = await c.req.json()
    const { requestId, userId, accept } = respondSchema.parse(body)

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
    // 获取请求
    const { data: request, error: fetchError } = await supabase
      .from('contact_requests')
      .select('*')
      .eq('id', requestId)
      .eq('target_user_id', userId)  // 确保是目标用户在响应
      .eq('status', 'pending')
      .single()
    
    if (fetchError || !request) {
      return c.json({ success: false, error: 'Request not found or already responded' }, 404)
    }
    
    // 更新请求状态
    const { error: updateError } = await supabase
      .from('contact_requests')
      .update({
        status: accept ? 'accepted' : 'rejected',
        responded_at: new Date().toISOString(),
      })
      .eq('id', requestId)
    
    if (updateError) throw updateError
    
    // 如果同意，创建好友连接
    if (accept) {
      // 确保 user_id_1 < user_id_2 以满足约束
      const [userId1, userId2] = request.requester_id < request.target_user_id 
        ? [request.requester_id, request.target_user_id]
        : [request.target_user_id, request.requester_id]
      
      const { error: connectionError } = await supabase
        .from('user_connections')
        .insert({
          user_id_1: userId1,
          user_id_2: userId2,
          room_id: request.room_id,
        })
      
      if (connectionError && !connectionError.message.includes('duplicate')) {
        throw connectionError
      }
    }
    
    // 获取目标用户信息用于通知
    const { data: target } = await supabase
      .from('users')
      .select('nickname')
      .eq('id', userId)
      .single()
    
    // 发送通知给请求者
    await supabase.from('notifications').insert({
      user_id: request.requester_id,
      type: accept ? 'contact_accepted' : 'contact_rejected',
      title: accept ? 'Contact request accepted!' : 'Contact request declined',
      content: accept 
        ? `${target?.nickname || 'A classmate'} accepted your request. You can now see each other's contact info.`
        : `${target?.nickname || 'A classmate'} declined your request. You can try again in 1 hour.`,
      data: {
        request_id: requestId,
        target_id: userId,
      },
    })
    
    return c.json({ 
      success: true, 
      message: accept ? 'Request accepted' : 'Request declined',
    })
  } catch (error: any) {
    console.error('Respond contact error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 获取我的好友列表（互相可见联系方式的用户）
 */
contactRoutes.get('/connections/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId')

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
    // 获取所有连接（用户可能是 user_id_1 或 user_id_2）
    const { data: connections, error } = await supabase
      .from('user_connections')
      .select(`
        id,
        created_at,
        room_id,
        user_id_1,
        user_id_2
      `)
      .or(`user_id_1.eq.${userId},user_id_2.eq.${userId}`)
      .order('created_at', { ascending: false })
    
    if (error) throw error
    
    // 获取连接用户的详细信息
    const friendIds = connections?.map(c => 
      c.user_id_1 === userId ? c.user_id_2 : c.user_id_1
    ) || []
    
    if (friendIds.length === 0) {
      return c.json({ success: true, connections: [] })
    }
    
    const { data: friends } = await supabase
      .from('users')
      .select('id, nickname, avatar_url, wechat, qq, school')
      .in('id', friendIds)
    
    // 获取房间信息
    const roomIds = connections?.map(c => c.room_id).filter(Boolean) || []
    const { data: rooms } = roomIds.length > 0 
      ? await supabase
          .from('course_rooms')
          .select('id, courses(name)')
          .in('id', roomIds)
      : { data: [] }
    
    const roomMap = new Map(rooms?.map(r => [r.id, r.courses?.name]) || [])
    
    // 组合结果
    const result = connections?.map(conn => {
      const friendId = conn.user_id_1 === userId ? conn.user_id_2 : conn.user_id_1
      const friend = friends?.find(f => f.id === friendId)
      
      return {
        connectionId: conn.id,
        connectedAt: conn.created_at,
        roomName: conn.room_id ? roomMap.get(conn.room_id) : null,
        friend: friend || null,
      }
    }) || []
    
    return c.json({ success: true, connections: result })
  } catch (error: any) {
    console.error('Get connections error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 获取待处理的请求（我收到的）
 */
contactRoutes.get('/pending/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId')

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
    const { data: requests, error } = await supabase
      .from('contact_requests')
      .select(`
        id,
        requester_id,
        room_id,
        message,
        created_at
      `)
      .eq('target_user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    
    if (error) throw error
    
    // 获取请求者信息
    const requesterIds = requests?.map(r => r.requester_id) || []
    
    if (requesterIds.length === 0) {
      return c.json({ success: true, requests: [] })
    }
    
    const { data: requesters } = await supabase
      .from('users')
      .select('id, nickname, avatar_url, school')
      .in('id', requesterIds)
    
    // 获取房间信息
    const roomIds = requests?.map(r => r.room_id).filter(Boolean) || []
    const { data: rooms } = roomIds.length > 0
      ? await supabase
          .from('course_rooms')
          .select('id, courses(name)')
          .in('id', roomIds)
      : { data: [] }
    
    const roomMap = new Map(rooms?.map(r => [r.id, r.courses?.name]) || [])
    
    // 组合结果
    const result = requests?.map(req => ({
      id: req.id,
      message: req.message,
      createdAt: req.created_at,
      roomName: req.room_id ? roomMap.get(req.room_id) : null,
      requester: requesters?.find(u => u.id === req.requester_id) || null,
    })) || []
    
    return c.json({ success: true, requests: result })
  } catch (error: any) {
    console.error('Get pending requests error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 检查与某用户的连接状态
 */
contactRoutes.get('/status/:userId/:targetId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId')
    const targetId = c.req.param('targetId')

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
    // 检查是否已连接
    const { data: isConnected } = await supabase.rpc('are_connected', {
      user_id_1: userId,
      user_id_2: targetId,
    })
    
    if (isConnected) {
      return c.json({ success: true, status: 'connected' })
    }
    
    // 检查是否有待处理的请求
    const { data: pendingRequest } = await supabase
      .from('contact_requests')
      .select('id, requester_id, status')
      .or(`and(requester_id.eq.${userId},target_user_id.eq.${targetId}),and(requester_id.eq.${targetId},target_user_id.eq.${userId})`)
      .eq('status', 'pending')
      .single()
    
    if (pendingRequest) {
      return c.json({ 
        success: true, 
        status: 'pending',
        isSender: pendingRequest.requester_id === userId,
        requestId: pendingRequest.id,
      })
    }
    
    // 检查是否可以发送请求
    const { data: canRequest } = await supabase.rpc('can_request_contact', {
      p_requester_id: userId,
      p_target_id: targetId,
    })
    
    return c.json({ 
      success: true, 
      status: 'none',
      canRequest: canRequest || false,
    })
  } catch (error: any) {
    console.error('Check status error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

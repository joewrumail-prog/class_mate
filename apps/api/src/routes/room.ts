import { Hono } from 'hono'
import { supabase } from '../lib/supabase'

export const roomRoutes = new Hono()

// Get user's rooms
roomRoutes.get('/my/:userId', async (c) => {
  try {
    const userId = c.req.param('userId')
    
    const { data: memberships, error } = await supabase
      .from('room_members')
      .select(`
        room_id,
        joined_at,
        course_rooms (
          id,
          day_of_week,
          start_time,
          end_time,
          professor,
          classroom,
          weeks,
          member_count,
          semester_id,
          courses (
            id,
            name,
            code
          )
        )
      `)
      .eq('user_id', userId)
      .order('joined_at', { ascending: false })
    
    if (error) throw error
    
    const rooms = memberships?.map(m => ({
      id: m.course_rooms.id,
      courseName: m.course_rooms.courses.name,
      courseCode: m.course_rooms.courses.code,
      dayOfWeek: m.course_rooms.day_of_week,
      startTime: m.course_rooms.start_time,
      endTime: m.course_rooms.end_time,
      professor: m.course_rooms.professor,
      classroom: m.course_rooms.classroom,
      weeks: m.course_rooms.weeks,
      memberCount: m.course_rooms.member_count,
      semester: m.course_rooms.semester_id,
      joinedAt: m.joined_at,
    })) || []
    
    return c.json({ success: true, rooms })
  } catch (error: any) {
    console.error('Get rooms error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Get room details with members
// Query param: ?userId=xxx (current user, for determining contact visibility)
roomRoutes.get('/:roomId', async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const currentUserId = c.req.query('userId')
    
    // Get room info
    const { data: room, error: roomError } = await supabase
      .from('course_rooms')
      .select(`
        *,
        courses (
          id,
          name,
          code,
          school
        )
      `)
      .eq('id', roomId)
      .single()
    
    if (roomError) throw roomError
    if (!room) {
      return c.json({ success: false, error: 'Room not found' }, 404)
    }
    
    // Get members with auto_share_contact field
    const { data: members, error: membersError } = await supabase
      .from('room_members')
      .select(`
        joined_at,
        users (
          id,
          nickname,
          avatar_url,
          wechat,
          qq,
          auto_share_contact
        )
      `)
      .eq('room_id', roomId)
      .order('joined_at', { ascending: true })
    
    if (membersError) throw membersError
    
    // Get privacy settings for this room
    const { data: privacySettings } = await supabase
      .from('room_privacy_settings')
      .select('user_id, is_public')
      .eq('room_id', roomId)
    
    const privacyMap = new Map(privacySettings?.map(p => [p.user_id, p.is_public]) || [])
    
    // Get connections for current user (if provided)
    let connectionSet = new Set<string>()
    if (currentUserId) {
      const { data: connections } = await supabase
        .from('user_connections')
        .select('user_id_1, user_id_2')
        .or(`user_id_1.eq.${currentUserId},user_id_2.eq.${currentUserId}`)
      
      connections?.forEach(conn => {
        if (conn.user_id_1 === currentUserId) {
          connectionSet.add(conn.user_id_2)
        } else {
          connectionSet.add(conn.user_id_1)
        }
      })
      
      // Get pending contact requests from current user
      const { data: pendingRequests } = await supabase
        .from('contact_requests')
        .select('target_user_id, status')
        .eq('requester_id', currentUserId)
        .in('status', ['pending', 'accepted', 'rejected'])
    }
    
    // Get pending requests for visibility status
    let requestStatusMap = new Map<string, string>()
    if (currentUserId) {
      const { data: myRequests } = await supabase
        .from('contact_requests')
        .select('target_user_id, status, responded_at')
        .eq('requester_id', currentUserId)
      
      myRequests?.forEach(req => {
        // Check if rejected request is older than 1 hour (can re-request)
        if (req.status === 'rejected' && req.responded_at) {
          const rejectedAt = new Date(req.responded_at).getTime()
          const oneHourAgo = Date.now() - 60 * 60 * 1000
          if (rejectedAt < oneHourAgo) {
            // Can re-request, don't show rejected status
            return
          }
        }
        requestStatusMap.set(req.target_user_id, req.status)
      })
    }
    
    // Get other sections of the same course
    const { data: otherSections } = await supabase
      .from('course_rooms')
      .select('id, professor, day_of_week, start_time, member_count')
      .eq('course_id', room.course_id)
      .eq('semester_id', room.semester_id)
      .neq('id', roomId)
    
    // Determine contact visibility for each member
    const membersWithVisibility = members?.map(m => {
      const userId = m.users.id
      const isCurrentUser = userId === currentUserId
      const isConnected = connectionSet.has(userId)
      const hasAutoShare = m.users.auto_share_contact === true
      const roomPrivacy = privacyMap.get(userId)
      const isPublicInRoom = roomPrivacy === true
      const requestStatus = requestStatusMap.get(userId)
      
      // Contact is visible if:
      // 1. It's the current user themselves
      // 2. They are connected (friends)
      // 3. User has auto_share_contact enabled
      // 4. User has set this room to public
      const canSeeContact = isCurrentUser || isConnected || hasAutoShare || isPublicInRoom
      
      // Determine visibility status for UI
      let contactStatus: 'visible' | 'pending' | 'rejected' | 'hidden' = 'hidden'
      if (canSeeContact) {
        contactStatus = 'visible'
      } else if (requestStatus === 'pending') {
        contactStatus = 'pending'
      } else if (requestStatus === 'rejected') {
        contactStatus = 'rejected'
      }
      
      return {
        id: userId,
        nickname: m.users.nickname,
        avatar: m.users.avatar_url,
        wechat: canSeeContact ? m.users.wechat : null,
        qq: canSeeContact ? m.users.qq : null,
        joinedAt: m.joined_at,
        contactStatus,
        isConnected,
      }
    }) || []
    
    return c.json({
      success: true,
      room: {
        id: room.id,
        courseName: room.courses.name,
        courseCode: room.courses.code,
        school: room.courses.school,
        dayOfWeek: room.day_of_week,
        startTime: room.start_time,
        endTime: room.end_time,
        professor: room.professor,
        classroom: room.classroom,
        weeks: room.weeks,
        semester: room.semester_id,
        memberCount: room.member_count,
      },
      members: membersWithVisibility,
      otherSections: otherSections || [],
    })
  } catch (error: any) {
    console.error('Get room error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Set room privacy setting for current user
roomRoutes.post('/:roomId/privacy', async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const { userId, isPublic } = await c.req.json()
    
    if (!userId) {
      return c.json({ success: false, error: 'userId is required' }, 400)
    }
    
    // Upsert privacy setting
    const { error } = await supabase
      .from('room_privacy_settings')
      .upsert({
        room_id: roomId,
        user_id: userId,
        is_public: isPublic,
      }, {
        onConflict: 'room_id,user_id'
      })
    
    if (error) throw error
    
    return c.json({ success: true })
  } catch (error: any) {
    console.error('Set room privacy error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Check if user has set privacy for this room
roomRoutes.get('/:roomId/privacy/:userId', async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const userId = c.req.param('userId')
    
    const { data, error } = await supabase
      .from('room_privacy_settings')
      .select('is_public')
      .eq('room_id', roomId)
      .eq('user_id', userId)
      .single()
    
    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows returned, which is fine
      throw error
    }
    
    return c.json({
      success: true,
      hasSet: !!data,
      isPublic: data?.is_public ?? null,
    })
  } catch (error: any) {
    console.error('Get room privacy error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

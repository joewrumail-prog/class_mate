import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { getUserFromRequest, requireAccess, requireAuth } from '../middleware/auth.js'
import type { AppVariables } from '../types.js'

export const roomRoutes = new Hono<{ Variables: AppVariables }>()

const uuidSchema = z.string().uuid()
const joinByIndexSchema = z.object({
  index: z.string().min(1),
  year: z.number().int(),
  term: z.number().int(),
})

const getSemesterId = (year: number, term: number) =>
  `${year}-${term === 1 ? 'spring' : term === 7 ? 'fall' : term === 9 ? 'summer' : 'winter'}`

const getDayOfWeek = (meetingDay: string | null) => {
  if (!meetingDay) return 1
  const normalized = meetingDay.toUpperCase()
  if (normalized.includes('M')) return 1
  if (normalized.includes('T')) return 2
  if (normalized.includes('W')) return 3
  if (normalized.includes('H')) return 4
  if (normalized.includes('F')) return 5
  if (normalized.includes('S')) return 6
  return 7
}

const formatTime = (value: string | null) => {
  if (!value || value.length < 4) return null
  return `${value.slice(0, 2)}:${value.slice(2, 4)}`
}

const ensureUserProfile = async (user: { id: string; email?: string; email_confirmed_at?: string }) => {
  const { data: existingUser, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', user.id)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  if (existingUser) return

  const email = user.email || ''
  const nickname = email ? email.split('@')[0] : 'User'
  const isEdu = email.includes('.edu')

  const { error: createError } = await supabase
    .from('users')
    .insert({
      id: user.id,
      email,
      nickname,
      is_edu_email: isEdu,
      email_verified: !!user.email_confirmed_at,
      school: 'Rutgers University - New Brunswick',
    })

  if (createError) throw createError
}

// Get user's rooms
roomRoutes.get('/my/:userId', requireAuth, async (c) => {
  try {
    const userId = c.req.param('userId')

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
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
    
    const rooms = memberships?.map(m => {
      const courseRoom = Array.isArray(m.course_rooms) ? m.course_rooms[0] : m.course_rooms
      const course = Array.isArray(courseRoom?.courses) ? courseRoom?.courses?.[0] : courseRoom?.courses

      return {
        id: courseRoom?.id,
        courseName: course?.name,
        courseCode: course?.code,
        dayOfWeek: courseRoom?.day_of_week,
        startTime: courseRoom?.start_time,
        endTime: courseRoom?.end_time,
        professor: courseRoom?.professor,
        classroom: courseRoom?.classroom,
        weeks: courseRoom?.weeks,
        memberCount: courseRoom?.member_count,
        semester: courseRoom?.semester_id,
        joinedAt: m.joined_at,
      }
    }).filter(r => r.id) || []
    
    return c.json({ success: true, rooms })
  } catch (error: any) {
    console.error('Get rooms error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Join or create a room from Rutgers section index
roomRoutes.post('/join', requireAccess, async (c) => {
  try {
    const body = await c.req.json()
    const { index, year, term } = joinByIndexSchema.parse(body)

    const authUser = c.get('user') as { id: string }
    if (!authUser?.id) {
      return c.json({ success: false, error: 'Unauthorized' }, 401)
    }

    await ensureUserProfile(authUser)

    const { data: section, error: sectionError } = await supabase
      .from('rutgers_courses')
      .select('*')
      .eq('index', index)
      .eq('year', year)
      .eq('term', term)
      .single()

    if (sectionError || !section) {
      return c.json({ success: false, error: 'Section not found' }, 404)
    }

    const courseName = section.title || 'Untitled Course'
    const courseCode = section.course_string || null
    const school = 'Rutgers University - New Brunswick'
    const dayOfWeek = getDayOfWeek(section.meeting_day)
    const startTime = formatTime(section.start_time)
    const endTime = formatTime(section.end_time)
    const professor = section.instructor || ''
    const classroom = [section.building, section.room_number].filter(Boolean).join(' ').trim()
    const weeks = ''
    const semesterId = getSemesterId(year, term)

    if (!startTime || !endTime) {
      return c.json({ success: false, error: 'Section time is missing' }, 400)
    }

    let { data: existingCourse } = await supabase
      .from('courses')
      .select('id')
      .eq('name', courseName)
      .eq('school', school)
      .single()

    if (!existingCourse) {
      const { data: newCourse, error } = await supabase
        .from('courses')
        .insert({ name: courseName, school, code: courseCode })
        .select('id')
        .single()

      if (error) throw error
      existingCourse = newCourse
    }

    let { data: existingRoom } = await supabase
      .from('course_rooms')
      .select('id')
      .eq('course_id', existingCourse.id)
      .eq('semester_id', semesterId)
      .eq('day_of_week', dayOfWeek)
      .eq('start_time', startTime)
      .eq('end_time', endTime)
      .eq('professor', professor)
      .eq('classroom', classroom)
      .eq('weeks', weeks)
      .single()

    if (!existingRoom) {
      const { data: newRoom, error } = await supabase
        .from('course_rooms')
        .insert({
          course_id: existingCourse.id,
          semester_id: semesterId,
          day_of_week: dayOfWeek,
          start_time: startTime,
          end_time: endTime,
          professor,
          classroom,
          weeks,
          member_count: 0,
        })
        .select('id')
        .single()

      if (error) throw error
      existingRoom = newRoom
    }

    const { data: existingMember, error: existingMemberError } = await supabase
      .from('room_members')
      .select('id')
      .eq('room_id', existingRoom.id)
      .eq('user_id', authUser.id)
      .single()

    if (existingMemberError && existingMemberError.code !== 'PGRST116') {
      throw existingMemberError
    }

    if (!existingMember) {
      const { error: insertMemberError } = await supabase
        .from('room_members')
        .insert({ room_id: existingRoom.id, user_id: authUser.id })

      if (insertMemberError) throw insertMemberError
    }

    return c.json({
      success: true,
      roomId: existingRoom.id,
    })
  } catch (error: any) {
    console.error('Join room error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// Get room details with members
// Query param: ?userId=xxx (current user, for determining contact visibility)
roomRoutes.get('/:roomId', async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const parsedRoomId = uuidSchema.safeParse(roomId)
    if (!parsedRoomId.success) {
      return c.json({ success: false, error: 'Invalid roomId' }, 400)
    }
    const authUser = await getUserFromRequest(c)
    const currentUserId = authUser?.id
    
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
      const user = Array.isArray(m.users) ? m.users[0] : m.users
      const userId = user.id
      const isCurrentUser = userId === currentUserId
      const isConnected = connectionSet.has(userId)
      const hasAutoShare = user.auto_share_contact === true
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
        nickname: user.nickname,
        avatar: user.avatar_url,
        wechat: canSeeContact ? user.wechat : null,
        qq: canSeeContact ? user.qq : null,
        joinedAt: m.joined_at,
        contactStatus,
        isConnected,
      }
    }) || []
    
    return c.json({
      success: true,
      room: {
        id: room.id,
        courseName: Array.isArray(room.courses) ? room.courses?.[0]?.name : room.courses.name,
        courseCode: Array.isArray(room.courses) ? room.courses?.[0]?.code : room.courses.code,
        school: Array.isArray(room.courses) ? room.courses?.[0]?.school : room.courses.school,
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
roomRoutes.post('/:roomId/privacy', requireAuth, async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const parsedRoomId = uuidSchema.safeParse(roomId)
    if (!parsedRoomId.success) {
      return c.json({ success: false, error: 'Invalid roomId' }, 400)
    }
    const { userId, isPublic } = await c.req.json()

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
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
roomRoutes.get('/:roomId/privacy/:userId', requireAuth, async (c) => {
  try {
    const roomId = c.req.param('roomId')
    const parsedRoomId = uuidSchema.safeParse(roomId)
    if (!parsedRoomId.success) {
      return c.json({ success: false, error: 'Invalid roomId' }, 400)
    }
    const userId = c.req.param('userId')

    const authUser = c.get('user') as { id: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }
    
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

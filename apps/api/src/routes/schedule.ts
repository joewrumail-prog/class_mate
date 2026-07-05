import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAccess, requireAuth } from '../middleware/auth.js'
import type { AppVariables } from '../types.js'

export const scheduleRoutes = new Hono<{ Variables: AppVariables }>()

// Confirm and save courses
const confirmSchema = z.object({
  userId: z.string().uuid(),
  semester: z.string(),
  school: z.string(),
  courses: z.array(z.object({
    name: z.string(),
    day: z.number().min(1).max(7),
    startTime: z.string(),
    endTime: z.string(),
    classroom: z.string(),
    professor: z.string(),
    weeks: z.string(),
  })),
})

scheduleRoutes.post('/confirm', requireAccess, async (c) => {
  try {
    const body = await c.req.json()
    const { userId, semester, school, courses } = confirmSchema.parse(body)

    const authUser = c.get('user') as { id: string; email?: string; email_confirmed_at?: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }

    const { data: existingUser, error: existingUserError } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single()

    if (existingUserError && existingUserError.code !== 'PGRST116') {
      throw existingUserError
    }

    if (!existingUser) {
      const email = authUser?.email || ''
      const nickname = email ? email.split('@')[0] : 'User'
      const isEdu = email.includes('.edu')

      const { error: createUserError } = await supabase
        .from('users')
        .insert({
          id: userId,
          email,
          nickname,
          is_edu_email: isEdu,
          email_verified: !!authUser?.email_confirmed_at,
          school,
        })

      if (createUserError) throw createUserError
    }
    
    const results = {
      created: 0,
      joined: 0,
      rooms: [] as any[],
    }
    
    for (const course of courses) {
      // 1. Find or create the course
      let { data: existingCourse } = await supabase
        .from('courses')
        .select('id')
        .eq('name', course.name)
        .eq('school', school)
        .single()
      
      if (!existingCourse) {
        const { data: newCourse, error } = await supabase
          .from('courses')
          .insert({ name: course.name, school })
          .select('id')
          .single()
        
        if (error) throw error
        existingCourse = newCourse
      }
      
      // 2. Find or create the room
      let { data: existingRoom } = await supabase
        .from('course_rooms')
        .select('id, member_count')
        .eq('course_id', existingCourse.id)
        .eq('semester_id', semester)
        .eq('day_of_week', course.day)
        .eq('start_time', course.startTime)
        .eq('professor', course.professor)
        .eq('classroom', course.classroom)
        .eq('end_time', course.endTime)
        .eq('weeks', course.weeks || '')
        .single()
      
      if (!existingRoom) {
        const { data: newRoom, error } = await supabase
          .from('course_rooms')
          .insert({
            course_id: existingCourse.id,
            semester_id: semester,
            day_of_week: course.day,
            start_time: course.startTime,
            end_time: course.endTime,
            professor: course.professor,
            classroom: course.classroom,
            weeks: course.weeks || '',
            member_count: 0,
          })
          .select('id, member_count')
          .single()
        
        if (error) throw error
        existingRoom = newRoom
        results.created++
      }
      
      // 3. Add user to room (if not already a member)
      const { data: existingMember, error: existingMemberError } = await supabase
        .from('room_members')
        .select('id')
        .eq('room_id', existingRoom.id)
        .eq('user_id', userId)
        .single()

      if (existingMemberError && existingMemberError.code !== 'PGRST116') {
        throw existingMemberError
      }
      
      if (!existingMember) {
        const { error: insertMemberError } = await supabase
          .from('room_members')
          .insert({ room_id: existingRoom.id, user_id: userId })

        if (insertMemberError) throw insertMemberError
        
        results.joined++
        
        // 4. Notify existing room members about new member
        if (existingRoom.member_count > 0) {
          const { data: members } = await supabase
            .from('room_members')
            .select('user_id')
            .eq('room_id', existingRoom.id)
            .neq('user_id', userId)
          
          if (members && members.length > 0) {
            const notifications = members.map(m => ({
              user_id: m.user_id,
              type: 'new_member',
              title: '新课友加入',
              content: `有新同学加入了 ${course.name} 课程`,
              data: { room_id: existingRoom.id },
            }))
            
            await supabase.from('notifications').insert(notifications)
          }
        }
      }
      
      results.rooms.push({
        id: existingRoom.id,
        courseName: course.name,
        ...course,
      })
    }
    
    return c.json({ 
      success: true, 
      message: `成功加入 ${results.joined} 个课程 Room`,
      ...results,
    })
  } catch (error: any) {
    console.error('Confirm error:', error)
    return c.json({
      success: false,
      error: error.message || 'Failed to save schedule'
    }, 500)
  }
})

// Schedule overlap summary: who else is in my course rooms?
//
// PRIVACY (hard rule, from the product spec): classmate objects carry
// avatar + FIRST NAME (first whitespace-token of nickname) + counts +
// shared room list ONLY. No schedules, no contact info, no emails —
// connecting stays mutual opt-in via the existing contact-request flow.
scheduleRoutes.get('/overlap', requireAuth, async (c) => {
  try {
    const authUser = c.get('user') as { id: string }
    const userId = authUser.id

    // 1. My room memberships (imported courses), joined to course + code.
    //    Ordered by joined_at ascending so [0] is my first course.
    const { data: memberships, error: membershipsError } = await supabase
      .from('room_members')
      .select(`
        room_id,
        joined_at,
        course_rooms (
          id,
          courses (
            name,
            code
          )
        )
      `)
      .eq('user_id', userId)
      .order('joined_at', { ascending: true })

    if (membershipsError) throw membershipsError

    // Room id -> { courseName, courseCode } for my rooms.
    const myRooms = (memberships || []).map(m => {
      const courseRoom = Array.isArray(m.course_rooms) ? m.course_rooms[0] : m.course_rooms
      const course = Array.isArray(courseRoom?.courses) ? courseRoom?.courses?.[0] : courseRoom?.courses
      return {
        roomId: m.room_id as string,
        courseName: (course?.name as string) || '',
        courseCode: (course?.code as string | null) ?? null,
      }
    }).filter(r => r.roomId)

    const roomInfoById = new Map(myRooms.map(r => [r.roomId, r]))
    const roomIds = myRooms.map(r => r.roomId)

    const totalCourses = myRooms.length
    const firstCourseCode = myRooms.length > 0
      ? (myRooms[0].courseCode || myRooms[0].courseName || null)
      : null

    // 2. Other members of those rooms (nickname + avatar only).
    let otherMembers: { room_id: string; user_id: string; users: any }[] = []
    if (roomIds.length > 0) {
      const { data: others, error: othersError } = await supabase
        .from('room_members')
        .select(`
          room_id,
          user_id,
          users (
            nickname,
            avatar_url
          )
        `)
        .in('room_id', roomIds)
        .neq('user_id', userId)

      if (othersError) throw othersError
      otherMembers = (others || []) as typeof otherMembers
    }

    // 3. Aggregate per classmate: shared course count + shared room list.
    const roomsWithOthers = new Set<string>()
    const classmateById = new Map<string, {
      userId: string
      firstName: string
      avatarUrl: string | null
      sharedCourses: number
      rooms: { roomId: string; courseName: string; courseCode: string | null }[]
    }>()

    for (const member of otherMembers) {
      const room = roomInfoById.get(member.room_id)
      if (!room) continue

      roomsWithOthers.add(member.room_id)

      let classmate = classmateById.get(member.user_id)
      if (!classmate) {
        const profile = Array.isArray(member.users) ? member.users[0] : member.users
        const nickname = (profile?.nickname as string) || ''
        // First name only — never expose the full nickname/handle here.
        const firstName = nickname.trim().split(/\s+/)[0] || 'Classmate'
        classmate = {
          userId: member.user_id,
          firstName,
          avatarUrl: (profile?.avatar_url as string | null) ?? null,
          sharedCourses: 0,
          rooms: [],
        }
        classmateById.set(member.user_id, classmate)
      }

      if (!classmate.rooms.some(r => r.roomId === room.roomId)) {
        classmate.sharedCourses++
        classmate.rooms.push({
          roomId: room.roomId,
          courseName: room.courseName,
          courseCode: room.courseCode,
        })
      }
    }

    const classmates = Array.from(classmateById.values())
      .sort((a, b) => b.sharedCourses - a.sharedCourses)
      .slice(0, 20)

    // 4. My invite code — read-only, never minted here (see referral routes).
    const { data: profileRow, error: profileError } = await supabase
      .from('users')
      .select('invite_code')
      .eq('id', userId)
      .single()

    if (profileError && profileError.code !== 'PGRST116') {
      throw profileError
    }

    return c.json({
      success: true,
      totalCourses,
      overlappingCourses: roomsWithOthers.size,
      classmates,
      firstCourseCode,
      inviteCode: (profileRow?.invite_code as string | null) ?? null,
    })
  } catch (error: any) {
    console.error('Overlap error:', error)
    return c.json({
      success: false,
      error: error.message || 'Failed to compute schedule overlap',
    }, 500)
  }
})

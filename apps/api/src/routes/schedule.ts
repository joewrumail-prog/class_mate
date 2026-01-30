import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { parseScheduleImage } from '../lib/scheduleParser.js'
import { requireAccess } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { recordLlmCall } from '../lib/metrics.js'
import { consumeQuota } from '../lib/quota.js'
import type { AppVariables } from '../types.js'

export const scheduleRoutes = new Hono<{ Variables: AppVariables }>()

// Parse schedule image
const parseSchema = z.object({
  image: z.string(), // base64 image
  semester: z.string().optional().default('2025-spring'),
})

scheduleRoutes.post('/parse', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'llm' }), requireAccess, async (c) => {
  try {
    const body = await c.req.json()
    const { image, semester } = parseSchema.parse(body)

    const authUser = c.get('user') as { id: string; email?: string }
    const isEdu = (authUser?.email || '').toLowerCase().endsWith('.edu') || (authUser?.email || '').toLowerCase().endsWith('@rutgers.edu')
    await consumeQuota(authUser.id, isEdu)
    
    // Parse image with AI
    const start = Date.now()
    const courses = await parseScheduleImage(image)
    recordLlmCall(Date.now() - start)
    
    if (courses.length === 0) {
      return c.json({ 
        success: false, 
        error: 'No courses found in the image' 
      }, 400)
    }
    
    return c.json({ 
      success: true, 
      courses,
      semester,
    })
  } catch (error: any) {
    console.error('Parse error:', error)
    if (error?.message === 'Quota exceeded') {
      return c.json({ success: false, error: 'Daily upload quota reached. Try again tomorrow.' }, 429)
    }
    return c.json({ 
      success: false, 
      error: error.message || 'Failed to parse schedule' 
    }, 500)
  }
})

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

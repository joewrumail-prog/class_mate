import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { parseScheduleImage, ParsedCourse } from '../lib/openai'

export const scheduleRoutes = new Hono()

// Parse schedule image
const parseSchema = z.object({
  image: z.string(), // base64 image
  semester: z.string().optional().default('2025-spring'),
})

scheduleRoutes.post('/parse', async (c) => {
  try {
    const body = await c.req.json()
    const { image, semester } = parseSchema.parse(body)
    
    // Parse image with AI
    const courses = await parseScheduleImage(image)
    
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

scheduleRoutes.post('/confirm', async (c) => {
  try {
    const body = await c.req.json()
    const { userId, semester, school, courses } = confirmSchema.parse(body)
    
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
            weeks: course.weeks,
            member_count: 0,
          })
          .select('id, member_count')
          .single()
        
        if (error) throw error
        existingRoom = newRoom
        results.created++
      }
      
      // 3. Add user to room (if not already a member)
      const { data: existingMember } = await supabase
        .from('room_members')
        .select('id')
        .eq('room_id', existingRoom.id)
        .eq('user_id', userId)
        .single()
      
      if (!existingMember) {
        await supabase
          .from('room_members')
          .insert({ room_id: existingRoom.id, user_id: userId })
        
        // Update member count
        await supabase
          .from('course_rooms')
          .update({ member_count: existingRoom.member_count + 1 })
          .eq('id', existingRoom.id)
        
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

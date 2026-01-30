import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { requireAccess } from '../middleware/auth'
import { 
  fetchRutgersCourses, 
  parseCoursesToSections, 
  getCurrentSemesters,
  formatMilitaryTime,
  formatMeetingDay
} from '../lib/rutgers'

export const rutgersRoutes = new Hono()

const joinSchema = z.object({
  userId: z.string().uuid(),
  index: z.string(),
  year: z.number(),
  term: z.number(),
})

const dayMap: Record<string, number> = {
  M: 1,
  T: 2,
  W: 3,
  H: 4,
  F: 5,
  S: 6,
  U: 7,
}

function toTimeString(raw?: string | null): string {
  if (!raw) return ''
  if (raw.length >= 4) {
    return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`
  }
  return raw
}

function toSemesterId(year: number, term: number): string {
  return `${year}-${term === 1 ? 'spring' : term === 7 ? 'fall' : term === 9 ? 'summer' : 'winter'}`
}

/**
 * 获取当前和上一学期信息
 */
rutgersRoutes.get('/semesters', async (c) => {
  const semesters = getCurrentSemesters()
  return c.json({ success: true, ...semesters })
})

/**
 * 搜索课程（按 index 或关键词）
 */
rutgersRoutes.get('/search', async (c) => {
  try {
    const query = c.req.query('q') || ''
    const year = parseInt(c.req.query('year') || String(new Date().getFullYear()))
    const term = parseInt(c.req.query('term') || '1')
    const limit = parseInt(c.req.query('limit') || '20')
    
    const safeQuery = query.replace(/[^a-zA-Z0-9\s:-]/g, ' ').trim()

    if (!safeQuery || safeQuery.length < 2) {
      return c.json({ success: false, error: 'Query must be at least 2 characters' }, 400)
    }
    
    // 检查是否是 index 搜索（纯数字）
    const isIndexSearch = /^\d+$/.test(safeQuery)
    
    let results
    
    if (isIndexSearch) {
      // 按 index 精确搜索
      const { data, error } = await supabase
        .from('rutgers_courses')
        .select('*')
        .eq('year', year)
        .eq('term', term)
        .ilike('index', `${safeQuery}%`)
        .limit(limit)
      
      if (error) throw error
      results = data
    } else {
      // 按课程名或课程代码搜索
      const { data, error } = await supabase
        .from('rutgers_courses')
        .select('*')
        .eq('year', year)
        .eq('term', term)
        .or(`title.ilike.%${safeQuery}%,course_string.ilike.%${safeQuery}%,instructor.ilike.%${safeQuery}%`)
        .limit(limit)
      
      if (error) throw error
      results = data
    }
    
    const semesterId = `${year}-${term === 1 ? 'spring' : term === 7 ? 'fall' : term === 9 ? 'summer' : 'winter'}`
    const courseStrings = (results || [])
      .map(course => course.course_string)
      .filter(Boolean)

    const userCountByCode = new Map<string, number>()

    if (courseStrings.length > 0) {
      const { data: matchedCourses } = await supabase
        .from('courses')
        .select('id, code')
        .in('code', courseStrings)

      const courseIds = matchedCourses?.map(c => c.id) || []
      const courseIdByCode = new Map((matchedCourses || []).map(c => [c.code, c.id]))

      if (courseIds.length > 0) {
        const { data: rooms } = await supabase
          .from('course_rooms')
          .select('course_id, member_count')
          .eq('semester_id', semesterId)
          .in('course_id', courseIds)

        const countByCourseId = new Map<string, number>()
        rooms?.forEach(room => {
          const current = countByCourseId.get(room.course_id) || 0
          countByCourseId.set(room.course_id, current + (room.member_count || 0))
        })

        courseIdByCode.forEach((courseId, code) => {
          userCountByCode.set(code, countByCourseId.get(courseId) || 0)
        })
      }
    }

    const coursesWithUserCount = (results || []).map(course => {
      const userCount = course.course_string ? (userCountByCode.get(course.course_string) || 0) : 0
      return {
        ...course,
        formattedTime: course.start_time 
          ? `${formatMilitaryTime(course.start_time)} - ${formatMilitaryTime(course.end_time)}`
          : 'TBA',
        formattedDay: course.meeting_day ? formatMeetingDay(course.meeting_day) : 'TBA',
        userCount,
      }
    })
    
    return c.json({ 
      success: true, 
      courses: coursesWithUserCount,
      count: coursesWithUserCount.length,
    })
  } catch (error: any) {
    console.error('Search error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * Join course rooms from Rutgers course index
 */
rutgersRoutes.post('/join', requireAccess, async (c) => {
  try {
    const body = await c.req.json()
    const { userId, index, year, term } = joinSchema.parse(body)

    const authUser = c.get('user') as { id: string; email?: string; email_confirmed_at?: string }
    if (authUser?.id && userId !== authUser.id) {
      return c.json({ success: false, error: 'Forbidden' }, 403)
    }

    const { data: course, error } = await supabase
      .from('rutgers_courses')
      .select('*')
      .eq('index', index)
      .eq('year', year)
      .eq('term', term)
      .single()

    if (error || !course) {
      return c.json({ success: false, error: 'Course not found' }, 404)
    }

    const meetingDays = (course.meeting_day || '')
      .split('')
      .map(d => dayMap[d])
      .filter(Boolean)

    const startTime = toTimeString(course.start_time)
    const endTime = toTimeString(course.end_time)

    if (!startTime || !endTime || meetingDays.length === 0) {
      return c.json({ success: false, error: 'Course time is TBA or invalid' }, 400)
    }

    const semesterId = toSemesterId(year, term)
    const classroom = [course.building, course.room_number].filter(Boolean).join(' ').trim()
    const school = 'Rutgers University - New Brunswick'

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

    let { data: existingCourse } = await supabase
      .from('courses')
      .select('id, code')
      .eq('name', course.title)
      .eq('school', school)
      .single()

    if (!existingCourse) {
      const { data: newCourse, error: courseError } = await supabase
        .from('courses')
        .insert({ name: course.title, code: course.course_string, school })
        .select('id, code')
        .single()

      if (courseError) throw courseError
      existingCourse = newCourse
    } else if (!existingCourse.code && course.course_string) {
      await supabase
        .from('courses')
        .update({ code: course.course_string })
        .eq('id', existingCourse.id)
    }

    const results = {
      created: 0,
      joined: 0,
      rooms: [] as Array<{
        id: string
        courseName: string
        day: number
        startTime: string
        endTime: string
        professor: string
        classroom: string
      }>,
    }

    for (const day of meetingDays) {
      let { data: existingRoom } = await supabase
        .from('course_rooms')
        .select('id, member_count')
        .eq('course_id', existingCourse.id)
        .eq('semester_id', semesterId)
        .eq('day_of_week', day)
        .eq('start_time', startTime)
        .eq('end_time', endTime)
        .eq('professor', course.instructor || '')
        .eq('classroom', classroom)
        .eq('weeks', '')
        .single()

      if (!existingRoom) {
        const { data: newRoom, error: roomError } = await supabase
          .from('course_rooms')
          .insert({
            course_id: existingCourse.id,
            semester_id: semesterId,
            day_of_week: day,
            start_time: startTime,
            end_time: endTime,
            professor: course.instructor || '',
            classroom,
            weeks: '',
            member_count: 0,
          })
          .select('id, member_count')
          .single()

        if (roomError) throw roomError
        existingRoom = newRoom
        results.created++
      }

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
      }

      results.rooms.push({
        id: existingRoom.id,
        courseName: course.title,
        day,
        startTime,
        endTime,
        professor: course.instructor || '',
        classroom,
      })
    }

    return c.json({
      success: true,
      message: `Joined ${results.joined} room(s) for ${course.title}`,
      ...results,
    })
  } catch (error: any) {
    console.error('Join error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 同步 Rutgers 课程数据到本地数据库
 */
rutgersRoutes.post('/sync', requireAccess, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const year = body.year || new Date().getFullYear()
    const term = body.term || 1
    const campus = body.campus || 'NB'
    
    console.log(`Starting Rutgers sync: year=${year}, term=${term}, campus=${campus}`)
    
    // 从 Rutgers API 获取课程
    const courses = await fetchRutgersCourses(year, term, campus)
    console.log(`Fetched ${courses.length} courses from Rutgers`)
    
    // 解析为扁平化的 section 列表
    const sections = parseCoursesToSections(courses, year, term, campus)
    console.log(`Parsed ${sections.length} sections`)
    
    // 批量插入/更新到数据库
    const batchSize = 500
    let inserted = 0
    let updated = 0
    
    for (let i = 0; i < sections.length; i += batchSize) {
      const batch = sections.slice(i, i + batchSize)
      
      const { error } = await supabase
        .from('rutgers_courses')
        .upsert(
          batch.map(s => ({
            index: s.index,
            year: s.year,
            term: s.term,
            campus: s.campus,
            subject: s.subject,
            course_number: s.courseNumber,
            course_string: s.courseString,
            title: s.title,
            instructor: s.instructor,
            meeting_day: s.meetingDay,
            start_time: s.startTime,
            end_time: s.endTime,
            building: s.building,
            room_number: s.roomNumber,
            campus_name: s.campusName,
            open_status: s.openStatus,
            credits: s.credits,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: 'index,year,term' }
        )
      
      if (error) {
        console.error('Batch insert error:', error)
        throw error
      }
      
      inserted += batch.length
      console.log(`Processed ${inserted}/${sections.length} sections`)
    }
    
    return c.json({
      success: true,
      message: `Synced ${sections.length} sections from Rutgers`,
      stats: {
        coursesFromApi: courses.length,
        sectionsInserted: sections.length,
        year,
        term,
        campus,
      },
    })
  } catch (error: any) {
    console.error('Sync error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 获取同步状态
 */
rutgersRoutes.get('/sync-status', async (c) => {
  try {
    const { current, previous } = getCurrentSemesters()
    const yearParam = c.req.query('year')
    const termParam = c.req.query('term')
    const parsedYear = yearParam ? parseInt(yearParam) : NaN
    const parsedTerm = termParam ? parseInt(termParam) : NaN
    const target = Number.isNaN(parsedYear) || Number.isNaN(parsedTerm)
      ? current
      : { year: parsedYear, term: parsedTerm }
    
    // 检查当前学期的数据量
    const { count: currentCount } = await supabase
      .from('rutgers_courses')
      .select('*', { count: 'exact', head: true })
      .eq('year', target.year)
      .eq('term', target.term)
    
    // 检查上一学期的数据量
    const { count: previousCount } = await supabase
      .from('rutgers_courses')
      .select('*', { count: 'exact', head: true })
      .eq('year', previous.year)
      .eq('term', previous.term)
    
    // 获取最后更新时间
    const { data: lastUpdated } = await supabase
      .from('rutgers_courses')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()
    
    return c.json({
      success: true,
      current: {
        ...target,
        count: currentCount || 0,
      },
      previous: {
        ...previous,
        count: previousCount || 0,
      },
      lastUpdated: lastUpdated?.updated_at || null,
      needsSync: (currentCount || 0) === 0,
    })
  } catch (error: any) {
    console.error('Sync status error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

/**
 * 根据 index 获取课程详情
 */
rutgersRoutes.get('/course/:index', async (c) => {
  try {
    const index = c.req.param('index')
    const year = parseInt(c.req.query('year') || String(new Date().getFullYear()))
    const term = parseInt(c.req.query('term') || '1')
    
    const { data: course, error } = await supabase
      .from('rutgers_courses')
      .select('*')
      .eq('index', index)
      .eq('year', year)
      .eq('term', term)
      .single()
    
    if (error || !course) {
      return c.json({ success: false, error: 'Course not found' }, 404)
    }
    
    // 查找系统中已注册此课程的用户
    // 首先查找匹配的 course_room
    const { data: matchingRooms } = await supabase
      .from('course_rooms')
      .select(`
        id,
        member_count,
        courses (name, code)
      `)
      .ilike('classroom', `%${course.building}%`)
      .eq('semester_id', `${year}-${term === 1 ? 'spring' : term === 7 ? 'fall' : 'summer'}`)
    
    return c.json({
      success: true,
      course: {
        ...course,
        formattedTime: course.start_time 
          ? `${formatMilitaryTime(course.start_time)} - ${formatMilitaryTime(course.end_time)}`
          : 'TBA',
        formattedDay: course.meeting_day ? formatMeetingDay(course.meeting_day) : 'TBA',
      },
      relatedRooms: matchingRooms || [],
    })
  } catch (error: any) {
    console.error('Get course error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

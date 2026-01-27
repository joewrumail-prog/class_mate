import { Hono } from 'hono'
import { supabase } from '../lib/supabase'
import { 
  fetchRutgersCourses, 
  parseCoursesToSections, 
  getCurrentSemesters,
  formatMilitaryTime,
  formatMeetingDay,
  ParsedCourse 
} from '../lib/rutgers'

export const rutgersRoutes = new Hono()

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
    
    if (!query || query.length < 2) {
      return c.json({ success: false, error: 'Query must be at least 2 characters' }, 400)
    }
    
    // 检查是否是 index 搜索（纯数字）
    const isIndexSearch = /^\d+$/.test(query)
    
    let results
    
    if (isIndexSearch) {
      // 按 index 精确搜索
      const { data, error } = await supabase
        .from('rutgers_courses')
        .select('*')
        .eq('year', year)
        .eq('term', term)
        .ilike('index', `${query}%`)
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
        .or(`title.ilike.%${query}%,course_string.ilike.%${query}%,instructor.ilike.%${query}%`)
        .limit(limit)
      
      if (error) throw error
      results = data
    }
    
    // 获取每门课在系统中的用户数
    const coursesWithUserCount = await Promise.all(
      (results || []).map(async (course) => {
        // 查找对应的 course_room
        const { data: rooms } = await supabase
          .from('course_rooms')
          .select('id, member_count')
          .eq('semester_id', `${year}-${term === 1 ? 'spring' : term === 7 ? 'fall' : term === 9 ? 'summer' : 'winter'}`)
          .ilike('start_time', `${course.start_time?.slice(0, 2)}%`)
        
        const userCount = rooms?.reduce((sum, r) => sum + (r.member_count || 0), 0) || 0
        
        return {
          ...course,
          formattedTime: course.start_time 
            ? `${formatMilitaryTime(course.start_time)} - ${formatMilitaryTime(course.end_time)}`
            : 'TBA',
          formattedDay: course.meeting_day ? formatMeetingDay(course.meeting_day) : 'TBA',
          userCount,
        }
      })
    )
    
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
 * 同步 Rutgers 课程数据到本地数据库
 */
rutgersRoutes.post('/sync', async (c) => {
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
    
    // 检查当前学期的数据量
    const { count: currentCount } = await supabase
      .from('rutgers_courses')
      .select('*', { count: 'exact', head: true })
      .eq('year', current.year)
      .eq('term', current.term)
    
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
        ...current,
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

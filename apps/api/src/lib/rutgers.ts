/**
 * Rutgers Schedule of Classes API 封装
 * API 文档: https://sis.rutgers.edu/soc/
 */

// Rutgers API 基础 URL
const RUTGERS_API_BASE = 'https://classes.rutgers.edu/soc/api'

// 学期编码
export const TERM_CODES = {
  SPRING: 1,
  SUMMER: 9,
  FALL: 7,
  WINTER: 0,
} as const

export interface RutgersMeetingTime {
  meetingDay: string  // M, T, W, H, F
  startTime: string   // 军事时间格式 e.g., "0200"
  endTime: string
  buildingCode: string
  roomNumber: string
  campusName: string
  meetingModeDesc: string
}

export interface RutgersInstructor {
  name: string
}

export interface RutgersSection {
  index: string           // 课程索引 e.g., "10364"
  number: string          // section 号
  instructors: RutgersInstructor[]
  instructorsText: string
  meetingTimes: RutgersMeetingTime[]
  openStatus: boolean
  comments: { code: string; description: string }[]
  commentsText: string
}

export interface RutgersCourse {
  subject: string           // e.g., "198"
  courseNumber: string      // e.g., "111"
  courseString: string      // e.g., "01:198:111"
  title: string
  expandedTitle: string
  credits: number
  subjectDescription: string
  sections: RutgersSection[]
  school: { code: string; description: string }
}

export interface ParsedCourse {
  index: string
  year: number
  term: number
  campus: string
  subject: string
  courseNumber: string
  courseString: string
  title: string
  instructor: string
  meetingDay: string
  startTime: string
  endTime: string
  building: string
  roomNumber: string
  campusName: string
  openStatus: boolean
  credits: string
}

/**
 * 获取当前学期和上一学期
 */
export function getCurrentSemesters(): { current: { year: number; term: number; label: string }; previous: { year: number; term: number; label: string } } {
  const now = new Date()
  const month = now.getMonth() + 1  // 1-12
  const year = now.getFullYear()
  
  let current: { year: number; term: number; label: string }
  let previous: { year: number; term: number; label: string }
  
  if (month >= 1 && month <= 5) {
    // Spring: Jan - May
    current = { year, term: TERM_CODES.SPRING, label: `${year} Spring` }
    previous = { year: year - 1, term: TERM_CODES.FALL, label: `${year - 1} Fall` }
  } else if (month >= 6 && month <= 8) {
    // Summer: Jun - Aug
    current = { year, term: TERM_CODES.SUMMER, label: `${year} Summer` }
    previous = { year, term: TERM_CODES.SPRING, label: `${year} Spring` }
  } else {
    // Fall: Sep - Dec
    current = { year, term: TERM_CODES.FALL, label: `${year} Fall` }
    previous = { year, term: TERM_CODES.SUMMER, label: `${year} Summer` }
  }
  
  return { current, previous }
}

/**
 * 从 Rutgers API 获取所有课程
 */
export async function fetchRutgersCourses(
  year: number,
  term: number,
  campus: string = 'NB'
): Promise<RutgersCourse[]> {
  const url = `${RUTGERS_API_BASE}/courses.json?year=${year}&term=${term}&campus=${campus}`
  
  console.log(`Fetching Rutgers courses: ${url}`)
  
  const response = await fetch(url, {
    headers: {
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'ClassMate/1.0',
    },
  })
  
  if (!response.ok) {
    throw new Error(`Failed to fetch Rutgers courses: ${response.status}`)
  }
  
  const data = await response.json()
  return data as RutgersCourse[]
}

/**
 * 解析 Rutgers 课程数据为扁平化的 section 列表
 */
export function parseCoursesToSections(
  courses: RutgersCourse[],
  year: number,
  term: number,
  campus: string = 'NB'
): ParsedCourse[] {
  const sections: ParsedCourse[] = []
  
  for (const course of courses) {
    for (const section of course.sections) {
      // 获取第一个上课时间（如果有多个，合并 meetingDay）
      const meetingDays: string[] = []
      let startTime = ''
      let endTime = ''
      let building = ''
      let roomNumber = ''
      let campusName = ''
      
      for (const mt of section.meetingTimes) {
        if (mt.meetingDay) {
          meetingDays.push(mt.meetingDay)
        }
        if (!startTime && mt.startTime) {
          startTime = mt.startTime
          endTime = mt.endTime
          building = mt.buildingCode
          roomNumber = mt.roomNumber
          campusName = mt.campusName
        }
      }
      
      sections.push({
        index: section.index,
        year,
        term,
        campus,
        subject: course.subject,
        courseNumber: course.courseNumber,
        courseString: course.courseString,
        title: course.title,
        instructor: section.instructorsText || '',
        meetingDay: meetingDays.join(''),
        startTime,
        endTime,
        building,
        roomNumber,
        campusName,
        openStatus: section.openStatus,
        credits: String(course.credits || ''),
      })
    }
  }
  
  return sections
}

/**
 * 格式化军事时间为可读格式
 */
export function formatMilitaryTime(time: string): string {
  if (!time || time.length < 4) return time
  
  const hours = parseInt(time.slice(0, 2), 10)
  const minutes = time.slice(2, 4)
  
  if (hours === 0) {
    return `12:${minutes} AM`
  } else if (hours < 12) {
    return `${hours}:${minutes} AM`
  } else if (hours === 12) {
    return `12:${minutes} PM`
  } else {
    return `${hours - 12}:${minutes} PM`
  }
}

/**
 * 格式化上课日期
 */
export function formatMeetingDay(day: string): string {
  const dayMap: Record<string, string> = {
    'M': 'Mon',
    'T': 'Tue',
    'W': 'Wed',
    'H': 'Thu',
    'F': 'Fri',
    'S': 'Sat',
    'U': 'Sun',
  }
  
  return day.split('').map(d => dayMap[d] || d).join('/')
}

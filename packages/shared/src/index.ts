// User types
export interface User {
  id: string
  email: string
  email_verified: boolean
  is_edu_email: boolean
  nickname: string
  avatar_url?: string
  wechat?: string
  qq?: string
  school?: string
  match_quota_remaining: number
  match_quota_reset_at?: string
  created_at: string
  updated_at: string
}

// Course types
export interface Course {
  id: string
  name: string
  code?: string
  school: string
  created_at: string
}

// Room types
export interface CourseRoom {
  id: string
  course_id: string
  semester_id: string
  day_of_week: number
  start_time: string
  end_time: string
  professor: string
  classroom: string
  weeks: string
  member_count: number
  created_at: string
}

export interface RoomWithCourse extends CourseRoom {
  courseName: string
  courseCode?: string
}

export interface RoomMember {
  id: string
  nickname: string
  avatar?: string
  wechat?: string
  qq?: string
  joinedAt: string
}

export interface RoomDetail extends RoomWithCourse {
  school: string
  members: RoomMember[]
  otherSections: {
    id: string
    professor: string
    dayOfWeek: number
    startTime: string
    memberCount: number
  }[]
}

// Schedule parsing types
export interface ParsedCourse {
  name: string
  day: number
  startTime: string
  endTime: string
  classroom: string
  professor: string
  weeks: string
}

// Notification types
export interface Notification {
  id: string
  user_id: string
  type: 'new_member' | 'match_found' | 'system'
  title: string
  content: string
  data: Record<string, any>
  is_read: boolean
  created_at: string
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

// Semester types
export interface Semester {
  id: string
  name: string
  start_date?: string
  end_date?: string
  is_active: boolean
}

// Utility types
export type DayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7

export const DAY_NAMES: Record<DayOfWeek, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
}

export const DAY_NAMES_EN: Record<DayOfWeek, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
}

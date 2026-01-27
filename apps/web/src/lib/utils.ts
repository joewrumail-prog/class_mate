import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Check if email is an edu email
 */
export function isEduEmail(email: string): boolean {
  const eduPatterns = [
    /\.edu$/i,
    /\.edu\.[a-z]{2}$/i,  // .edu.cn, .edu.hk, etc.
    /\.ac\.[a-z]{2}$/i,   // .ac.uk, .ac.jp, etc.
  ]
  return eduPatterns.some(pattern => pattern.test(email))
}

/**
 * Format day of week
 */
export function formatDayOfWeek(day: number): string {
  const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
  return days[day] || ''
}

/**
 * Format time range
 */
export function formatTimeRange(start: string, end: string): string {
  return `${start.slice(0, 5)} - ${end.slice(0, 5)}`
}

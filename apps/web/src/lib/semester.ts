// Rutgers term codes: 1=Spring, 7=Fall, 0=Winter, 9=Summer

export interface SemesterInfo {
  year: number
  term: number
  termName: string
  id: string // e.g. "2025-spring"
  display: string // e.g. "Spring 2025"
}

/**
 * Get Rutgers term code from month
 * Jan-May: Spring (1)
 * Jun-Jul: Summer (9)
 * Aug-Dec: Fall (7)
 * Winter (0) is typically Jan session, but we'll treat it as part of Spring
 */
function getTermFromMonth(month: number): { term: number; termName: string } {
  if (month >= 0 && month <= 4) {
    return { term: 1, termName: 'Spring' }
  } else if (month >= 5 && month <= 6) {
    return { term: 9, termName: 'Summer' }
  } else {
    return { term: 7, termName: 'Fall' }
  }
}

/**
 * Get the current semester based on today's date
 */
export function getCurrentSemester(): SemesterInfo {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() // 0-indexed
  
  const { term, termName } = getTermFromMonth(month)
  
  return {
    year,
    term,
    termName,
    id: `${year}-${termName.toLowerCase()}`,
    display: `${termName} ${year}`,
  }
}

/**
 * Get the previous semester
 */
export function getPreviousSemester(): SemesterInfo {
  const current = getCurrentSemester()
  
  // Spring -> previous Fall (year - 1)
  // Summer -> Spring (same year)
  // Fall -> Summer (same year)
  
  if (current.term === 1) {
    // Spring -> Fall of previous year
    return {
      year: current.year - 1,
      term: 7,
      termName: 'Fall',
      id: `${current.year - 1}-fall`,
      display: `Fall ${current.year - 1}`,
    }
  } else if (current.term === 9) {
    // Summer -> Spring of same year
    return {
      year: current.year,
      term: 1,
      termName: 'Spring',
      id: `${current.year}-spring`,
      display: `Spring ${current.year}`,
    }
  } else {
    // Fall -> Summer of same year
    return {
      year: current.year,
      term: 9,
      termName: 'Summer',
      id: `${current.year}-summer`,
      display: `Summer ${current.year}`,
    }
  }
}

/**
 * Get available semesters for selection (current + previous)
 */
export function getAvailableSemesters(): SemesterInfo[] {
  return [getCurrentSemester(), getPreviousSemester()]
}

/**
 * Format semester ID to display name
 */
export function formatSemesterId(semesterId: string): string {
  const [year, term] = semesterId.split('-')
  const termDisplay = term.charAt(0).toUpperCase() + term.slice(1)
  return `${termDisplay} ${year}`
}

/**
 * Parse semester ID to year and term code
 */
export function parseSemesterId(semesterId: string): { year: number; term: number } | null {
  const parts = semesterId.split('-')
  if (parts.length !== 2) return null
  
  const year = parseInt(parts[0])
  const termName = parts[1].toLowerCase()
  
  const termMap: Record<string, number> = {
    spring: 1,
    fall: 7,
    summer: 9,
    winter: 0,
  }
  
  const term = termMap[termName]
  if (!year || term === undefined) return null
  
  return { year, term }
}

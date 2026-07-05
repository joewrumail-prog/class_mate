/**
 * School themes. Setting `data-school` on <html> re-skins every `--brand-*`
 * token (see index.css). Colors are each school's documented signature hue;
 * crest monograms are generic shields, NOT official university marks
 * (licensing required before swapping real logos in).
 */
export interface School {
  id: string
  name: string
  campus: string
  mono: string
  color: string
  colorName: string
  domain: string
}

export const SCHOOLS: School[] = [
  { id: 'rutgers', name: 'Rutgers University', campus: 'New Brunswick, NJ', mono: 'R', color: '#CC0033', colorName: 'Scarlet', domain: 'rutgers.edu' },
  { id: 'princeton', name: 'Princeton University', campus: 'Princeton, NJ', mono: 'P', color: '#E77500', colorName: 'Orange', domain: 'princeton.edu' },
  { id: 'pennstate', name: 'Penn State', campus: 'University Park, PA', mono: 'PS', color: '#1E407C', colorName: 'Nittany Navy', domain: 'psu.edu' },
  { id: 'michigan', name: 'University of Michigan', campus: 'Ann Arbor, MI', mono: 'M', color: '#00274C', colorName: 'Blue', domain: 'umich.edu' },
  { id: 'nyu', name: 'New York University', campus: 'New York, NY', mono: 'N', color: '#57068C', colorName: 'Violet', domain: 'nyu.edu' },
  { id: 'osu', name: 'Ohio State University', campus: 'Columbus, OH', mono: 'O', color: '#BB0000', colorName: 'Scarlet', domain: 'osu.edu' },
  { id: 'unnc', name: 'University of Nottingham Ningbo China', campus: 'Ningbo, China', mono: 'UNNC', color: '#003C71', colorName: 'Nottingham Blue', domain: 'nottingham.edu.cn' },
]

export const findSchool = (id?: string | null): School | null =>
  SCHOOLS.find((s) => s.id === id) || null

/** Best-effort mapping from the free-text `users.school` column. */
export function inferSchoolId(schoolName?: string | null): string | null {
  if (!schoolName) return null
  const lower = schoolName.toLowerCase()
  for (const s of SCHOOLS) {
    if (lower.includes(s.id) || lower.includes(s.name.toLowerCase())) return s.id
  }
  if (lower.includes('rutgers')) return 'rutgers'
  return null
}

/** Apply / clear the school theme on <html>. */
export function applySchoolTheme(id: string | null) {
  if (id && findSchool(id)) {
    document.documentElement.setAttribute('data-school', id)
  } else {
    document.documentElement.removeAttribute('data-school')
  }
}

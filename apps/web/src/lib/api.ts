import { supabase } from '@/lib/supabase'

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const authHeaders = await getAuthHeaders()
  const headers = new Headers(init.headers || {})
  Object.entries(authHeaders).forEach(([key, value]) => {
    headers.set(key, value)
  })

  return fetch(input, { ...init, headers })
}

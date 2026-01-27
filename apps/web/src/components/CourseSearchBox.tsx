import { useState, useEffect, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useNavigate } from 'react-router-dom'
import { parseSemesterId } from '@/lib/semester'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface SearchResult {
  index: string
  course_string: string
  title: string
  instructor: string
  formattedTime: string
  formattedDay: string
  campus_name: string
  userCount: number
  roomId?: string
}

interface CourseSearchBoxProps {
  semester: string
}

export function CourseSearchBox({ semester }: CourseSearchBoxProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [syncNeeded, setSyncNeeded] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Check if data exists
  useEffect(() => {
    const checkData = async () => {
      try {
        const res = await fetch(`${API_URL}/api/rutgers/sync-status`)
        const data = await res.json()
        if (data.success && data.needsSync) {
          setSyncNeeded(true)
        }
      } catch (err) {
        console.error('Failed to check sync status:', err)
      }
    }
    checkData()
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const parsed = parseSemesterId(semester)
      if (!parsed) return

      const res = await fetch(`${API_URL}/api/rutgers/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: parsed.year,
          term: parsed.term,
          campus: 'NB',
        }),
      })
      const data = await res.json()
      if (data.success) {
        setSyncNeeded(false)
      }
    } catch (err) {
      console.error('Sync failed:', err)
    } finally {
      setSyncing(false)
    }
  }

  const search = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) {
      setResults([])
      return
    }

    setLoading(true)
    try {
      const parsed = parseSemesterId(semester)
      if (!parsed) return

      const res = await fetch(
        `${API_URL}/api/rutgers/search?q=${encodeURIComponent(q)}&year=${parsed.year}&term=${parsed.term}&limit=15`
      )
      const data = await res.json()
      if (data.success) {
        setResults(data.courses || [])
      }
    } catch (err) {
      console.error('Search error:', err)
    } finally {
      setLoading(false)
    }
  }, [semester])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      search(query)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, search])

  const handleSelect = (result: SearchResult) => {
    if (result.roomId) {
      navigate(`/room/${result.roomId}`)
    } else {
      // For now, just log - in future could create room or show details
      console.log('Selected course:', result)
    }
    setShowResults(false)
    setQuery('')
  }

  return (
    <div className="relative w-full max-w-xl">
      {syncNeeded && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
          <p className="text-amber-800 mb-2">
            Course data needs to be synced from Rutgers.
          </p>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-amber-700 underline hover:no-underline"
          >
            {syncing ? 'Syncing...' : 'Click here to sync now'}
          </button>
        </div>
      )}

      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <Input
          type="text"
          placeholder="Search by course code (01:198:111) or index (12345)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShowResults(true)
          }}
          onFocus={() => setShowResults(true)}
          className="pl-10"
        />
      </div>

      {showResults && (query.length >= 2 || results.length > 0) && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg max-h-96 overflow-y-auto z-50">
          {loading ? (
            <div className="p-4 space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : results.length > 0 ? (
            <ul>
              {results.map((result, idx) => (
                <li
                  key={`${result.index}-${idx}`}
                  className="px-4 py-3 hover:bg-accent cursor-pointer border-b last:border-b-0"
                  onClick={() => handleSelect(result)}
                >
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {result.course_string}
                      </p>
                      <p className="text-sm text-muted-foreground truncate">
                        {result.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {result.instructor || 'TBA'} | {result.formattedDay} {result.formattedTime}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded font-mono">
                        {result.index}
                      </span>
                      {result.userCount > 0 && (
                        <p className="text-xs text-green-600 mt-1">
                          {result.userCount} in ClassMate
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : query.length >= 2 ? (
            <div className="p-4 text-center text-muted-foreground">
              <p>No courses found for "{query}"</p>
              {syncNeeded && (
                <p className="text-xs mt-1">Try syncing course data first</p>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* Click outside to close */}
      {showResults && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowResults(false)}
        />
      )}
    </div>
  )
}

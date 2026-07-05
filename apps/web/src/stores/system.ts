import { create } from 'zustand'
import { authFetch } from '@/lib/api'
import type { LevelInfo } from '@/lib/xp'

export interface Quest {
  id: string
  kind: 'daily' | 'main' | 'side'
  source: 'schedule' | 'manual' | 'system'
  title: string
  xp: number
  quest_date: string | null
  due_at: string | null
  done_at: string | null
  meta: Record<string, any>
}

export interface SystemToast {
  id: number
  text: string
}

interface SystemState {
  xp: LevelInfo | null
  weeklyXp: number
  streak: number
  daily: Quest[]
  side: Quest[]
  main: Quest[]
  loaded: boolean
  showLevelUp: boolean
  levelUpTo: number
  toasts: SystemToast[]
  fetchSummary: () => Promise<void>
  fetchQuests: () => Promise<void>
  toggleQuest: (id: string) => Promise<void>
  checkin: (kind?: 'morning' | 'evening') => Promise<void>
  startSession: (roomId: string) => Promise<void>
  pushToast: (text: string) => void
  closeLevelUp: () => void
}

let toastSeq = 1

export const useSystemStore = create<SystemState>((set, get) => ({
  xp: null,
  weeklyXp: 0,
  streak: 0,
  daily: [],
  side: [],
  main: [],
  loaded: false,
  showLevelUp: false,
  levelUpTo: 0,
  toasts: [],

  pushToast: (text) => {
    const id = toastSeq++
    set((s) => ({ toasts: [...s.toasts, { id, text }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2600)
  },

  closeLevelUp: () => set({ showLevelUp: false }),

  fetchSummary: async () => {
    try {
      const res = await authFetch('/api/system/summary')
      const data = await res.json()
      if (data.success) {
        set({ xp: data.xp, weeklyXp: data.weeklyXp, streak: data.streak })
      }
    } catch (err) {
      console.error('fetchSummary failed:', err)
    }
  },

  fetchQuests: async () => {
    try {
      const res = await authFetch('/api/system/quests')
      const data = await res.json()
      if (data.success) {
        set({ daily: data.daily || [], side: data.side || [], main: data.main || [], loaded: true })
      }
    } catch (err) {
      console.error('fetchQuests failed:', err)
    }
  },

  // Acceptance test (DEPLOY-FIXES §7): checking a quest writes an xp_events
  // row server-side and the header pill updates from the returned totals.
  toggleQuest: async (id) => {
    const { daily, side, main, pushToast, xp } = get()
    const all = [...daily, ...side, ...main]
    const quest = all.find((q) => q.id === id)
    if (!quest) return

    const markingDone = !quest.done_at
    const patch = (list: Quest[]) =>
      list.map((q) => (q.id === id ? { ...q, done_at: markingDone ? new Date().toISOString() : null } : q))

    // Optimistic flip
    set((s) => ({ daily: patch(s.daily), side: patch(s.side), main: patch(s.main) }))

    try {
      const res = await authFetch(`/api/system/quests/${id}/toggle`, { method: 'POST' })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Toggle failed')

      set({ xp: data.xp })
      if (markingDone) {
        pushToast(data.bonusApplied ? `+${quest.xp} XP · all quests cleared, +30 bonus` : `+${quest.xp} XP`)
      }
      if (data.leveledUp) {
        set({ showLevelUp: true, levelUpTo: data.xp.level })
      }
    } catch (err: any) {
      // Revert on failure
      set((s) => ({
        daily: s.daily.map((q) => (q.id === id ? { ...q, done_at: quest.done_at } : q)),
        side: s.side.map((q) => (q.id === id ? { ...q, done_at: quest.done_at } : q)),
        main: s.main.map((q) => (q.id === id ? { ...q, done_at: quest.done_at } : q)),
        xp,
      }))
      pushToast(err.message || 'Could not update quest')
    }
  },

  checkin: async (kind = 'evening') => {
    const { pushToast } = get()
    try {
      const res = await authFetch('/api/system/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const data = await res.json()
      if (!data.success) {
        pushToast(data.error === 'Already checked in' ? 'Already checked in today' : data.error)
        return
      }
      set({ xp: data.xp })
      pushToast(`Check-in logged · +${data.awardedXp} XP`)
    } catch {
      pushToast('Check-in failed')
    }
  },

  startSession: async (roomId) => {
    const { pushToast } = get()
    try {
      const res = await authFetch('/api/system/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      })
      const data = await res.json()
      if (!data.success) {
        pushToast(data.error || 'Could not start session')
        return
      }
      set({ xp: data.xp })
      pushToast('Study session started · +25 XP each')
    } catch {
      pushToast('Could not start session')
    }
  },
}))

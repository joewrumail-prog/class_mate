import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppVariables } from '../types.js'

// ============================================================================
// GRADE DATA POLICY (NEXT-STEPS P0 #2):
// GPA projection is computed CLIENT-SIDE (apps/web/src/lib/gpa.ts). The server
// stores ONLY course weight schemes + user-set letter-grade goals.
//
// NO ENDPOINT IN THIS MODULE ACCEPTS SCORES — no Canvas scores, no
// per-assignment grades, no points earned/possible, no current percentages.
// Do not add one. Scores live in localStorage on the student's device;
// "your grades never leave your device" is a trust selling point and storing
// them is FERPA-adjacent liability.
// ============================================================================

export const gradesRoutes = new Hono<{ Variables: AppVariables }>()

const roomIdSchema = z.string().uuid()

const weightsSchema = z.object({
  components: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        weight: z.number().min(0).max(100),
      })
    )
    .min(1)
    .max(30),
  source: z.enum(['syllabus', 'canvas', 'manual']),
})

const goalSchema = z.object({
  target_letter: z.enum(['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F']),
})

async function isRoomMember(userId: string, roomId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('room_members')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .limit(1)
  if (error) throw error
  return !!data && data.length > 0
}

const errorStatus = (error: unknown) => (error instanceof z.ZodError ? 400 : 500)

// ------------------------------------------------------------- weights: read
// Room members see the room's confirmed weight scheme (or null if nobody has
// confirmed one yet — the client deep-links to Import → Syllabus).
gradesRoutes.get('/weights/:roomId', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const roomId = roomIdSchema.parse(c.req.param('roomId'))

    if (!(await isRoomMember(user.id, roomId))) {
      return c.json({ success: false, error: 'Not a member of this room' }, 403)
    }

    const { data, error } = await supabase
      .from('course_weights')
      .select('*')
      .eq('room_id', roomId)
      .maybeSingle()
    if (error) throw error

    return c.json({ success: true, weights: data || null })
  } catch (error: any) {
    console.error('Get weights error:', error)
    return c.json({ success: false, error: error.message }, errorStatus(error))
  }
})

// ---------------------------------------------------------- weights: confirm
// README v2 (Import → Syllabus): "one classmate confirming shares it with the
// room" — confirming always sets confirmed_by = the caller and shared = true.
gradesRoutes.put('/weights/:roomId', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const roomId = roomIdSchema.parse(c.req.param('roomId'))
    const { components, source } = weightsSchema.parse(await c.req.json())

    if (!(await isRoomMember(user.id, roomId))) {
      return c.json({ success: false, error: 'Not a member of this room' }, 403)
    }

    const { data, error } = await supabase
      .from('course_weights')
      .upsert(
        {
          room_id: roomId,
          components,
          source,
          confirmed_by: user.id,
          shared: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'room_id' }
      )
      .select()
      .single()
    if (error) throw error

    return c.json({ success: true, weights: data })
  } catch (error: any) {
    console.error('Put weights error:', error)
    return c.json({ success: false, error: error.message }, errorStatus(error))
  }
})

// ---------------------------------------------------------------- goal: read
// Goals are owner-only — never social, never shared with the room.
gradesRoutes.get('/goal/:roomId', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const roomId = roomIdSchema.parse(c.req.param('roomId'))

    if (!(await isRoomMember(user.id, roomId))) {
      return c.json({ success: false, error: 'Not a member of this room' }, 403)
    }

    const { data, error } = await supabase
      .from('grade_goals')
      .select('*')
      .eq('user_id', user.id)
      .eq('room_id', roomId)
      .maybeSingle()
    if (error) throw error

    return c.json({ success: true, goal: data || null })
  } catch (error: any) {
    console.error('Get goal error:', error)
    return c.json({ success: false, error: error.message }, errorStatus(error))
  }
})

// ----------------------------------------------------------------- goal: set
gradesRoutes.put('/goal/:roomId', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const roomId = roomIdSchema.parse(c.req.param('roomId'))
    const { target_letter } = goalSchema.parse(await c.req.json())

    if (!(await isRoomMember(user.id, roomId))) {
      return c.json({ success: false, error: 'Not a member of this room' }, 403)
    }

    const { data, error } = await supabase
      .from('grade_goals')
      .upsert(
        {
          user_id: user.id,
          room_id: roomId,
          target_letter,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,room_id' }
      )
      .select()
      .single()
    if (error) throw error

    return c.json({ success: true, goal: data })
  } catch (error: any) {
    console.error('Put goal error:', error)
    return c.json({ success: false, error: error.message }, errorStatus(error))
  }
})

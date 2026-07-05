import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { parseScheduleImage } from '../lib/scheduleParser.js'
import { requireAccess } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { consumeQuota } from '../lib/quota.js'
import type { AppVariables } from '../types.js'

export const importRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * OCR import flow (DEPLOY-FIXES §5).
 *
 * The client uploads the screenshot/PDF render DIRECTLY to the private
 * Supabase Storage bucket `schedules/` (per-user folder enforced by storage
 * RLS), then posts only `{ path }` here. The API (service role) downloads the
 * file, runs the vision model, and returns parsed courses. Base64 images
 * never travel through the API — Vercel caps request bodies at ~4.5 MB.
 */
const parseSchema = z.object({
  path: z.string().min(3),
  semester: z.string().optional().default('2025-spring'),
})

importRoutes.post('/parse', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'llm' }), requireAccess, async (c) => {
  try {
    const body = await c.req.json()
    const { path, semester } = parseSchema.parse(body)

    const authUser = c.get('user') as { id: string; email?: string }
    const email = (authUser?.email || '').toLowerCase()
    const isEdu = email.endsWith('.edu') || email.endsWith('@rutgers.edu')

    // Users may only parse files inside their own storage folder.
    if (!path.startsWith(`${authUser.id}/`)) {
      return c.json({ success: false, error: 'Forbidden path' }, 403)
    }

    await consumeQuota(authUser.id, isEdu)

    const { data: file, error: downloadError } = await supabase.storage
      .from('schedules')
      .download(path)

    if (downloadError || !file) {
      return c.json({ success: false, error: 'Uploaded file not found' }, 404)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const mime = file.type || 'image/png'
    const base64 = `data:${mime};base64,${buffer.toString('base64')}`

    const courses = await parseScheduleImage(base64)

    await supabase.from('schedule_imports').insert({
      user_id: authUser.id,
      semester_id: semester,
      image_url: path,
      raw_result: courses,
      status: courses.length > 0 ? 'confirmed' : 'failed',
    })

    if (courses.length === 0) {
      return c.json({ success: false, error: 'No courses found in the image' }, 400)
    }

    return c.json({ success: true, courses, semester })
  } catch (error: any) {
    console.error('Import parse error:', error)
    if (error?.message === 'Quota exceeded') {
      return c.json({ success: false, error: 'Daily upload quota reached. Try again tomorrow.' }, 429)
    }
    return c.json({ success: false, error: error.message || 'Failed to parse schedule' }, 500)
  }
})

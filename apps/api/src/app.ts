import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { scheduleRoutes } from './routes/schedule.js'
import { roomRoutes } from './routes/room.js'
import { userRoutes } from './routes/user.js'
import { rutgersRoutes } from './routes/rutgers.js'
import { contactRoutes } from './routes/contact.js'
import { importRoutes } from './routes/import.js'
import { systemRoutes } from './routes/system.js'
import { cronRoutes } from './routes/cron.js'
import { gradesRoutes } from './routes/grades.js'
import { seatwatchRoutes } from './routes/seatwatch.js'
import { referralRoutes } from './routes/referral.js'
import { schedulerRoutes } from './routes/scheduler.js'
import { canvasRoutes } from './routes/canvas.js'
import { rateLimit } from './middleware/rateLimit.js'
import { supabase } from './lib/supabase.js'

const app = new Hono()

// Middleware
app.use('*', logger())

// CORS is only needed for cross-origin dev setups. In production the web app
// reaches the API same-origin through Vercel rewrites (see apps/web/vercel.json).
const allowedOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null
    if (origin.startsWith('http://localhost:')) return origin
    if (allowedOrigins.includes(origin)) return origin
    return null
  },
  credentials: true,
}))

app.use('/api/*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'global' }))

// Health checks
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'classmate-api',
    version: '0.2.0',
  })
})

const healthz = async (c: any) => {
  let db: 'up' | 'down' = 'down'
  try {
    const ping = supabase.from('semesters').select('id').limit(1)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('db ping timeout')), 1_000)
    )
    const { error } = (await Promise.race([ping, timeout])) as { error: unknown }
    if (!error) db = 'up'
  } catch {
    db = 'down'
  }
  return c.json({ ok: db === 'up', version: '0.2.0', db }, db === 'up' ? 200 : 503)
}

app.get('/health', (c) => c.json({ status: 'healthy' }))
app.get('/healthz', healthz)
app.get('/api/healthz', healthz)

// Routes
app.route('/api/schedule', scheduleRoutes)
app.route('/api/import', importRoutes)
app.route('/api/rooms', roomRoutes)
app.route('/api/users', userRoutes)
app.route('/api/rutgers', rutgersRoutes)
app.route('/api/contacts', contactRoutes)
app.route('/api/system', systemRoutes)
app.route('/api/cron', cronRoutes)
app.route('/api/grades', gradesRoutes)
app.route('/api/seatwatch', seatwatchRoutes)
app.route('/api/referral', referralRoutes)
app.route('/api/scheduler', schedulerRoutes)
app.route('/api/canvas', canvasRoutes)

// Error handling
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({
    error: 'Internal Server Error',
    message: err.message,
  }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

export default app

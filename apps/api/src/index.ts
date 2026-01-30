import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { scheduleRoutes } from './routes/schedule.js'
import { roomRoutes } from './routes/room.js'
import { userRoutes } from './routes/user.js'
import { rutgersRoutes } from './routes/rutgers.js'
import { contactRoutes } from './routes/contact.js'
import { rateLimit } from './middleware/rateLimit.js'
import { recordError, recordRequest, getMetricsSnapshot } from './lib/metrics.js'

const app = new Hono()

// Middleware
app.use('*', logger())
const allowedOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null
    if (origin.startsWith('http://localhost:')) return origin
    if (allowedOrigins.includes(origin)) return origin
    if (origin.endsWith('.vercel.app')) return origin
    return null
  },
  credentials: true,
}))
app.use('*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'global' }))
app.use('*', async (c, next) => {
  recordRequest()
  try {
    await next()
  } catch (error) {
    recordError()
    throw error
  }
})

// Health check
app.get('/', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'classmate-api',
    version: '0.1.0'
  })
})

app.get('/health', (c) => {
  return c.json({ status: 'healthy' })
})
app.get('/metrics', (c) => c.json({ success: true, metrics: getMetricsSnapshot() }))

// Routes
app.route('/api/schedule', scheduleRoutes)
app.route('/api/rooms', roomRoutes)
app.route('/api/users', userRoutes)
app.route('/api/rutgers', rutgersRoutes)
app.route('/api/contacts', contactRoutes)

// Error handling
app.onError((err, c) => {
  console.error('Error:', err)
  return c.json({ 
    error: 'Internal Server Error',
    message: err.message 
  }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404)
})

const port = parseInt(process.env.PORT || '3000')

console.log(`🚀 ClassMate API starting on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`✅ ClassMate API is running on http://localhost:${info.port}`)
})

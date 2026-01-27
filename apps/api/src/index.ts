import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { scheduleRoutes } from './routes/schedule'
import { roomRoutes } from './routes/room'
import { userRoutes } from './routes/user'
import { rutgersRoutes } from './routes/rutgers'
import { contactRoutes } from './routes/contact'

const app = new Hono()

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: (origin) => {
    // Allow localhost on any port for development
    if (!origin || origin.startsWith('http://localhost:')) {
      return origin || 'http://localhost:3000'
    }
    return null
  },
  credentials: true,
}))

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

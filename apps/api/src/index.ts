import 'dotenv/config'
import { serve } from '@hono/node-server'
import app from './app.js'

// Local development entry point only. On Vercel the app is served as a
// serverless function via apps/api/api/index.ts (hono/vercel).
if (!process.env.VERCEL) {
  const port = parseInt(process.env.PORT || '3000')

  console.log(`🚀 ClassMate API starting on http://localhost:${port}`)

  serve({
    fetch: app.fetch,
    port,
  }, (info) => {
    console.log(`✅ ClassMate API is running on http://localhost:${info.port}`)
  })
}

export default app

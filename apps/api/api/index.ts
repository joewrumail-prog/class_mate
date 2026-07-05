// Vercel Function entry for standalone apps/api deployment (kept in sync with
// apps/web/api/[[...route]].ts — the single-project entry actually in use).
// Node runtime => @hono/node-server/vercel adapter, NOT hono/vercel (Edge).
import { handle } from '@hono/node-server/vercel'
import app from '../src/app.js'

export const config = { api: { bodyParser: false } }

export default handle(app)

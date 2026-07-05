// Single-project deployment: this catch-all serves every /api/* route from
// the same Vercel project that hosts the web app (same-origin, no rewrites).
// The Hono app itself lives in apps/api — this file is only the Vercel entry.
// Requires "Include source files outside of the Root Directory" (Vercel
// project setting, on by default) since it imports across the monorepo.
import { handle } from 'hono/vercel'
import app from '../../api/src/app.js'

export const config = { runtime: 'nodejs' }

export default handle(app)

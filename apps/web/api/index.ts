// Single-project deployment: this catch-all serves every /api/* route from
// the same Vercel project that hosts the web app (same-origin, no rewrites).
// The Hono app itself lives in apps/api — this file is only the Vercel entry.
//
// NOTE: on the Vercel *Node.js* runtime the adapter must be
// @hono/node-server/vercel (Node req/res signature). `hono/vercel` is the
// Edge adapter — using it here makes every request hang until
// FUNCTION_INVOCATION_TIMEOUT because the response is never written.
import { handle } from '@hono/node-server/vercel'
import app from '../../api/src/app.js'

// Hono reads the raw request body itself.
export const config = { api: { bodyParser: false } }

export default handle(app)

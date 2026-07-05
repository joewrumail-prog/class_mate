import type { Context, Next } from 'hono'
import { supabase } from '../lib/supabase.js'

type RateLimitOptions = {
  windowMs: number
  max: number
  keyPrefix: string
}

const getKey = (c: Context, prefix: string) => {
  const forwarded = c.req.header('x-forwarded-for') || ''
  const ip = forwarded.split(',')[0].trim() || c.req.header('cf-connecting-ip') || 'unknown'
  return `${prefix}:${ip}`
}

/**
 * Serverless-safe fixed-window rate limiter backed by Postgres
 * (`check_rate_limit` RPC, atomic upsert on the `rate_limits` table).
 * In-memory buckets are meaningless on Vercel where every invocation may land
 * on a fresh instance. Fails open on infrastructure errors so a DB hiccup
 * never takes the API down.
 */
export const rateLimit = (options: RateLimitOptions) => {
  const windowSeconds = Math.max(1, Math.round(options.windowMs / 1000))

  return async (c: Context, next: Next) => {
    const key = getKey(c, options.keyPrefix)

    try {
      const { data, error } = await supabase.rpc('check_rate_limit', {
        p_key: key,
        p_max: options.max,
        p_window_seconds: windowSeconds,
      })

      if (!error && data === false) {
        return c.json({ success: false, error: 'Rate limit exceeded' }, 429)
      }
    } catch (err) {
      console.error('rateLimit check failed (failing open):', err)
    }

    await next()
  }
}

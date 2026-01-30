import type { Context, Next } from 'hono'

type RateLimitOptions = {
  windowMs: number
  max: number
  keyPrefix: string
}

const buckets = new Map<string, { count: number; resetAt: number }>()

const getKey = (c: Context, prefix: string) => {
  const forwarded = c.req.header('x-forwarded-for') || ''
  const ip = forwarded.split(',')[0].trim() || c.req.header('cf-connecting-ip') || 'unknown'
  return `${prefix}:${ip}`
}

export const rateLimit = (options: RateLimitOptions) => {
  return async (c: Context, next: Next) => {
    const key = getKey(c, options.keyPrefix)
    const now = Date.now()
    const existing = buckets.get(key)

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs })
      await next()
      return
    }

    if (existing.count >= options.max) {
      return c.json({ success: false, error: 'Rate limit exceeded' }, 429)
    }

    existing.count += 1
    buckets.set(key, existing)
    await next()
  }
}

/**
 * Auth — email magic-link sign-in (DEV-SPEC W1, acceptance #1: non-whitelist
 * domains are rejected with 403).
 *
 * Layout mirrors lib/webreg.ts / lib/alerts.ts:
 *   1. PURE section — domain-whitelist matcher and email copy builder. No env
 *      access, no supabase import, no network. apps/api/tests/auth.test.ts
 *      imports ONLY these exports, so this module must stay import-safe
 *      without any environment configured (supabase is imported lazily below).
 *   2. IO section — POST /magic-link: whitelist check against
 *      schools.edu_domains, service-role generateLink, resend delivery.
 *
 * PRIVACY (DEV-SPEC §1 hard rule): the email address is contact info — it must
 * never appear in logs. Every console.* below logs error details only.
 *
 * ANTI-ENUMERATION: once the domain passes the whitelist, the response is
 * always {success:true} — even when generateLink or resend fails for
 * account-state reasons — so the endpoint never reveals whether an address
 * already has an account. The only post-whitelist error surfaced is the
 * config-shaped 503 when RESEND_API_KEY is absent, which is uniform for every
 * address and leaks nothing.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { rateLimit } from '../middleware/rateLimit.js'

// =========================================================================
// 1. PURE — domain whitelist
// =========================================================================

/**
 * True when the email's domain is one of `domains` or a subdomain of one
 * (suffix match on dot boundaries, case-insensitive).
 *
 *   emailDomainAllowed('a@scarletmail.rutgers.edu', ['rutgers.edu'])  → true
 *   emailDomainAllowed('a@evil-rutgers.edu',        ['rutgers.edu'])  → false
 *   emailDomainAllowed('a@rutgers.edu.attacker.com',['rutgers.edu'])  → false
 *
 * Deliberately strict on shape: exactly one '@', non-empty local part, and a
 * dotted host. Anything else (garbage, empty, quoted-local exotica) is
 * rejected — zod has already validated real submissions upstream.
 */
export function emailDomainAllowed(email: string, domains: string[]): boolean {
  if (typeof email !== 'string' || !Array.isArray(domains)) return false
  const parts = email.trim().toLowerCase().split('@')
  if (parts.length !== 2) return false
  const [local, host] = parts
  if (!local || !host || !host.includes('.')) return false

  return domains.some((entry) => {
    const domain = (entry || '').trim().toLowerCase()
    if (!domain) return false
    return host === domain || host.endsWith(`.${domain}`)
  })
}

// =========================================================================
// 1. PURE — magic-link email copy
// =========================================================================

export interface MagicLinkEmail {
  subject: string
  text: string
  html: string
}

/**
 * Minimal sign-in email. Tone follows the system persona spec (§8): calm,
 * states the reason, no exclamation marks, no urgency theater.
 */
export function buildMagicLinkEmail(actionLink: string): MagicLinkEmail {
  const subject = 'Your ClassMate sign-in link'

  const text = [
    'You asked to sign in to ClassMate. Here is your link.',
    '',
    actionLink,
    '',
    'It works once and expires soon.',
    'If you did not request this, ignore this email and nothing changes.',
  ].join('\n')

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:13px;letter-spacing:.12em;color:#6B7280;margin:0 0 8px">CLASSMATE</p>
  <h1 style="font-size:22px;margin:0 0 12px;color:#1F2937">Sign in to ClassMate</h1>
  <p style="font-size:15px;color:#374151;margin:0 0 20px">You asked to sign in. One click and you are back on your schedule.</p>
  <a href="${actionLink}" style="display:inline-block;background:#1F2937;color:#fff;font-size:15px;font-weight:700;padding:12px 22px;border-radius:8px;text-decoration:none">Sign in →</a>
  <p style="font-size:13px;color:#6B7280;margin:20px 0 0">The link works once and expires soon.</p>
  <p style="font-size:12px;color:#94A3B8;margin:24px 0 0">If you did not request this, ignore this email and nothing changes.</p>
</div>`.trim()

  return { subject, text, html }
}

// =========================================================================
// 2. IO — POST /magic-link
// =========================================================================

export const authRoutes = new Hono()

const magicLinkSchema = z.object({
  email: z.string().trim().max(320).email('A valid email address is required'),
})

function webBaseUrl(): string {
  return (process.env.SELF_BASE_URL || 'https://class-mate-web-d1vc.vercel.app').replace(/\/+$/, '')
}

authRoutes.post(
  '/magic-link',
  rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'auth-magic' }),
  async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { email } = magicLinkSchema.parse(body)

      // Whitelist source of truth: schools.edu_domains across all schools
      // (multi-school ready; W1 seed is the single Rutgers NB row).
      const { supabase } = await import('../lib/supabase.js')
      const { data: schools, error: schoolsError } = await supabase
        .from('schools')
        .select('edu_domains')
      if (schoolsError) throw schoolsError

      const domains = ((schools as { edu_domains: string[] | null }[]) || []).flatMap(
        (s) => s.edu_domains || []
      )

      // DEV-SPEC acceptance #1: non-whitelist domain → 403.
      if (!emailDomainAllowed(email, domains)) {
        return c.json(
          { success: false, error: 'Sign-in is limited to supported school email domains' },
          403
        )
      }

      // Config check before any account-state-dependent work so the response
      // stays uniform for every whitelisted address.
      const resendKey = process.env.RESEND_API_KEY
      if (!resendKey) {
        console.error('Magic link unavailable: RESEND_API_KEY not set')
        return c.json({ success: false, error: 'Email delivery not configured' }, 503)
      }

      // From here on, always {success:true} — see ANTI-ENUMERATION note above.
      const { data, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo: `${webBaseUrl()}/dashboard` },
      })

      const actionLink = data?.properties?.action_link
      if (linkError || !actionLink) {
        // Account-state failure (e.g. no such user yet). Log the reason only —
        // never the address (privacy hard rule).
        console.error(
          'Magic link generate failed (uniform success returned):',
          linkError?.message || 'no action_link in response'
        )
        return c.json({ success: true })
      }

      try {
        const { Resend } = await import('resend')
        const resend = new Resend(resendKey)
        const from = process.env.ALERT_FROM_EMAIL || 'ClassMate <onboarding@resend.dev>'
        const message = buildMagicLinkEmail(actionLink)
        const { error: sendError } = await resend.emails.send({
          from,
          to: email,
          subject: message.subject,
          text: message.text,
          html: message.html,
        })
        if (sendError) {
          console.error('Magic link send failed (uniform success returned):', sendError)
        }
      } catch (sendErr: any) {
        console.error('Magic link send threw (uniform success returned):', sendErr?.message)
      }

      return c.json({ success: true })
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return c.json(
          { success: false, error: error.errors[0]?.message || 'Invalid input' },
          400
        )
      }
      // House-style catch, but log the message only: the thrown value could
      // otherwise echo request internals, and emails must never hit logs.
      console.error('Magic link error:', error?.message || error)
      return c.json({ success: false, error: 'Sign-in is temporarily unavailable' }, 500)
    }
  }
)

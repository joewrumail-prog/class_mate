/**
 * Seat-open alert delivery (the product's #1 moment) — modeled on the Rutgers
 * Course Sniper flow: when a watched section opens, email the student a
 * WebReg deep link with the index pre-filled so registering is one click.
 *
 * Layout mirrors lib/webreg.ts: PURE builders first (tested, no env/network),
 * then the resend IO wrapped so a missing RESEND_API_KEY degrades to a logged
 * no-op instead of failing the poll run.
 *
 * Env (IO only):
 *   RESEND_API_KEY    — resend.com API key. Absent => alerts are skipped
 *                       (ledger keeps working, nothing throws).
 *   ALERT_FROM_EMAIL  — sender, e.g. "ClassMate Alerts <alerts@yourdomain>".
 *                       Default onboarding@resend.dev (resend's shared test
 *                       sender: only delivers to the account owner's inbox
 *                       until a domain is verified).
 */

import { parseSemesterId } from './webreg.js'

// =========================================================================
// PURE — WebReg deep link + email builders
// =========================================================================

/**
 * WebReg registration deep link with the section index pre-filled.
 * semesterSelection is Rutgers' {term}{year} code, e.g. Fall 2026 = "92026"
 * (9=fall, 7=summer, 1=spring, 0=winter — verified against the live SOC API).
 */
export function webregDeepLink(semester: string, sectionIndex: string): string | null {
  const parsed = parseSemesterId(semester)
  if (!parsed || !/^\d{1,6}$/.test(sectionIndex)) return null
  return `https://sims.rutgers.edu/webreg/editSchedule.htm?login=cas&semesterSelection=${parsed.term}${parsed.year}&indexList=${sectionIndex}`
}

export interface SeatAlertInput {
  sectionIndex: string
  courseCode: string | null
  semester: string
}

export interface SeatAlertEmail {
  subject: string
  text: string
  html: string
}

/** Sniper-style alert copy: urgent, index prominent, one-click register. */
export function buildSeatAlertEmail(input: SeatAlertInput): SeatAlertEmail {
  const course = input.courseCode || 'your watched section'
  const link = webregDeepLink(input.semester, input.sectionIndex)
  const subject = `Seat open: ${course} · index ${input.sectionIndex}`

  const text = [
    `A seat just opened in ${course} (index ${input.sectionIndex}).`,
    '',
    'Seats go fast — register NOW:',
    link || 'https://sims.rutgers.edu/webreg/',
    '',
    `Index to paste into WebReg: ${input.sectionIndex}`,
    '',
    'You are getting this because you watch this section on ClassMate.',
    'Stop watching it from your Dashboard to stop these alerts.',
  ].join('\n')

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <p style="font-size:13px;letter-spacing:.12em;color:#6B7280;margin:0 0 8px">CLASSMATE SEAT WATCH</p>
  <h1 style="font-size:22px;margin:0 0 12px;color:#1F2937">A seat just opened 🎉</h1>
  <p style="font-size:15px;color:#374151;margin:0 0 4px"><strong>${course}</strong></p>
  <p style="font-size:14px;color:#6B7280;margin:0 0 20px">Section index
    <span style="font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#1F2937">${input.sectionIndex}</span>
    · ${input.semester}</p>
  ${
    link
      ? `<a href="${link}" style="display:inline-block;background:#16A34A;color:#fff;font-size:15px;font-weight:700;padding:12px 22px;border-radius:8px;text-decoration:none">Register in WebReg →</a>`
      : ''
  }
  <p style="font-size:13px;color:#6B7280;margin:20px 0 0">Seats go fast. If the link asks you to log in,
  paste the index <span style="font-family:ui-monospace,Menlo,monospace">${input.sectionIndex}</span> after CAS login.</p>
  <p style="font-size:12px;color:#94A3B8;margin:24px 0 0">You watch this section on ClassMate.
  Remove the watch from your Dashboard to stop these alerts.</p>
</div>`.trim()

  return { subject, text, html }
}

// =========================================================================
// IO — resend delivery (lazy; missing key = logged no-op)
// =========================================================================

let resendPromise: Promise<import('resend').Resend | null> | null = null

function getResend(): Promise<import('resend').Resend | null> {
  if (!resendPromise) {
    resendPromise = (async () => {
      const key = process.env.RESEND_API_KEY
      if (!key) {
        console.warn('RESEND_API_KEY not set — seat-open alerts will be skipped')
        return null
      }
      const { Resend } = await import('resend')
      return new Resend(key)
    })()
  }
  return resendPromise
}

/**
 * Send a seat-open alert. Returns true only when resend accepted the email —
 * callers use this to decide whether to stamp notified_open_at.
 * Never throws: alert failures must not break the poll run.
 */
export async function sendSeatOpenAlert(to: string, input: SeatAlertInput): Promise<boolean> {
  try {
    const resend = await getResend()
    if (!resend || !to) return false

    const from = process.env.ALERT_FROM_EMAIL || 'ClassMate Alerts <onboarding@resend.dev>'
    const email = buildSeatAlertEmail(input)
    const { error } = await resend.emails.send({
      from,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    })
    if (error) {
      console.error('Seat alert send failed:', error)
      return false
    }
    return true
  } catch (err) {
    console.error('Seat alert send threw:', err)
    return false
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailDomainAllowed, buildMagicLinkEmail } from '../src/routes/auth.js'

const RUTGERS = ['rutgers.edu', 'scarletmail.rutgers.edu']

test('emailDomainAllowed: exact domain match', () => {
  assert.equal(emailDomainAllowed('student@rutgers.edu', RUTGERS), true)
  assert.equal(emailDomainAllowed('student@scarletmail.rutgers.edu', RUTGERS), true)
  assert.equal(emailDomainAllowed('student@princeton.edu', RUTGERS), false)
})

test('emailDomainAllowed: subdomain matches via suffix on a dot boundary', () => {
  // scarletmail is covered by the bare rutgers.edu entry alone.
  assert.equal(emailDomainAllowed('a@scarletmail.rutgers.edu', ['rutgers.edu']), true)
  assert.equal(emailDomainAllowed('a@deep.scarletmail.rutgers.edu', ['rutgers.edu']), true)
  // But a parent domain does NOT satisfy a subdomain-only whitelist entry.
  assert.equal(emailDomainAllowed('a@rutgers.edu', ['scarletmail.rutgers.edu']), false)
})

test('emailDomainAllowed: case-insensitive on both sides', () => {
  assert.equal(emailDomainAllowed('Student@RUTGERS.EDU', ['rutgers.edu']), true)
  assert.equal(emailDomainAllowed('a@ScarletMail.Rutgers.Edu', ['rutgers.edu']), true)
  assert.equal(emailDomainAllowed('a@rutgers.edu', ['RUTGERS.EDU']), true)
  assert.equal(emailDomainAllowed('a@rutgers.edu', [' Rutgers.EDU ']), true)
})

test('emailDomainAllowed: lookalike domains are rejected', () => {
  // Hyphen prefix — not a subdomain, must not suffix-match.
  assert.equal(emailDomainAllowed('a@evil-rutgers.edu', ['rutgers.edu']), false)
  // Whitelisted domain embedded as a prefix of an attacker-controlled host.
  assert.equal(emailDomainAllowed('a@rutgers.edu.attacker.com', ['rutgers.edu']), false)
  assert.equal(emailDomainAllowed('a@rutgers.edu.evil.co', RUTGERS), false)
  assert.equal(emailDomainAllowed('a@notrutgers.edu', ['rutgers.edu']), false)
})

test('emailDomainAllowed: empty and garbage input is rejected', () => {
  assert.equal(emailDomainAllowed('', RUTGERS), false)
  assert.equal(emailDomainAllowed('   ', RUTGERS), false)
  assert.equal(emailDomainAllowed('garbage', RUTGERS), false)
  assert.equal(emailDomainAllowed('@rutgers.edu', RUTGERS), false) // empty local part
  assert.equal(emailDomainAllowed('a@', RUTGERS), false) // empty host
  assert.equal(emailDomainAllowed('a@b@rutgers.edu', RUTGERS), false) // two @
  assert.equal(emailDomainAllowed('a@localhost', RUTGERS), false) // undotted host
  // Whitespace padding around an otherwise valid address is tolerated.
  assert.equal(emailDomainAllowed('  a@rutgers.edu  ', RUTGERS), true)
})

test('emailDomainAllowed: degenerate whitelist never matches', () => {
  assert.equal(emailDomainAllowed('a@rutgers.edu', []), false)
  // Empty/whitespace entries must not act as a match-everything wildcard.
  assert.equal(emailDomainAllowed('a@rutgers.edu', ['', '   ']), false)
  assert.equal(emailDomainAllowed('a@anything.com', ['']), false)
})

test('magic-link email carries the link and keeps the calm persona (no exclamation marks)', () => {
  const link = 'https://example.supabase.co/auth/v1/verify?token=abc&type=magiclink'
  const email = buildMagicLinkEmail(link)
  assert.match(email.subject, /sign-in link/i)
  assert.ok(email.text.includes(link))
  assert.ok(email.html.includes(link))
  // System persona spec §8: no exclamation marks, anywhere.
  assert.ok(!email.subject.includes('!'))
  assert.ok(!email.text.includes('!'))
  assert.ok(!email.html.includes('!'))
})

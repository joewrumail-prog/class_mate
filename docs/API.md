# ClassMate API — Frontend Integration Contract

This document is the authoritative API contract for rebuilding the ClassMate web UI.
Every endpoint listed here is registered in `apps/api/src/app.ts` and its response
shapes are transcribed from the actual `c.json(...)` calls in the route handlers —
not inferred. Server code lives under `apps/api/src/`; the client helpers referenced
here live under `apps/web/src/lib/`.

---

## 1. Basics

### 1.1 Base URL

The API is a **single Hono function** deployed on Vercel. The web app calls it
**same-origin** under `/api/*` — there is no separate API host in production.
`apps/web/vercel.json` rewrites:

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "/api" },
  { "source": "/((?!api).*)", "destination": "/index.html" }
]
```

So the frontend always uses relative URLs: `fetch('/api/rooms/join', ...)`.

CORS is only relevant for cross-origin dev setups: any `http://localhost:*`
origin is allowed, plus origins listed in the `FRONTEND_ORIGINS` env var
(comma-separated). Credentials are allowed.

### 1.2 Authentication

Auth is a **Supabase session JWT** sent as a Bearer token. The server validates
it with `supabase.auth.getUser(token)` (service-role client). There are no
cookies and no server-side sessions.

The canonical client pattern (`apps/web/src/lib/api.ts`):

```ts
import { supabase } from '@/lib/supabase'

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const authHeaders = await getAuthHeaders()
  const headers = new Headers(init.headers || {})
  Object.entries(authHeaders).forEach(([key, value]) => headers.set(key, value))
  return fetch(input, { ...init, headers })
}
```

Use `authFetch` for every non-public endpoint.

**Auth tiers** (from `apps/api/src/middleware/auth.ts`):

| Tier | Meaning | Failure |
|---|---|---|
| `public` | No token required. Some public routes still read an optional Bearer token to personalize the response (noted per-route). | — |
| `requireAuth` | Valid Supabase JWT required. | `401 { success: false, error: "Unauthorized" }` |
| `requireAccess` | `requireAuth` **plus** access gate: the user's profile has `is_edu_email = true`, OR their auth email ends with `.edu` / `@rutgers.edu`, OR their profile `invite_code` equals the server's `INVITE_CODE` env var. | `401` as above, or `403 { success: false, error: "Invite code required" }`, or `500 { success: false, error: "Failed to verify access" }` |
| `CRON_SECRET` | Header must be exactly `Authorization: Bearer <CRON_SECRET env>`. Vercel Cron sends this automatically. Not for browser use. | `401 { success: false, error: "Unauthorized" }` |

**Ownership rule:** every route that takes a `userId` (path param or body field)
compares it against the authenticated user's id and returns
`403 { success: false, error: "Forbidden" }` on mismatch. The UI must always
pass the logged-in user's own id.

### 1.3 Response envelope

Route-level responses always carry a `success` boolean:

- Success: `{ "success": true, ...payload }`
- Failure: `{ "success": false, "error": "<message>" }` with an appropriate 4xx/5xx status.
  A few failures add extra fields (e.g. seat-watch `code: "SLOT_LIMIT"`).

Two app-level exceptions do **not** have a `success` field:

- Unhandled error (global `onError`): `500 { "error": "Internal Server Error", "message": "<err.message>" }`
- Unknown path: `404 { "error": "Not Found" }`

Handle both shapes defensively: check `res.ok` first, then read `success`.

### 1.4 Rate limiting

- **Global:** every `/api/*` request passes a fixed-window limiter of
  **120 requests / 60 s / IP** (key = `x-forwarded-for` first hop, fallback
  `cf-connecting-ip`). Backed by the Postgres `check_rate_limit` RPC so it works
  across serverless instances. Exceeding it returns
  `429 { "success": false, "error": "Rate limit exceeded" }`.
- **Fails open:** if the rate-limit RPC errors, the request proceeds — a DB
  hiccup never takes the API down.
- **Per-route:** `POST /api/import/parse` has an additional **10 req / 60 s / IP**
  limit (LLM cost guard), same 429 shape.

### 1.5 Health checks

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/` | public | `200 { "status": "ok", "service": "classmate-api", "version": "0.2.0" }` |
| GET | `/health` | public | `200 { "status": "healthy" }` |
| GET | `/healthz` | public | see below |
| GET | `/api/healthz` | public | see below |

`/healthz` and `/api/healthz` ping the DB (1 s timeout) and return
`{ "ok": boolean, "version": "0.2.0", "db": "up" | "down" }` with status
**200** when the DB is up and **503** when it is down. The frontend should use
`/api/healthz` (it goes through the same rewrite as everything else).

---

## 2. Endpoints by domain

Conventions in the tables below: types are the zod-validated ones; `uuid` means
a string UUID; times are `"HH:MM"` 24-hour strings; `day`/`dayOfWeek` is an
integer `1..7` (1 = Monday … 7 = Sunday); semester ids look like `"2026-fall"`
(`YYYY-(spring|summer|fall|winter)`).

### 2.1 Schedule (`/api/schedule`) — `routes/schedule.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/schedule/confirm` | requireAccess | Save parsed courses; find-or-create course rooms and join them |
| GET | `/api/schedule/overlap` | requireAuth | Classmate overlap summary (privacy-reduced) |

#### POST `/api/schedule/confirm`

Request body (zod `confirmSchema`):

```jsonc
{
  "userId": "uuid",            // must equal the authenticated user's id
  "semester": "2026-fall",     // string, stored as course_rooms.semester_id
  "school": "Rutgers University - New Brunswick",
  "courses": [
    {
      "name": "string",
      "day": 1,                // number, .min(1).max(7)
      "startTime": "10:20",    // string
      "endTime": "11:40",      // string
      "classroom": "string",
      "professor": "string",
      "weeks": "string"        // e.g. "1-16", may be ""
    }
  ]
}
```

Side effects: creates the user profile row if missing (nickname = email local
part), find-or-creates `courses` and `course_rooms` rows keyed on all meeting
fields, inserts `room_members`, and sends `new_member` notifications to
existing members.

Success `200`:

```jsonc
{
  "success": true,
  "message": "成功加入 N 个课程 Room",
  "created": 0,                // rooms newly created
  "joined": 0,                 // rooms newly joined
  "rooms": [
    {
      "id": "uuid",            // room id
      "courseName": "string",
      // ...plus the spread of the submitted course object:
      "name": "string", "day": 1, "startTime": "10:20", "endTime": "11:40",
      "classroom": "string", "professor": "string", "weeks": "string"
    }
  ]
}
```

Errors: `403 Forbidden` (userId mismatch), `500 { success: false, error }`.

#### GET `/api/schedule/overlap`

No parameters. Success `200`:

```jsonc
{
  "success": true,
  "totalCourses": 5,           // my room memberships
  "overlappingCourses": 3,     // how many of my rooms contain at least one other member
  "classmates": [              // max 20, sorted by sharedCourses desc
    {
      "userId": "uuid",
      "firstName": "Alex",     // FIRST whitespace token of nickname only (see §3.3)
      "avatarUrl": "https://... | null",
      "sharedCourses": 2,
      "rooms": [
        { "roomId": "uuid", "courseName": "string", "courseCode": "string | null" }
      ]
    }
  ],
  "firstCourseCode": "01:198:112 | null",  // code (or name) of my earliest-joined course
  "inviteCode": "ABCD2345 | null"          // read-only; minted by /api/referral/status
}
```

### 2.2 Import (`/api/import`) — `routes/import.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/import/parse` | requireAccess + 10 req/min/IP | OCR-parse an uploaded schedule image |

**Upload flow (important):** the client uploads the screenshot **directly to the
private Supabase Storage bucket `schedules`** (per-user folder, enforced by
storage RLS) using the Supabase JS client, then posts only the storage `path`
here. Base64 image data never travels through the API (Vercel body limit
~4.5 MB).

Request body (zod `parseSchema`):

```jsonc
{
  "path": "<userId>/<filename>",   // string, min 3 chars, MUST start with "<authUserId>/"
  "semester": "2025-spring"        // optional string, default "2025-spring"
}
```

Success `200`:

```jsonc
{
  "success": true,
  "semester": "2025-spring",
  "courses": [                     // vision-model output (ParsedCourse[])
    {
      "name": "string",
      "day": 1,                    // 1=Mon .. 7=Sun
      "startTime": "08:00",
      "endTime": "09:40",
      "classroom": "string",       // "" if not visible
      "professor": "string",       // "" if not visible
      "weeks": "string"            // e.g. "1-16", "" if not visible
    }
  ]
}
```

Errors:

- `403 { success: false, error: "Forbidden path" }` — path outside your folder
- `404 { success: false, error: "Uploaded file not found" }`
- `400 { success: false, error: "No courses found in the image" }`
- `429 { success: false, error: "Daily upload quota reached. Try again tomorrow." }`
  — non-edu users get `DAILY_MATCH_QUOTA` (default **3**) parses per day;
  edu-verified users are exempt
- `429 { success: false, error: "Rate limit exceeded" }` — per-route 10/min limiter

After a successful parse the UI presents the courses for editing, then calls
`POST /api/schedule/confirm`.

### 2.3 Rooms (`/api/rooms`) — `routes/room.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/rooms/my/:userId` | requireAuth (own id) | My joined rooms |
| POST | `/api/rooms/join` | requireAccess | Join/create a room from a Rutgers section index |
| GET | `/api/rooms/:roomId` | public (optional Bearer) | Room details + members with contact visibility |
| POST | `/api/rooms/:roomId/privacy` | requireAuth | Set my per-room contact visibility |
| GET | `/api/rooms/:roomId/privacy/:userId` | requireAuth (own id) | Read my per-room privacy setting |

#### GET `/api/rooms/my/:userId`

Success `200` (sorted by `joinedAt` desc):

```jsonc
{
  "success": true,
  "rooms": [
    {
      "id": "uuid",
      "courseName": "string",
      "courseCode": "string | null",
      "dayOfWeek": 1,
      "startTime": "10:20",
      "endTime": "11:40",
      "professor": "string",
      "classroom": "string",
      "weeks": "string",
      "memberCount": 12,
      "semester": "2026-fall",
      "joinedAt": "ISO timestamp"
    }
  ]
}
```

#### POST `/api/rooms/join`

Request body (zod `joinByIndexSchema`):

```jsonc
{
  "index": "string",   // min length 1 — Rutgers section index
  "year": 2026,        // integer
  "term": 7            // integer Rutgers term code: 1=spring, 7=fall, 9=summer, 0=winter
}
```

Success `200`: `{ "success": true, "roomId": "uuid" }`
Errors: `404 "Section not found"`, `400 "Section time is missing"`.

#### GET `/api/rooms/:roomId`

`roomId` must be a UUID, else `400 { success: false, error: "Invalid roomId" }`.
Pass the Bearer token if logged in — it drives `contactStatus`/`isConnected`
and whether `wechat`/`qq` are revealed.

Success `200`:

```jsonc
{
  "success": true,
  "room": {
    "id": "uuid",
    "courseName": "string",
    "courseCode": "string | null",
    "school": "string",
    "dayOfWeek": 1,
    "startTime": "10:20",
    "endTime": "11:40",
    "professor": "string",
    "classroom": "string",
    "weeks": "string",
    "semester": "2026-fall",
    "memberCount": 12
  },
  "members": [
    {
      "id": "uuid",
      "nickname": "string",
      "avatar": "string | null",
      "wechat": "string | null",   // null unless visible to the caller (see below)
      "qq": "string | null",       // same rule
      "joinedAt": "ISO timestamp",
      "contactStatus": "visible" | "pending" | "rejected" | "hidden",
      "isConnected": false
    }
  ],
  "otherSections": [               // same course, same semester, different room
    { "id": "uuid", "professor": "string", "day_of_week": 1,
      "start_time": "10:20", "member_count": 4 }
  ]
}
```

Contact visibility per member: `wechat`/`qq` are non-null (and
`contactStatus === "visible"`) when the member **is the caller**, is
**connected** to the caller, has **`auto_share_contact` enabled**, or has set
**this room to public**. Otherwise `contactStatus` is `"pending"` /
`"rejected"` if the caller has an open/recent request to them (a rejection
older than 1 hour is hidden again so re-requesting is possible), else
`"hidden"`.

#### POST `/api/rooms/:roomId/privacy`

Request body (not zod-validated): `{ "userId": "uuid", "isPublic": boolean }` —
`userId` must be the caller (else 403; missing → `400 "userId is required"`).
Upserts the caller's `room_privacy_settings` row.
Success: `{ "success": true }`.

#### GET `/api/rooms/:roomId/privacy/:userId`

Success `200`: `{ "success": true, "hasSet": boolean, "isPublic": boolean | null }`
(`isPublic` is `null` when the user never set a preference for this room).

### 2.4 Users (`/api/users`) — `routes/user.ts`

All routes are `requireAuth` and only accept the caller's own `:userId` (403 otherwise).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/users/:userId` | My full profile row |
| PATCH | `/api/users/:userId` | Update profile |
| GET | `/api/users/:userId/notifications` | Latest 50 notifications (`?unread=true` filters) |
| POST | `/api/users/:userId/notifications/read` | Mark listed (or all) notifications read |
| POST | `/api/users/:userId/notifications/:notificationId/read` | Mark one notification read |
| POST | `/api/users/:userId/notifications/read-all` | Mark all unread as read |

#### GET `/api/users/:userId`

Success: `{ "success": true, "user": { ...full users row } }`. The row is a raw
`select('*')` — expect at least: `id, email, nickname, avatar_url, wechat, qq,
school, is_edu_email, email_verified, invite_code, auto_share_contact,
settings, created_at`. `404 "User not found"` if the profile row does not exist.

#### PATCH `/api/users/:userId`

Request body (zod `updateSchema` — all fields optional):

```jsonc
{
  "nickname": "string",        // min 2 chars
  "wechat": "string | null",
  "qq": "string | null",
  "school": "string | null",
  "avatar_url": "https://... | null"   // must be a valid URL when a string
}
```

Success: `{ "success": true, "user": { ...updated row } }`.

#### GET `/api/users/:userId/notifications`

Query: `unread=true` (optional) → only unread. Returns newest first, max 50.

```jsonc
{
  "success": true,
  "notifications": [
    {
      "id": "uuid",
      "user_id": "uuid",
      "type": "new_member" | "contact_request" | "contact_accepted" | "contact_rejected",
      "title": "string",
      "content": "string",
      "data": { /* type-specific: room_id, request_id, requester_id, target_id */ },
      "is_read": false,
      "created_at": "ISO timestamp"
    }
  ]
}
```

#### POST `/api/users/:userId/notifications/read`

Body: `{ "ids": ["uuid", ...] }` — optional; when omitted/empty, **all** of the
user's notifications are marked read. Success: `{ "success": true }`.

#### POST `/api/users/:userId/notifications/:notificationId/read`

Success: `{ "success": true }`.

#### POST `/api/users/:userId/notifications/read-all`

Success: `{ "success": true }`.

### 2.5 Rutgers catalog (`/api/rutgers`) — `routes/rutgers.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/rutgers/semesters` | public | Current + previous semester descriptors |
| GET | `/api/rutgers/search` | public | Search synced SOC sections |
| POST | `/api/rutgers/join` | requireAccess | Join rooms for every meeting day of a section |
| POST | `/api/rutgers/sync` | requireAccess | Pull the SOC catalog into the local DB (admin/ops) |
| GET | `/api/rutgers/sync-status` | public | Row counts + last sync time |
| GET | `/api/rutgers/course/:index` | public | One section's details |

A `rutgers_courses` row (returned raw by search/course endpoints) has:
`index, year, term, campus, subject, course_number, course_string, title,
instructor, meeting_day, start_time, end_time, building, room_number,
campus_name, open_status, credits, updated_at` (raw times are military strings
like `"1020"`; `meeting_day` is letters like `"MW"` with `H` = Thursday).

#### GET `/api/rutgers/semesters`

`{ "success": true, "current": { "year": 2026, "term": 7, "label": "Fall 2026" }, "previous": { ... } }`

#### GET `/api/rutgers/search`

Query params: `q` (required — after stripping to `[a-zA-Z0-9 :-]` it must be at
least 2 chars, else `400 "Query must be at least 2 characters"`), `year`
(default: current year), `term` (default: `1`), `limit` (default: `20`).
An all-digits `q` searches by index prefix; otherwise it matches
`title`/`course_string`/`instructor` (case-insensitive contains).

```jsonc
{
  "success": true,
  "count": 12,
  "courses": [
    {
      /* ...raw rutgers_courses row fields... */
      "formattedTime": "10:20 AM - 11:40 AM",   // "TBA" when start_time missing
      "formattedDay": "Mon/Wed",                // "TBA" when meeting_day missing
      "userCount": 3                            // ClassMate members across this course's rooms this semester
    }
  ]
}
```

#### POST `/api/rutgers/join`

Request body (zod `joinSchema`):

```jsonc
{ "userId": "uuid", "index": "string", "year": 2026, "term": 7 }
```

Creates the user profile if missing, then find-or-creates one room **per
meeting day** of the section and joins each.

Success `200`:

```jsonc
{
  "success": true,
  "message": "Joined N room(s) for <title>",
  "created": 0,
  "joined": 0,
  "rooms": [
    { "id": "uuid", "courseName": "string", "day": 1, "startTime": "10:20",
      "endTime": "11:40", "professor": "string", "classroom": "string" }
  ]
}
```

Errors: `404 "Course not found"`, `400 "Course time is TBA or invalid"`,
`403 Forbidden` (userId mismatch).

#### POST `/api/rutgers/sync`

Body (all optional): `{ "year": 2026, "term": 1, "campus": "NB" }` (defaults:
current year, `1`, `"NB"`). Long-running; upserts the SOC catalog in batches of 500.

```jsonc
{
  "success": true,
  "message": "Synced N sections from Rutgers",
  "stats": { "coursesFromApi": 0, "sectionsInserted": 0, "year": 2026, "term": 1, "campus": "NB" }
}
```

#### GET `/api/rutgers/sync-status`

Query (optional): `year`, `term` — defaults to the computed current semester.

```jsonc
{
  "success": true,
  "current":  { "year": 2026, "term": 7, "count": 14000 },
  "previous": { "year": 2026, "term": 1, "label": "Spring 2026", "count": 13500 },
  "lastUpdated": "ISO timestamp | null",
  "needsSync": false            // true when current.count === 0
}
```

#### GET `/api/rutgers/course/:index`

Query: `year` (default current year), `term` (default `1`).

```jsonc
{
  "success": true,
  "course": { /* raw rutgers_courses row */ , "formattedTime": "...", "formattedDay": "..." },
  "relatedRooms": [ { "id": "uuid", "member_count": 3, "courses": { "name": "...", "code": "..." } } ]
}
```

`404 "Course not found"` when the index/year/term combo is absent.

### 2.6 Contacts (`/api/contacts`) — `routes/contact.ts`

All routes are `requireAccess`; `:userId` params and requester/user body ids must be the caller.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/contacts/request` | Ask a classmate to reveal contact info |
| POST | `/api/contacts/respond` | Accept/decline a request I received |
| GET | `/api/contacts/connections/:userId` | My mutual connections (friends) |
| GET | `/api/contacts/pending/:userId` | Requests waiting on me |
| GET | `/api/contacts/status/:userId/:targetId` | Connection state vs a specific user |

#### POST `/api/contacts/request`

Request body (zod `requestSchema`):

```jsonc
{
  "requesterId": "uuid",        // must equal the caller
  "targetId": "uuid",
  "roomId": "uuid",             // optional — where the request originated
  "message": "string"           // optional, max 200 chars
}
```

Success: `{ "success": true, "message": "Request sent successfully", "request": { ...contact_requests row } }`
(row includes `id, requester_id, target_user_id, room_id, message, status: "pending", created_at`).
Sends a `contact_request` notification to the target.

Errors (all `400` unless noted): `"Cannot request your own contact"`,
`"Already connected"`,
`"Cannot send request. Either pending or need to wait 1 hour after rejection."`,
`403 Forbidden`.

#### POST `/api/contacts/respond`

Request body (zod `respondSchema`):

```jsonc
{ "requestId": "uuid", "userId": "uuid" /* the caller = request target */, "accept": true }
```

On accept, a mutual `user_connections` row is created and both sides can see
each other's contact info. A `contact_accepted`/`contact_rejected` notification
goes to the requester. A rejected requester can retry after 1 hour.

Success: `{ "success": true, "message": "Request accepted" | "Request declined" }`
Error: `404 "Request not found or already responded"`.

#### GET `/api/contacts/connections/:userId`

```jsonc
{
  "success": true,
  "connections": [
    {
      "connectionId": "uuid",
      "connectedAt": "ISO timestamp",
      "roomName": "string | null",       // course name of the originating room
      "friend": {                        // null if the profile row is missing
        "id": "uuid", "nickname": "string", "avatar_url": "string | null",
        "wechat": "string | null", "qq": "string | null", "school": "string | null"
      }
    }
  ]
}
```

#### GET `/api/contacts/pending/:userId`

```jsonc
{
  "success": true,
  "requests": [
    {
      "id": "uuid",
      "message": "string | null",
      "createdAt": "ISO timestamp",
      "roomName": "string | null",
      "requester": { "id": "uuid", "nickname": "string",
                     "avatar_url": "string | null", "school": "string | null" } // or null
    }
  ]
}
```

#### GET `/api/contacts/status/:userId/:targetId`

One of three success shapes:

```jsonc
{ "success": true, "status": "connected" }
{ "success": true, "status": "pending", "isSender": true, "requestId": "uuid" }
{ "success": true, "status": "none", "canRequest": true }
```

### 2.7 System — XP / quests / leaderboard (`/api/system`) — `routes/system.ts`

All routes `requireAuth`. `LevelInfo` is described in §3.1.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/system/summary` | XP level, weekly XP, streak |
| GET | `/api/system/quests` | Today's daily + persistent side/main quests |
| POST | `/api/system/quests/:id/toggle` | Check/uncheck a quest (awards/removes XP) |
| POST | `/api/system/checkin` | Morning/evening check-in (+10 XP, once per kind per day) |
| POST | `/api/system/session` | Log a study session for a room (+25 XP, once per room per day) |
| GET | `/api/system/leaderboard` | Weekly XP top-10 among my room-mates |
| POST | `/api/system/settings` | Patch my `settings` JSON blob |

#### GET `/api/system/summary`

```jsonc
{
  "success": true,
  "xp": { "level": 12, "xpInLevel": 150, "xpMax": 3200, "totalXp": 24350 },  // LevelInfo
  "weeklyXp": 240,     // sum of xp_events in the last 7 days
  "streak": 4          // consecutive days with >=1 XP event (today or yesterday keeps it alive)
}
```

#### GET `/api/system/quests`

Query: `date` (optional `YYYY-MM-DD`, defaults to today in `CAMPUS_TZ`).
Lazily generates the day's quests if the 6 AM cron hasn't.

```jsonc
{
  "success": true,
  "date": "2026-07-06",
  "daily": [ { "id": "uuid", "user_id": "uuid", "kind": "daily", "title": "string",
               "xp": 20, "quest_date": "2026-07-06", "done_at": "ISO | null",
               "created_at": "ISO" } ],
  "side":  [ /* same row shape, kind: "side", quest_date null */ ],
  "main":  [ /* same row shape, kind: "main" */ ]
}
```

#### POST `/api/system/quests/:id/toggle`

No body. Toggles `done_at`; inserts (or deletes) the matching `xp_events` row.
Completing **all** daily quests for the date awards a one-time +30 all-clear
bonus (removed again if a quest is unchecked).

```jsonc
{
  "success": true,
  "done": true,             // new state
  "awardedXp": 20,          // negative of quest.xp when un-checking
  "bonusApplied": false,    // true when the all-clear bonus was just granted
  "xp": { /* LevelInfo after the change */ },
  "leveledUp": false
}
```

Error: `404 "Quest not found"`.

#### POST `/api/system/checkin`

Body (zod, optional): `{ "kind": "morning" | "evening" }` — default `"evening"`.
Success: `{ "success": true, "awardedXp": 10, "xp": { /* LevelInfo */ } }`
Error: `409 "Already checked in"` (per kind per day).

#### POST `/api/system/session`

Body (zod): `{ "roomId": "uuid" }`.
Success: `{ "success": true, "awardedXp": 25, "xp": { /* LevelInfo */ } }`
Error: `409 "Session already logged for this room today"`.

#### GET `/api/system/leaderboard`

Weekly (7-day) XP totals for everyone sharing a room with me, top 10:

```jsonc
{
  "success": true,
  "rows": [
    { "rank": 1, "id": "uuid", "name": "You",  "xp": 320, "isMe": true },
    { "rank": 2, "id": "uuid", "name": "Alex", "xp": 250, "isMe": false }
  ]
}
```

Returns `{ "success": true, "rows": [] }` when I'm in no rooms.

#### POST `/api/system/settings`

Body (zod, both optional): `{ "system_ui": boolean, "school_id": "string(<=30) | null" }`.
Shallow-merges into the user's `settings` JSON.
Success: `{ "success": true, "settings": { ...merged settings } }`.

### 2.8 Grades (`/api/grades`) — `routes/grades.ts`

All routes `requireAuth` **and** require room membership
(`403 "Not a member of this room"` otherwise). `:roomId` must be a UUID
(zod errors → `400`). See §3.2 for the hard privacy policy: **these endpoints
never accept scores**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/grades/weights/:roomId` | Room's confirmed weight scheme (shared) |
| PUT | `/api/grades/weights/:roomId` | Confirm/replace the room's weight scheme |
| GET | `/api/grades/goal/:roomId` | My private letter-grade goal for this course |
| PUT | `/api/grades/goal/:roomId` | Set my goal |

#### GET `/api/grades/weights/:roomId`

`{ "success": true, "weights": <row> | null }` — `null` means nobody has
confirmed a scheme yet (UI deep-links to Import → Syllabus). Row shape:

```jsonc
{
  "room_id": "uuid",
  "components": [ { "name": "Midterm", "weight": 30 } ],
  "source": "syllabus" | "canvas" | "manual",
  "confirmed_by": "uuid",
  "shared": true,
  "updated_at": "ISO timestamp"
}
```

#### PUT `/api/grades/weights/:roomId`

Request body (zod `weightsSchema`):

```jsonc
{
  "components": [                 // 1..30 items
    { "name": "string",           // 1..60 chars
      "weight": 30 }              // number 0..100
  ],
  "source": "syllabus" | "canvas" | "manual"
}
```

Confirming always sets `confirmed_by` = caller and `shared` = true — one
classmate confirming shares the scheme with the whole room.
Success: `{ "success": true, "weights": <row> }`.

#### GET `/api/grades/goal/:roomId`

`{ "success": true, "goal": <row> | null }`. Goals are **owner-only** — the
server only ever returns the caller's own goal; never render another user's.
Row: `{ user_id, room_id, target_letter, updated_at }`.

#### PUT `/api/grades/goal/:roomId`

Body (zod `goalSchema`): `{ "target_letter": "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "D" | "F" }`.
Success: `{ "success": true, "goal": <row> }`.

### 2.9 Seat Watch (`/api/seatwatch`) — `routes/seatwatch.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/seatwatch` | requireAuth | My watches + slots + registrar health |
| POST | `/api/seatwatch` | requireAuth | Add (or reactivate) a watch |
| GET | `/api/seatwatch/health` | public | Registrar health snapshot (for the degraded banner) |
| DELETE | `/api/seatwatch/:id` | requireAuth | Deactivate a watch (soft delete) |
| GET/POST | `/api/seatwatch/cron/poll` | CRON_SECRET | Poll open sections (cron; POST kept for ops) |

Shared shapes:

```jsonc
// watch (a seat_watches row)
{
  "id": "uuid",
  "user_id": "uuid",
  "section_index": "12345",
  "course_code": "01:198:112 | null",
  "semester": "2026-fall",
  "status": "open" | "closed" | "unknown",
  "active": true,
  "last_checked_at": "ISO | null",
  "notified_open_at": "ISO | null",
  "created_at": "ISO"
}

// health snapshot
{
  "state": "closed" | "open" | "half_open",   // circuit breaker; "closed" = healthy
  "degradedIcsOnly": false,     // true => stop promising live seat data (ICS-only banner)
  "consecutiveFailures": 0,
  "lastOkAt": "ISO | null",
  "outageSince": "ISO | null"   // start of the currently-open outage window, if any
}
```

#### GET `/api/seatwatch`

Query: `semester` (optional, default = computed current semester id).

```jsonc
{
  "success": true,
  "semester": "2026-fall",
  "watches": [ /* watch rows, newest first */ ],
  "slots": {
    "used": 1,            // active watches
    "limit": 2,           // FREE plan slots; null when unlimited
    "unlimited": false    // true when the seat_watch_unlimited entitlement is held
  },
  "health": { /* health snapshot */ }
}
```

#### POST `/api/seatwatch`

Request body (zod `createSchema`):

```jsonc
{
  "sectionIndex": "12345",      // required, regex ^\d{1,6}$
  "courseCode": "01:198:112",   // optional, max 40 chars
  "semester": "2026-fall"       // optional, regex ^\d{4}-(spring|summer|fall|winter)$; default current
}
```

Idempotent per (user, section, semester): re-adding an active watch is a no-op;
re-adding an inactive one reactivates it (costs a slot). When `courseCode` is
omitted the server backfills it from the synced catalog.

Success: `{ "success": true, "watch": { ...watch }, "created": true | false }`.

Errors:

- `400 { success: false, error: "<first zod message>" }` — invalid input
- `403` slot limit:

```jsonc
{
  "success": false,
  "error": "Free plan is limited to 2 seat watches per semester",
  "code": "SLOT_LIMIT",
  "upgrade": "seat_watch_unlimited"   // UI: deep-link to the referral flow (§2.10)
}
```

#### GET `/api/seatwatch/health`

`{ "success": true, "health": { /* health snapshot */ } }` — no auth; used for
the "live seat data degraded — ICS-only mode" banner.

#### DELETE `/api/seatwatch/:id`

Soft-deactivates (`active = false`). Non-UUID id or a watch not owned by the
caller → `404 "Watch not found"`. Success: `{ "success": true }`.

#### GET/POST `/api/seatwatch/cron/poll` (CRON_SECRET)

Success:

```jsonc
{
  "success": true,
  "skipped": false,           // true when the breaker is open and cooling down
  "breaker": "closed",
  "degradedIcsOnly": false,
  "checked": 30, "transitions": 2, "alerts": 1, "errors": 0
}
```

### 2.10 Referral (`/api/referral`) — `routes/referral.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/referral/redeem` | requireAuth | Redeem a friend's invite code (new accounts only) |
| GET | `/api/referral/status` | requireAuth | My code + progress toward Seat Watch Unlimited |

#### POST `/api/referral/redeem`

Body (zod `redeemSchema`): `{ "code": "string" }` (trimmed, 1..50 chars).

Success: `{ "success": true }`.

Errors:

- `403 "Referral codes can only be redeemed within 14 days of signing up"`
- `409 "You have already redeemed a referral code"` (one referrer per user)
- `404 "Invalid referral code"` (unknown or ambiguous code)
- `400 "You cannot refer yourself"`
- `404 "Profile not found"`

#### GET `/api/referral/status`

Lazily mints my invite code if missing. Recomputes qualification (a referral
qualifies once the referred user has joined at least one room) and auto-grants
the `seat_watch_unlimited` entitlement for the current semester at
**3 qualified referrals**.

```jsonc
{
  "success": true,
  "code": "ABCD2345",          // my shareable invite code (unambiguous A-Z/2-9 alphabet)
  "semester": "2026-fall",
  "required": 3,
  "qualifiedCount": 1,
  "referrals": [
    { "id": "uuid", "nickname": "string", "createdAt": "ISO", "qualified": true }
  ],
  "unlocked": false,           // entitlement held for this semester
  "justUnlocked": false        // true exactly once, on the call that granted it
}
```

### 2.11 Cron (`/api/cron`) — `routes/cron.ts`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/cron/daily-quests` | CRON_SECRET | Generate the day's daily quests for every user |

Optional query: `date` (`YYYY-MM-DD`, defaults to today in `CAMPUS_TZ`).
Success: `{ "success": true, "date": "2026-07-06", "users": 120, "created": 480, "failed": 0 }`.

---

## 3. Client-side contracts

Things the server deliberately does **not** do — the UI must implement these
exactly as described or the product breaks its promises.

### 3.1 XP level math (`apps/web/src/lib/xp.ts`)

The client mirrors `apps/api/src/lib/xp.ts` — **keep both in sync**. Level is
always derived from total XP (sum of `xp_events`), never stored.

- XP required to advance **from** level `L` to `L+1`: `800 + 200 * L`
  (LV12 → 3200 XP, LV13 → 3400 XP).
- Levels start at 1; sanity cap at level 200.

```ts
export const xpRequiredForLevel = (level: number) => 800 + 200 * level

export interface LevelInfo {
  level: number      // current level (>= 1)
  xpInLevel: number  // XP earned inside the current level
  xpMax: number      // XP needed to finish the current level (= xpRequiredForLevel(level))
  totalXp: number    // lifetime XP
}

export function levelFromXp(totalXp: number): LevelInfo {
  let level = 1
  let rest = Math.max(0, totalXp)
  while (rest >= xpRequiredForLevel(level)) {
    rest -= xpRequiredForLevel(level)
    level += 1
    if (level >= 200) break
  }
  return { level, xpInLevel: rest, xpMax: xpRequiredForLevel(level), totalXp: Math.max(0, totalXp) }
}
```

Every XP-mutating endpoint (`quests/:id/toggle`, `checkin`, `session`) returns
the fresh server-computed `LevelInfo` as `xp` — prefer that over recomputing,
but use `levelFromXp` for progress bars and optimistic UI.

XP economy constants (server `QUEST_XP`): lecture 20, review 15, checkin 10,
assignment 40, gym 20, sleep 15, **all-clear bonus 30**, study session 25,
evening check-in 10, main quest 1000, side quests 120/200/150.

### 3.2 GPA policy — scores never leave the device

Hard rule (see the policy banner in `apps/api/src/routes/grades.ts`):

- **GPA projection is computed client-side** (`apps/web/src/lib/gpa.ts`).
- **Scores live ONLY in `localStorage`** on the student's device: Canvas
  scores, per-assignment grades, points earned/possible, current percentages —
  none of it is ever sent to any endpoint.
- The server stores exactly two things: the room's **weight scheme**
  (`/api/grades/weights/:roomId`, shared with the room) and the user's private
  **letter-grade goal** (`/api/grades/goal/:roomId`).
- Do not build any request that posts score data. There is no endpoint for it,
  and none should be added — "your grades never leave your device" is a trust
  selling point and storing them is FERPA-adjacent liability.

### 3.3 Overlap reveal privacy — first name + counts only

Hard rule (from the product spec, enforced in `GET /api/schedule/overlap`):

- Classmate objects carry **avatar + first name + counts + shared room list
  ONLY**. `firstName` is the first whitespace token of the nickname — the full
  nickname/handle is never exposed here.
- No schedules, no contact info, no emails in the overlap view.
- Connecting stays **mutual opt-in** through the contact-request flow
  (§2.6). Contact details only become visible via the visibility rules in
  `GET /api/rooms/:roomId` (§2.3).

The UI must not try to enrich overlap classmates with data from other
endpoints in a way that defeats this.

---

## 4. Cron endpoints

Both cron endpoints require `Authorization: Bearer <CRON_SECRET>` — Vercel Cron
sends this header automatically when the `CRON_SECRET` env var is set on the
project. Manual/ops invocation must supply the same header. Without a match
they return `401 { success: false, error: "Unauthorized" }` (also when the env
var is unset — they fail closed).

| Path | Purpose | Schedule (`apps/api/vercel.json`) | Schedule (`apps/web/vercel.json`) |
|---|---|---|---|
| `GET /api/cron/daily-quests` | Generate daily quests for all users | `0 10 * * *` (10:00 UTC = 6 AM ET) | `0 10 * * *` |
| `GET /api/seatwatch/cron/poll` | Poll SOC open sections, update watches, write alert ledger | `*/2 * * * *` (every 2 min) | `0 11 * * *` (daily) |

Notes:

- The two `vercel.json` files declare different poll cadences; the schedule
  that applies is the one on the **project actually deployed**. The intended
  cadence for seat-watch polling is every 2 minutes (`apps/api/vercel.json`);
  the daily entry in `apps/web/vercel.json` is a plan-constrained fallback.
- `/api/seatwatch/cron/poll` is registered for **GET and POST** (Vercel invokes
  crons with GET; POST is kept for manual ops triggering).
- Both Vercel configs set `maxDuration: 60` on the function — long syncs
  (`/api/rutgers/sync`) and poll passes must fit in 60 s.
- Quest "today" and streak boundaries use `CAMPUS_TZ` (default
  `America/New_York`), not UTC.

---

## 5. Environment variables

### Server (the Hono API function)

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase project URL (service client) |
| `SUPABASE_SERVICE_KEY` | yes | Service-role key — full DB/storage access; JWT validation |
| `OPENAI_API_KEY` | yes* | Vision model for `/api/import/parse` (*or `DOUBAO_API_KEY`) |
| `CRON_SECRET` | yes | Bearer secret for the cron endpoints; Vercel sends it automatically |
| `OPENAI_VISION_MODEL` | optional | Override the OpenAI vision model (default `gpt-5.4-mini`) |
| `DOUBAO_API_KEY` | optional | Doubao (Volcengine Ark) key — **takes precedence** over OpenAI when set |
| `DOUBAO_ENDPOINT_ID` | optional | Doubao model/endpoint (default `doubao-seed-1-6-vision-250815`) |
| `CAMPUS_TZ` | optional | IANA timezone for quest-date boundaries (default `America/New_York`) |
| `FRONTEND_ORIGINS` | optional | Comma-separated extra CORS origins (localhost is always allowed) |
| `INVITE_CODE` | optional | Legacy access-gate code accepted by `requireAccess` for non-edu users |
| `DAILY_MATCH_QUOTA` | optional | Daily OCR-parse quota for non-edu users (default `3`) |
| `WEBREG_BASE_URL` | optional | Override the Rutgers SOC API base (default `https://classes.rutgers.edu/soc/api`) |
| `WEBREG_PROXY_URLS` | optional | Comma-separated relay bases, rotated per request (SOC IP-block escape hatch) |
| `RESEND_API_KEY` | optional | Email (Resend) — reserved |
| `PORT` | local dev only | Local server port (default `3000`); ignored on Vercel |

### Client (Vite web app)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Supabase project URL — auth session + direct storage uploads (`schedules` bucket) |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon key (RLS-protected) |

The client never sees the service key, never talks to OpenAI/Doubao, and never
sends grade scores anywhere.

---

## Appendix: endpoint index (45 API routes + 4 health checks)

```text
public        GET    /                                        service banner
public        GET    /health                                  static ok
public        GET    /healthz                                 db ping (200/503)
public        GET    /api/healthz                             db ping (200/503)

requireAccess POST   /api/schedule/confirm
requireAuth   GET    /api/schedule/overlap

requireAccess POST   /api/import/parse                        +10/min/IP limiter

requireAuth   GET    /api/rooms/my/:userId
requireAccess POST   /api/rooms/join
public*       GET    /api/rooms/:roomId                       *optional Bearer personalizes
requireAuth   POST   /api/rooms/:roomId/privacy
requireAuth   GET    /api/rooms/:roomId/privacy/:userId

requireAuth   GET    /api/users/:userId
requireAuth   PATCH  /api/users/:userId
requireAuth   GET    /api/users/:userId/notifications
requireAuth   POST   /api/users/:userId/notifications/read
requireAuth   POST   /api/users/:userId/notifications/:notificationId/read
requireAuth   POST   /api/users/:userId/notifications/read-all

public        GET    /api/rutgers/semesters
public        GET    /api/rutgers/search
requireAccess POST   /api/rutgers/join
requireAccess POST   /api/rutgers/sync
public        GET    /api/rutgers/sync-status
public        GET    /api/rutgers/course/:index

requireAccess POST   /api/contacts/request
requireAccess POST   /api/contacts/respond
requireAccess GET    /api/contacts/connections/:userId
requireAccess GET    /api/contacts/pending/:userId
requireAccess GET    /api/contacts/status/:userId/:targetId

requireAuth   GET    /api/system/summary
requireAuth   GET    /api/system/quests
requireAuth   POST   /api/system/quests/:id/toggle
requireAuth   POST   /api/system/checkin
requireAuth   POST   /api/system/session
requireAuth   GET    /api/system/leaderboard
requireAuth   POST   /api/system/settings

CRON_SECRET   GET    /api/cron/daily-quests

requireAuth   GET    /api/grades/weights/:roomId
requireAuth   PUT    /api/grades/weights/:roomId
requireAuth   GET    /api/grades/goal/:roomId
requireAuth   PUT    /api/grades/goal/:roomId

requireAuth   GET    /api/seatwatch
requireAuth   POST   /api/seatwatch
public        GET    /api/seatwatch/health
requireAuth   DELETE /api/seatwatch/:id
CRON_SECRET   GET    /api/seatwatch/cron/poll
CRON_SECRET   POST   /api/seatwatch/cron/poll

requireAuth   POST   /api/referral/redeem
requireAuth   GET    /api/referral/status
```

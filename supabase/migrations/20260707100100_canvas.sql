-- Canvas integration (PRODUCT-V1 §3.1 source #2): one connection row per user
-- holding the encrypted Canvas API token and sync bookkeeping.
--
-- PRIVACY (PRODUCT-V1 §7.3): Canvas tokens are encrypted at rest
-- (AES-256-GCM, key = env CANVAS_TOKEN_KEY, blob format
-- "iv.ciphertext.authTag" base64 segments — see apps/api/src/lib/canvas.ts).
-- Disconnecting deletes the connection row AND the derived pending/scheduled
-- canvas tasks (completed history stays).

-- ------------------------------------------------------- canvas_connections
create table if not exists canvas_connections (
  user_id uuid primary key references users(id) on delete cascade,
  base_url text not null default 'https://rutgers.instructure.com',
  -- ============================================================ LOUD WARNING
  -- token_encrypted must NEVER appear in any endpoint response. Every API
  -- select on this table must enumerate columns and exclude it; never
  -- select('*') this table into anything a client can see. The value is an
  -- AES-256-GCM blob, so even a leak does not expose the raw token without
  -- CANVAS_TOKEN_KEY — but the blob itself is still treated as a secret.
  -- ==========================================================================
  token_encrypted text not null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  sync_error text
);

-- ---------------------------------------------------------------------- RLS
alter table canvas_connections enable row level security;

-- Owner-only SELECT. All writes go through the API service role (bypasses
-- RLS). This policy is safe even though the row contains token_encrypted:
--   1. only the row's owner can ever match it (auth.uid() = user_id), and the
--      owner already knows their own Canvas token — there is nothing to leak
--      to them;
--   2. the API never selects token_encrypted back to clients anyway (see the
--      loud warning above — endpoints enumerate columns and exclude it).
drop policy if exists canvas_connections_owner_select on canvas_connections;
create policy canvas_connections_owner_select on canvas_connections
  for select to authenticated
  using (auth.uid() = user_id);

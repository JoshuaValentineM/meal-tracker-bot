create table if not exists public.whatsapp_auth_state (
  session_id text not null,
  key_type text not null,
  key_id text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (session_id, key_type, key_id)
);

alter table public.whatsapp_auth_state enable row level security;

revoke all on public.whatsapp_auth_state from anon;
revoke all on public.whatsapp_auth_state from authenticated;

grant select, insert, update, delete
on public.whatsapp_auth_state
to service_role;

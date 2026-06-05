create table if not exists nutrition_targets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sender_jid text not null unique,
  sender_name text,
  calories int4,
  protein_g int4,
  carbs_g int4,
  fiber_g int4,
  deleted_at timestamptz
);

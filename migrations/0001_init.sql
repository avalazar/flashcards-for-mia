create extension if not exists pgcrypto;   -- for gen_random_uuid()

create table users (
  id uuid primary key default gen_random_uuid(),
  username      text not null,            -- stored as typed, matched case-insensitively
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Uniqueness ignores case, so "Mia" and "mia" cannot both be registered, while the
-- username is still displayed back with the capitalisation the user chose.
create unique index users_username_lower_idx on users (lower(username));

-- Only the sha256 hash of the cookie token is stored, never the token itself.
create table sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table study_sets (
  id uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index study_sets_user_updated_idx on study_sets (user_id, updated_at desc);

create table cards (
  id uuid primary key default gen_random_uuid(),
  set_id     uuid not null references study_sets(id) on delete cascade,
  term       text not null,
  definition text not null,
  position   int  not null
);
create index cards_set_position_idx on cards (set_id, position);

-- Recorded now so "study missed cards", stats and future study games need no migration.
create table card_progress (
  card_id         uuid not null references cards(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  correct_count   int not null default 0,
  incorrect_count int not null default 0,
  box             int not null default 1,   -- Leitner box, reserved for spaced repetition
  last_seen_at    timestamptz,
  primary key (card_id, user_id)
);

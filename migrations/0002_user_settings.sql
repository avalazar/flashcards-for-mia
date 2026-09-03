-- Per-user preferences. Stored as a single jsonb column rather than one column per
-- setting, so adding a preference later needs no migration; the server whitelists the
-- keys it will accept, so this cannot become a dumping ground.
alter table users add column settings jsonb not null default '{}'::jsonb;

-- Starring lives on the card rather than in card_progress: study sets are private to
-- one owner, so a card has exactly one user who could star it, and this avoids needing
-- a progress row to exist before a card can be starred.
alter table cards add column starred boolean not null default false;

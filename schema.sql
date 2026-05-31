-- ============================================================
--  Meeting Room Booking — database schema (Neon / Postgres)
--  Run ONCE in the Neon SQL editor after creating the database.
-- ============================================================

create extension if not exists btree_gist;

create table if not exists bookings (
  id            bigint generated always as identity primary key,
  ref           text        not null unique,
  room          text        not null,          -- room id, e.g. 'area3'
  booker_name   text        not null,
  booker_email  text        not null,
  attendees     text,
  purpose       text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        text        not null default 'confirmed',  -- 'confirmed' | 'cancelled'
  created_at    timestamptz not null default now(),
  during        tstzrange   generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  constraint valid_window check (ends_at > starts_at),

  -- THE BLOCKING RULE — only CONFIRMED bookings block. Cancelling frees the slot.
  constraint no_overlap exclude using gist (room with =, during with &&)
    where (status = 'confirmed')
);

create index if not exists idx_bookings_room_start on bookings (room, starts_at);
create index if not exists idx_bookings_status on bookings (status);

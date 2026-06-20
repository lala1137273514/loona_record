create extension if not exists pgcrypto;

create table if not exists public.recording_cases (
  id uuid primary key default gen_random_uuid(),
  uid text not null,
  username text not null,
  label text not null check (label in ('real_pos', 'real_neg')),
  prompt_key text not null,
  prompt_text text not null,
  storage_bucket text not null default 'loona-recordings',
  storage_path text not null unique,
  duration_ms integer not null check (duration_ms > 0),
  sample_rate integer not null default 16000,
  channels integer not null default 1,
  mime_type text not null default 'audio/wav',
  client_created_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists recording_cases_created_at_idx
  on public.recording_cases (created_at desc);

create index if not exists recording_cases_uid_idx
  on public.recording_cases (uid);

create index if not exists recording_cases_label_idx
  on public.recording_cases (label);

alter table public.recording_cases enable row level security;

drop policy if exists "recording_cases_anon_insert" on public.recording_cases;
create policy "recording_cases_anon_insert"
  on public.recording_cases
  for insert
  to anon
  with check (
    storage_bucket = 'loona-recordings'
    and label in ('real_pos', 'real_neg')
    and sample_rate = 16000
    and channels = 1
    and mime_type = 'audio/wav'
    and storage_path like label || '/%'
  );

grant usage on schema public to anon;
grant insert on table public.recording_cases to anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('loona-recordings', 'loona-recordings', false, 10485760, array['audio/wav'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "loona_recordings_anon_insert" on storage.objects;
create policy "loona_recordings_anon_insert"
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'loona-recordings'
    and (storage.foldername(name))[1] in ('real_pos', 'real_neg')
  );

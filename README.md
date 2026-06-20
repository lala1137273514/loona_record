# Loona Record

Lightweight collaborative recording app for Loona wake-word cases.

## Features

- Contributor page: username + browser-local uid, prompt list, record/preview/upload.
- Audio format: 16 kHz mono PCM16 WAV.
- Supabase Storage bucket: `loona-recordings`.
- Supabase table: `public.recording_cases`.
- Admin page: `/admin`, token-protected summary and `collected.zip` export.

## Required Vercel Environment Variables

```bash
NEXT_PUBLIC_SUPABASE_URL=https://btjpgadfxrxfytillsod.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_cU6PcpNT76-sIhFHsEKAww_AKyjL2oS
SUPABASE_SERVICE_ROLE_KEY=<copy from Supabase Dashboard -> Project Settings -> API>
ADMIN_EXPORT_TOKEN=<choose a private export token>
```

`SUPABASE_SERVICE_ROLE_KEY` and `ADMIN_EXPORT_TOKEN` must be server-only secrets.

## Local Development

```bash
pnpm install
pnpm dev
```

## Checks

```bash
pnpm test:run
pnpm typecheck
pnpm build
```

## Supabase

Migration file: `supabase/migrations/20260620_loona_recording_cases.sql`.

The current Supabase project already has the table, private bucket, and anonymous insert policies applied.

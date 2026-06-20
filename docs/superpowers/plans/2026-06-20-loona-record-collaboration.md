# Loona Record Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a lightweight collaborative Loona recording web app with Supabase-backed uploads and admin export.

**Architecture:** A Next.js App Router application provides a contributor recorder UI and admin UI. Browser clients upload WAV files directly to Supabase Storage using a publishable key, while server-only admin API routes use `SUPABASE_SERVICE_ROLE_KEY` to summarize and export all cases as `collected.zip`.

**Tech Stack:** Next.js, React, TypeScript, Vitest, Supabase Postgres, Supabase Storage, JSZip, Vercel.

---

## File Structure

- `package.json`: scripts and dependencies.
- `tsconfig.json`, `next.config.ts`, `vitest.config.ts`: TypeScript, Next, and test config.
- `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/admin/page.tsx`, `src/app/globals.css`: App Router pages and styling.
- `src/components/RecorderApp.tsx`: contributor recording workflow.
- `src/components/AdminApp.tsx`: admin summary and export workflow.
- `src/lib/audio/wav.ts`: PCM16 WAV encoder and 16 kHz downsampling.
- `src/lib/audio/wav.test.ts`: TDD coverage for audio encoding.
- `src/lib/cases.ts`: prompt list, labels, storage path, export filename, manifest helpers.
- `src/lib/cases.test.ts`: TDD coverage for case helpers.
- `src/lib/supabase/client.ts`: browser Supabase client.
- `src/lib/supabase/server.ts`: lazy server Supabase service client.
- `src/lib/admin.ts`: admin token validation.
- `src/app/api/admin/summary/route.ts`: admin summary API.
- `src/app/api/admin/export/route.ts`: admin zip export API.
- `supabase/migrations/20260620_loona_recording_cases.sql`: table, bucket, RLS, and storage policies.
- `.env.example`: required environment variable names.
- `.gitignore`: local/env/build ignores.

## Task 1: Scaffold Next.js Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next-env.d.ts`
- Create: `next.config.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`

- [ ] Add project metadata, scripts, and dependencies.
- [ ] Add TypeScript and Vitest config.
- [ ] Add baseline layout and global CSS.
- [ ] Run dependency install.
- [ ] Commit scaffold.

## Task 2: Implement Audio Utilities with TDD

**Files:**
- Create: `src/lib/audio/wav.test.ts`
- Create: `src/lib/audio/wav.ts`

- [ ] Write failing tests proving WAV output is RIFF/WAVE, mono, 16 kHz, PCM16.
- [ ] Run `pnpm test src/lib/audio/wav.test.ts --run` and confirm tests fail because implementation is missing.
- [ ] Implement `downsampleFloat32ToMono16k()` and `encodePcm16Wav()`.
- [ ] Run `pnpm test src/lib/audio/wav.test.ts --run` and confirm tests pass.
- [ ] Commit audio utilities.

## Task 3: Implement Case Helpers with TDD

**Files:**
- Create: `src/lib/cases.test.ts`
- Create: `src/lib/cases.ts`

- [ ] Write failing tests for storage path format, export filename format, CSV escaping, and prompt defaults.
- [ ] Run `pnpm test src/lib/cases.test.ts --run` and confirm tests fail because implementation is missing.
- [ ] Implement prompts, label types, path generation, filename generation, and manifest CSV generation.
- [ ] Run `pnpm test src/lib/cases.test.ts --run` and confirm tests pass.
- [ ] Commit case helpers.

## Task 4: Implement Supabase Migration

**Files:**
- Create: `supabase/migrations/20260620_loona_recording_cases.sql`

- [ ] Create `public.recording_cases`.
- [ ] Create `loona-recordings` bucket.
- [ ] Enable RLS.
- [ ] Add anonymous insert-only policies for table and Storage.
- [ ] Apply migration to Supabase project `btjpgadfxrxfytillsod`.
- [ ] Verify table and bucket exist.
- [ ] Commit migration.

## Task 5: Implement Supabase Clients and Admin APIs

**Files:**
- Create: `src/lib/supabase/client.ts`
- Create: `src/lib/supabase/server.ts`
- Create: `src/lib/admin.ts`
- Create: `src/app/api/admin/summary/route.ts`
- Create: `src/app/api/admin/export/route.ts`

- [ ] Implement browser client using public env vars.
- [ ] Implement lazy server service client using server-only env vars.
- [ ] Implement admin token validation.
- [ ] Implement summary route.
- [ ] Implement export route using JSZip.
- [ ] Run unit tests and build.
- [ ] Commit API implementation.

## Task 6: Implement Contributor UI

**Files:**
- Create: `src/components/RecorderApp.tsx`
- Modify: `src/app/page.tsx`

- [ ] Build username and uid persistence.
- [ ] Build prompt checklist and label selector.
- [ ] Build Web Audio recording, playback, WAV conversion, Storage upload, and metadata insert.
- [ ] Show session counts, latest status, and errors.
- [ ] Run tests and build.
- [ ] Commit contributor UI.

## Task 7: Implement Admin UI

**Files:**
- Create: `src/components/AdminApp.tsx`
- Create: `src/app/admin/page.tsx`

- [ ] Build token input.
- [ ] Fetch and render summary.
- [ ] Trigger export download.
- [ ] Show invalid token and server error states.
- [ ] Run tests and build.
- [ ] Commit admin UI.

## Task 8: Verify and Deploy

**Files:**
- Modify only if verification finds defects.

- [ ] Run full unit tests.
- [ ] Run production build.
- [ ] Start local dev server and verify pages load.
- [ ] Configure Vercel environment variables.
- [ ] Deploy to Vercel production.
- [ ] Verify production page, upload, Supabase row/object, summary, and export.
- [ ] Commit any deployment config changes.

## Known External Requirements

- `SUPABASE_SERVICE_ROLE_KEY` must be supplied as a Vercel server-only environment variable. It is intentionally not available from the Supabase connector.
- Vercel CLI may require the owner to log in through the OAuth device flow.

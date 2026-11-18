-- Run in Supabase SQL Editor to ensure rhythm tag support is configured.

create extension if not exists pgcrypto;

create table if not exists public.rhythm_tags (
    id uuid primary key default gen_random_uuid(),
    rhythm_id uuid not null references public.rhythms(id) on delete cascade,
    tag text not null check (length(trim(tag)) > 0),
    created_at timestamptz not null default now(),
    unique (rhythm_id, tag)
);

alter table public.rhythm_tags enable row level security;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'rhythm_tags'
          and policyname = 'rhythm_tags_select_all'
    ) then
        create policy rhythm_tags_select_all
            on public.rhythm_tags
            for select
            using (true);
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = 'public'
          and tablename = 'rhythm_tags'
          and policyname = 'rhythm_tags_insert_authenticated'
    ) then
        create policy rhythm_tags_insert_authenticated
            on public.rhythm_tags
            for insert
            to authenticated
            with check (true);
    end if;
end $$;

-- Optional (if you want logged-in users to edit/delete tags):
-- do $$ begin
--   if not exists (
--     select 1 from pg_policies
--     where schemaname='public' and tablename='rhythm_tags' and policyname='rhythm_tags_update_authenticated'
--   ) then
--     create policy rhythm_tags_update_authenticated on public.rhythm_tags for update to authenticated using (true) with check (true);
--   end if;
-- end $$;
--
-- do $$ begin
--   if not exists (
--     select 1 from pg_policies
--     where schemaname='public' and tablename='rhythm_tags' and policyname='rhythm_tags_delete_authenticated'
--   ) then
--     create policy rhythm_tags_delete_authenticated on public.rhythm_tags for delete to authenticated using (true);
--   end if;
-- end $$;


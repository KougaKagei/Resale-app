-- 仕入れ帳のデータベース設定。Supabase の「SQL Editor」に全部貼り付けて「Run」を押す。
-- 何度実行しても壊れないように書いてある。

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.comps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.items enable row level security;
alter table public.comps enable row level security;
alter table public.settings enable row level security;

-- 自分のデータだけ読める・書ける
drop policy if exists "own items" on public.items;
create policy "own items" on public.items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own comps" on public.comps;
create policy "own comps" on public.comps for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 写真の保存場所（非公開）。各ユーザーは自分のフォルダ（ユーザーID）だけ使える
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "own photos read" on storage.objects;
create policy "own photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own photos insert" on storage.objects;
create policy "own photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own photos update" on storage.objects;
create policy "own photos update" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own photos delete" on storage.objects;
create policy "own photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

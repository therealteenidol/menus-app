-- =====================================================================
-- Menús en familia: base de datos para Supabase (Postgres)
-- Cómo usarlo: Supabase > SQL Editor > New query > pega todo > Run.
-- Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- ---------- Tablas ----------

create table if not exists public.families (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  invite_code  text not null unique,
  ai_model     text not null default 'claude-opus-5-5',
  servings     int  not null default 0 check (servings between 0 and 20), -- 0 = tantas como miembros
  meals        text[] not null default '{comida,cena}',
  tips         text not null default '',
  api_key_hint text,                          -- solo "sk-ant-…abcd" para mostrar; la key va cifrada en family_secrets
  created_at   timestamptz not null default now()
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null default '',
  notes      text not null default '',       -- p.ej. "vegetariana", "niño de 5 años"
  family_id  uuid references public.families on delete set null,
  role       text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);
create index if not exists profiles_family_idx on public.profiles (family_id);

-- API key de Claude cifrada. Sin políticas RLS: solo la Edge Function (service role) puede leerla.
create table if not exists public.family_secrets (
  family_id   uuid primary key references public.families on delete cascade,
  api_key_enc text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.preferences (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles on delete cascade,
  kind       text not null check (kind in ('like','dislike','allergy')),
  item       text not null check (char_length(item) between 1 and 120),
  created_at timestamptz not null default now(),
  unique (user_id, item)
);

create table if not exists public.menu_items (
  id          bigint generated always as identity primary key,
  family_id   uuid not null references public.families on delete cascade,
  week_start  date not null,                -- lunes de la semana
  day         smallint not null check (day between 0 and 6),  -- 0 = lunes
  meal        text not null check (meal in ('desayuno','comida','cena')),
  dish        text not null default '',
  notes       text not null default '',
  ingredients jsonb,                        -- [{name, quantity, section}] o null si faltan por calcular
  updated_at  timestamptz not null default now(),
  unique (family_id, week_start, day, meal)
);

create table if not exists public.shopping_items (
  id         bigint generated always as identity primary key,
  family_id  uuid not null references public.families on delete cascade,
  name       text not null check (char_length(name) between 1 and 150),
  quantity   text not null default '',
  section    text not null default 'Otros',
  checked    boolean not null default false,
  source     text not null default 'manual' check (source in ('menu','manual')),
  created_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shopping_family_idx on public.shopping_items (family_id);

-- ---------- Utilidades ----------

create or replace function public.my_family_id()
returns uuid language sql stable security definer set search_path = public as $$
  select family_id from public.profiles where id = auth.uid()
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists menu_items_touch on public.menu_items;
create trigger menu_items_touch before update on public.menu_items
  for each row execute function public.touch_updated_at();
drop trigger if exists shopping_items_touch on public.shopping_items;
create trigger shopping_items_touch before update on public.shopping_items
  for each row execute function public.touch_updated_at();

-- Crea el perfil automáticamente al registrarse
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.random_invite_code()
returns text language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.families where invite_code = code);
  end loop;
  return code;
end $$;

-- ---------- Seguridad (RLS): cada familia solo ve lo suyo ----------

alter table public.families       enable row level security;
alter table public.profiles       enable row level security;
alter table public.family_secrets enable row level security;
alter table public.preferences    enable row level security;
alter table public.menu_items     enable row level security;
alter table public.shopping_items enable row level security;

drop policy if exists families_select on public.families;
create policy families_select on public.families for select to authenticated
  using (id = public.my_family_id());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or (family_id is not null and family_id = public.my_family_id()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Cada uno solo puede cambiar su nombre y notas (no la familia ni el rol)
revoke update on public.profiles from authenticated, anon;
grant update (name, notes) on public.profiles to authenticated;

revoke all on public.family_secrets from authenticated, anon;

drop policy if exists preferences_all on public.preferences;
create policy preferences_all on public.preferences for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = preferences.user_id and p.family_id = public.my_family_id()))
  with check (exists (select 1 from public.profiles p where p.id = preferences.user_id and p.family_id = public.my_family_id()));

drop policy if exists menu_items_all on public.menu_items;
create policy menu_items_all on public.menu_items for all to authenticated
  using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());

drop policy if exists shopping_items_all on public.shopping_items;
create policy shopping_items_all on public.shopping_items for all to authenticated
  using (family_id = public.my_family_id()) with check (family_id = public.my_family_id());

-- ---------- Funciones que llama la app ----------

create or replace function public.create_family(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Tienes que iniciar sesión'; end if;
  if public.my_family_id() is not null then raise exception 'Ya perteneces a una familia'; end if;
  insert into public.families (name, invite_code)
  values (coalesce(nullif(trim(p_name), ''), 'Mi familia'), public.random_invite_code())
  returning id into fid;
  update public.profiles set family_id = fid, role = 'admin' where id = auth.uid();
  return fid;
end $$;

create or replace function public.family_name_for_code(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select name from public.families where invite_code = upper(trim(p_code))
$$;

create or replace function public.join_family(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception 'Tienes que iniciar sesión'; end if;
  if public.my_family_id() is not null then raise exception 'Ya perteneces a una familia. Sal de ella primero.'; end if;
  select id into fid from public.families where invite_code = upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'));
  if fid is null then raise exception 'Ese código de invitación no existe'; end if;
  update public.profiles set family_id = fid, role = 'member' where id = auth.uid();
  return fid;
end $$;

create or replace function public.leave_family()
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid := public.my_family_id();
begin
  if fid is null then return; end if;
  update public.profiles set family_id = null, role = 'member' where id = auth.uid();
  if not exists (select 1 from public.profiles where family_id = fid) then
    delete from public.families where id = fid;          -- último miembro: se borra todo
  elsif not exists (select 1 from public.profiles where family_id = fid and role = 'admin') then
    update public.profiles set role = 'admin'
     where id = (select id from public.profiles where family_id = fid order by created_at limit 1);
  end if;
end $$;

create or replace function public.assert_admin()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare fid uuid;
begin
  select family_id into fid from public.profiles where id = auth.uid() and role = 'admin';
  if fid is null then raise exception 'Solo el administrador de la familia puede hacer esto'; end if;
  return fid;
end $$;

create or replace function public.update_family(p_name text, p_ai_model text, p_servings int, p_meals text[])
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid := public.assert_admin();
begin
  if p_ai_model not in ('claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5') then raise exception 'Modelo no válido'; end if;
  if p_meals is null or cardinality(p_meals) = 0 or not (p_meals <@ array['desayuno','comida','cena']) then
    raise exception 'Elige al menos una comida del día';
  end if;
  update public.families
     set name = coalesce(nullif(trim(p_name), ''), name),
         ai_model = p_ai_model,
         servings = greatest(0, least(20, coalesce(p_servings, 0))),
         meals = p_meals
   where id = fid;
end $$;

-- Los tips para la IA los puede editar cualquier miembro
create or replace function public.update_family_tips(p_tips text)
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid := public.my_family_id();
begin
  if fid is null then raise exception 'No perteneces a ninguna familia'; end if;
  update public.families set tips = left(coalesce(p_tips, ''), 3000) where id = fid;
end $$;

create or replace function public.regenerate_invite_code()
returns text language plpgsql security definer set search_path = public as $$
declare fid uuid := public.assert_admin(); code text := public.random_invite_code();
begin
  update public.families set invite_code = code where id = fid;
  return code;
end $$;

create or replace function public.remove_member(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid := public.assert_admin();
begin
  if p_user = auth.uid() then raise exception 'Para salir tú, usa "Salir de la familia"'; end if;
  update public.profiles set family_id = null, role = 'member' where id = p_user and family_id = fid;
end $$;

create or replace function public.make_admin(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fid uuid := public.assert_admin();
begin
  update public.profiles set role = 'admin' where id = p_user and family_id = fid;
end $$;

revoke execute on function public.create_family(text), public.family_name_for_code(text), public.join_family(text),
  public.leave_family(), public.update_family(text, text, int, text[]), public.update_family_tips(text),
  public.regenerate_invite_code(), public.remove_member(uuid), public.make_admin(uuid) from anon, public;
grant execute on function public.create_family(text), public.family_name_for_code(text), public.join_family(text),
  public.leave_family(), public.update_family(text, text, int, text[]), public.update_family_tips(text),
  public.regenerate_invite_code(), public.remove_member(uuid), public.make_admin(uuid) to authenticated;

-- ---------- Tiempo real: los cambios de un miembro aparecen al instante en los demás ----------

do $$
declare t text;
begin
  foreach t in array array['families','profiles','preferences','menu_items','shopping_items'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

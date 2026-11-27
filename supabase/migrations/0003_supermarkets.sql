-- =====================================================================
-- Supermercados de la familia (para el futuro agente de compra).
--
-- - public.supermarkets: nombre, web y usuario. La ve toda la familia,
--   pero nadie puede cambiarla desde el navegador: se guarda a través de
--   la Edge Function "ai" (solo el administrador de la familia).
-- - public.supermarket_secrets: la contraseña CIFRADA (AES-GCM, la misma
--   clave APP_ENCRYPTION_KEY que la API key de Claude). Sin permisos para
--   el navegador: solo el rol de servicio (la Edge Function y, más
--   adelante, el agente de compra) puede leerla.
--
-- Se puede ejecutar varias veces sin romper nada.
-- =====================================================================

create table if not exists public.supermarkets (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  url          text not null check (url ~* '^https?://' and char_length(url) <= 300),
  username     text not null default '' check (char_length(username) <= 200),
  has_password boolean not null default false,   -- solo dice SI hay contraseña, nunca cuál
  is_main      boolean not null default false,   -- supermercado principal de la familia
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists supermarkets_family_idx on public.supermarkets (family_id);
-- Como mucho un supermercado principal por familia
create unique index if not exists supermarkets_one_main on public.supermarkets (family_id) where is_main;

create table if not exists public.supermarket_secrets (
  supermarket_id uuid primary key references public.supermarkets on delete cascade,
  password_enc   text not null,
  updated_at     timestamptz not null default now()
);

drop trigger if exists supermarkets_touch on public.supermarkets;
create trigger supermarkets_touch before update on public.supermarkets
  for each row execute function public.touch_updated_at();

alter table public.supermarkets        enable row level security;
alter table public.supermarket_secrets enable row level security;

-- La familia puede VER sus supermercados (sin contraseñas)
drop policy if exists supermarkets_select on public.supermarkets;
create policy supermarkets_select on public.supermarkets for select to authenticated
  using (family_id = public.my_family_id());

grant select on public.supermarkets to authenticated;
revoke insert, update, delete on public.supermarkets from anon, authenticated;
revoke all on public.supermarkets from anon;

-- Las contraseñas nunca son accesibles desde el navegador
revoke all on public.supermarket_secrets from anon, authenticated;

-- La Edge Function (rol de servicio) guarda y lee todo
grant all on public.supermarkets, public.supermarket_secrets to service_role;

-- Cambios en vivo en los móviles de la familia
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'supermarkets') then
    alter publication supabase_realtime add table public.supermarkets;
  end if;
end $$;

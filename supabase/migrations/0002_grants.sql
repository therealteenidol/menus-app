-- =====================================================================
-- Permisos de las tablas para la app (necesario en proyectos de Supabase
-- creados sin permisos automáticos en el esquema public).
-- Arregla el error "permission denied for table profiles".
-- Se puede ejecutar varias veces. Las reglas RLS siguen decidiendo qué filas ve cada familia.
-- =====================================================================

grant usage on schema public to anon, authenticated, service_role;

-- Usuarios con sesión iniciada (las políticas RLS limitan a su familia)
grant select on public.families to authenticated;
grant select on public.profiles to authenticated;
grant update (name, notes) on public.profiles to authenticated;
grant select, insert, update, delete on public.preferences, public.menu_items, public.shopping_items to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.my_family_id() to authenticated;

-- La Edge Function "ai" usa el rol de servicio (API key cifrada, pista de la key)
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- La API key cifrada nunca es accesible desde el navegador
revoke all on public.family_secrets from anon, authenticated;

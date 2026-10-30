-- Alcancía inteligente de colones: datos, seguridad y saldo.

create table public.alcancias (
  id uuid primary key default gen_random_uuid(),
  propietario uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nombre text not null default 'Mi alcancía',
  meta_colones integer not null default 10000 check (meta_colones > 0),
  creada_en timestamptz not null default now()
);

-- Sin políticas: solo la Edge Function, con la clave de servicio, puede leerla.
create table public.dispositivos (
  codigo text primary key,
  alcancia_id uuid not null unique references public.alcancias (id) on delete cascade,
  clave_hash text not null
);

create table public.eventos (
  id text primary key,  -- Lo genera el origen; evita duplicados en reintentos
  alcancia_id uuid not null references public.alcancias (id) on delete cascade,
  tipo text not null check (tipo in ('deposito', 'rechazo', 'apertura', 'retiro')),
  denominacion integer check (denominacion in (10, 25, 50, 100, 500)),
  cantidad integer not null default 1 check (cantidad > 0),
  peso_g numeric(6, 2),  -- Se guarda crudo para poder recalibrar después
  origen text not null default 'dispositivo' check (origen in ('dispositivo', 'app')),
  ocurrido_en timestamptz not null default now(),
  check ((tipo in ('deposito', 'retiro')) = (denominacion is not null))
);

create index eventos_alcancia_fecha on public.eventos (alcancia_id, ocurrido_en desc);

create table public.comandos (
  id uuid primary key default gen_random_uuid(),
  alcancia_id uuid not null references public.alcancias (id) on delete cascade,
  tipo text not null default 'abrir' check (tipo = 'abrir'),
  creado_en timestamptz not null default now(),
  atendido_en timestamptz
);

create view public.saldo_por_denominacion with (security_invoker = true) as
select
  alcancia_id,
  denominacion,
  sum(case tipo when 'deposito' then cantidad else -cantidad end)::integer as cantidad,
  sum(case tipo when 'deposito' then cantidad else -cantidad end)::integer * denominacion as colones
from public.eventos
where tipo in ('deposito', 'retiro')
group by alcancia_id, denominacion;

-- El saldo no puede quedar negativo si alguien declara retirar de más.
create function public.validar_retiro() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  disponibles integer;
begin
  select coalesce(sum(case tipo when 'deposito' then cantidad else -cantidad end), 0)
    into disponibles
    from public.eventos
   where alcancia_id = new.alcancia_id
     and denominacion = new.denominacion
     and tipo in ('deposito', 'retiro');

  if new.cantidad > disponibles then
    raise exception 'Solo hay % monedas de % colones', disponibles, new.denominacion
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger validar_retiro before insert on public.eventos
for each row when (new.tipo = 'retiro') execute function public.validar_retiro();

-- Crea la alcancía y devuelve una sola vez la clave que se graba en el ESP32.
create function public.crear_alcancia(p_nombre text, p_meta_colones integer)
returns table (alcancia_id uuid, codigo text, clave text)
language plpgsql security definer set search_path = '' as $$
declare
  nueva_id uuid;
  nuevo_codigo text := 'alcancia-' || encode(extensions.gen_random_bytes(3), 'hex');
  nueva_clave text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501';
  end if;

  insert into public.alcancias (propietario, nombre, meta_colones)
  values (auth.uid(), p_nombre, p_meta_colones)
  returning id into nueva_id;

  insert into public.dispositivos (codigo, alcancia_id, clave_hash)
  values (nuevo_codigo, nueva_id, encode(extensions.digest(nueva_clave, 'sha256'), 'hex'));

  return query select nueva_id, nuevo_codigo, nueva_clave;
end;
$$;

revoke execute on function public.crear_alcancia(text, integer) from public, anon;
grant execute on function public.crear_alcancia(text, integer) to authenticated;
revoke execute on function public.validar_retiro() from public, anon, authenticated;

alter table public.alcancias enable row level security;
alter table public.dispositivos enable row level security;
alter table public.eventos enable row level security;
alter table public.comandos enable row level security;

create policy "propietario lee sus alcancías" on public.alcancias
  for select to authenticated using (propietario = auth.uid());

create policy "propietario edita sus alcancías" on public.alcancias
  for update to authenticated using (propietario = auth.uid()) with check (propietario = auth.uid());

create policy "propietario lee sus eventos" on public.eventos
  for select to authenticated
  using (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

-- Desde la app solo se registran retiros; los depósitos vienen del dispositivo.
create policy "propietario registra retiros" on public.eventos
  for insert to authenticated
  with check (
    tipo = 'retiro' and origen = 'app'
    and exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid())
  );

create policy "propietario lee sus comandos" on public.comandos
  for select to authenticated
  using (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

create policy "propietario crea comandos" on public.comandos
  for insert to authenticated
  with check (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

grant select on public.saldo_por_denominacion to authenticated;

alter publication supabase_realtime add table public.eventos;

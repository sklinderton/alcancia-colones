-- Datos de usabilidad para las preguntas de IPM: cuánto tarda cada persona en
-- las tareas de la app y qué opina de ella (cuestionario SUS).

-- Una fila por tarea empezada en la app: si se terminó o se canceló, cuánto
-- tardó y cuántos ajustes (toques de − y +, números escritos) necesitó.
create table public.interacciones (
  id uuid primary key default gen_random_uuid(),
  alcancia_id uuid not null references public.alcancias (id) on delete cascade,
  accion text not null check (accion in ('echar_dinero', 'hacer_retiro', 'cambiar_meta')),
  resultado text not null check (resultado in ('completada', 'cancelada')),
  duracion_ms integer not null check (duracion_ms between 0 and 3600000),
  ajustes integer not null default 0 check (ajustes between 0 and 10000),
  ocurrido_en timestamptz not null default now()
);

create index interacciones_alcancia_fecha on public.interacciones (alcancia_id, ocurrido_en);

-- Cuestionario SUS: 10 respuestas de 1 (totalmente en desacuerdo) a 5 (totalmente de acuerdo)
create table public.encuestas (
  id uuid primary key default gen_random_uuid(),
  alcancia_id uuid not null references public.alcancias (id) on delete cascade,
  respuestas smallint[] not null check (
    array_length(respuestas, 1) = 10 and 1 <= all (respuestas) and 5 >= all (respuestas)
  ),
  comentario text check (char_length(comentario) <= 1000),
  creada_en timestamptz not null default now()
);

alter table public.interacciones enable row level security;
alter table public.encuestas enable row level security;

create policy "propietario registra sus interacciones" on public.interacciones
  for insert to authenticated
  with check (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

create policy "propietario lee sus interacciones" on public.interacciones
  for select to authenticated
  using (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

create policy "propietario responde la encuesta" on public.encuestas
  for insert to authenticated
  with check (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

create policy "propietario lee sus encuestas" on public.encuestas
  for select to authenticated
  using (exists (select 1 from public.alcancias a where a.id = alcancia_id and a.propietario = auth.uid()));

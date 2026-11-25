-- Billetes en circulación: los registra el lector de billetes del dispositivo,
-- igual que el monedero. La app sigue sin poder inventar depósitos.

alter table public.eventos drop constraint if exists eventos_denominacion_check;
alter table public.eventos add constraint eventos_denominacion_check
  check (denominacion in (10, 25, 50, 100, 500, 1000, 2000, 5000, 10000, 20000));

-- Mismo control de retiros, con un mensaje que sirve para monedas y billetes.
create or replace function public.validar_retiro() returns trigger
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
    raise exception 'Solo hay % de % colones', disponibles, new.denominacion
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.validar_retiro() from public, anon, authenticated;

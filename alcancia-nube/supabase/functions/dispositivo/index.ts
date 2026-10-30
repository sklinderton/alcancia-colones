// Puerta de entrada del ESP32: guarda sus eventos y le devuelve el saldo y las
// órdenes pendientes. El dispositivo nunca recibe la clave de servicio.
import { createClient } from "npm:@supabase/supabase-js@2";

const DENOMINACIONES = [10, 25, 50, 100, 500];
const TIPOS_DISPOSITIVO = ["deposito", "rechazo", "apertura"];
const MAX_EVENTOS = 20;
const VIGENCIA_ORDEN_MS = 60_000; // Una orden vieja no debe abrir la alcancía

type EventoEntrante = {
  id: string;
  tipo: string;
  denominacion?: number;
  peso_g?: number;
  ocurrido_en?: string;
};

const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { "Content-Type": "application/json" },
  });

async function sha256(texto: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function eventoValido(evento: EventoEntrante) {
  if (typeof evento?.id !== "string" || evento.id.length === 0 || evento.id.length > 64) return false;
  if (!TIPOS_DISPOSITIVO.includes(evento.tipo)) return false;
  if (evento.ocurrido_en && Number.isNaN(Date.parse(evento.ocurrido_en))) return false;
  return evento.tipo === "deposito"
    ? DENOMINACIONES.includes(evento.denominacion ?? 0)
    : !evento.denominacion;
}

Deno.serve(async (solicitud) => {
  if (solicitud.method !== "POST") return responder({ error: "Método no permitido" }, 405);

  const cuerpo = await solicitud.json().catch(() => null);
  const clave = solicitud.headers.get("x-clave-dispositivo");
  if (!cuerpo?.codigo || !clave) return responder({ error: "Credenciales incompletas" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: dispositivo } = await supabase
    .from("dispositivos")
    .select("alcancia_id, clave_hash")
    .eq("codigo", cuerpo.codigo)
    .maybeSingle();

  if (!dispositivo || dispositivo.clave_hash !== (await sha256(clave))) {
    return responder({ error: "Credenciales inválidas" }, 401);
  }

  const eventos: EventoEntrante[] = cuerpo.eventos ?? [];
  if (!Array.isArray(eventos) || eventos.length > MAX_EVENTOS || !eventos.every(eventoValido)) {
    return responder({ error: "Eventos inválidos" }, 400);
  }

  if (eventos.length > 0) {
    const filas = eventos.map((evento) => ({
      id: evento.id,
      alcancia_id: dispositivo.alcancia_id,
      tipo: evento.tipo,
      denominacion: evento.tipo === "deposito" ? evento.denominacion : null,
      peso_g: evento.peso_g ?? null,
      ocurrido_en: evento.ocurrido_en ?? new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("eventos")
      .upsert(filas, { onConflict: "id", ignoreDuplicates: true });
    if (error) return responder({ error: "No se pudieron guardar los eventos" }, 500);
  }

  const { data: saldo, error: errorSaldo } = await supabase
    .from("saldo_por_denominacion")
    .select("denominacion, cantidad")
    .eq("alcancia_id", dispositivo.alcancia_id);
  if (errorSaldo) return responder({ error: "No se pudo leer el saldo" }, 500);

  const { data: atendidas } = await supabase
    .from("comandos")
    .update({ atendido_en: new Date().toISOString() })
    .eq("alcancia_id", dispositivo.alcancia_id)
    .is("atendido_en", null)
    .gte("creado_en", new Date(Date.now() - VIGENCIA_ORDEN_MS).toISOString())
    .select("id");

  return responder({
    conteo: Object.fromEntries(saldo.map((fila) => [fila.denominacion, fila.cantidad])),
    abrir: (atendidas?.length ?? 0) > 0,
  });
});

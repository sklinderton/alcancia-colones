// Crea o borra una alcancía de prueba para probar el firmware.
// Uso: node pruebas/alcancia_temporal.mjs crear|saldo|borrar <archivo>
// Requiere SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const [accion, archivo] = process.argv.slice(2);
const opciones = { auth: { persistSession: false } };
const administrador = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, opciones);

if (accion === "crear") {
  const email = `prueba-${randomUUID()}@example.test`;
  const password = randomUUID();
  const { data } = await administrador.auth.admin.createUser({ email, password, email_confirm: true });

  const usuario = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, opciones);
  await usuario.auth.signInWithPassword({ email, password });
  const { data: creadas, error } = await usuario.rpc("crear_alcancia", { p_nombre: "Temporal", p_meta_colones: 1000 });
  if (error) throw error;

  writeFileSync(archivo, JSON.stringify({ usuarioId: data.user.id, ...creadas[0] }));
  console.log("Alcancía temporal creada");
}

if (accion === "saldo") {
  const { alcancia_id: alcanciaId } = JSON.parse(readFileSync(archivo, "utf8"));
  const { data: eventos } = await administrador
    .from("eventos")
    .select("id, tipo, denominacion, peso_g, ocurrido_en")
    .eq("alcancia_id", alcanciaId);
  console.log(JSON.stringify(eventos, null, 1));
}

if (accion === "borrar") {
  const { usuarioId } = JSON.parse(readFileSync(archivo, "utf8"));
  const { error } = await administrador.auth.admin.deleteUser(usuarioId);
  if (error) throw error;
  rmSync(archivo);
  console.log("Alcancía temporal borrada");
}

// Prueba la nube: node pruebas/integracion.mjs
// Requiere SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY.
// Crea usuarios temporales confirmados y los borra al terminar.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const URL_BASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const FUNCION = `${URL_BASE}/functions/v1/dispositivo`;

const cliente = () => createClient(URL_BASE, ANON, { auth: { persistSession: false } });
const administrador = createClient(URL_BASE, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const usuariosTemporales = [];

async function crearUsuario() {
  const email = `prueba-${randomUUID()}@example.test`;
  const password = randomUUID();
  const { data, error } = await administrador.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(error, null);
  usuariosTemporales.push(data.user.id);

  const supabase = cliente();
  const { error: errorSesion } = await supabase.auth.signInWithPassword({ email, password });
  assert.equal(errorSesion, null);
  return supabase;
}

const enviar = (codigo, clave, eventos = []) =>
  fetch(FUNCION, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-clave-dispositivo": clave },
    body: JSON.stringify({ codigo, eventos }),
  });

const pruebas = [];
const prueba = (nombre, fn) => pruebas.push([nombre, fn]);

const dueno = await crearUsuario();
const { data: creadas, error: errorCrear } = await dueno.rpc("crear_alcancia", {
  p_nombre: "Prueba",
  p_meta_colones: 5000,
});
assert.equal(errorCrear, null);
const { alcancia_id: alcanciaId, codigo, clave } = creadas[0];

const deposito = (denominacion, peso_g) => ({ id: randomUUID(), tipo: "deposito", denominacion, peso_g });

prueba("rechaza una clave incorrecta", async () => {
  assert.equal((await enviar(codigo, "clave-falsa")).status, 401);
});

prueba("rechaza denominaciones que no circulan", async () => {
  assert.equal((await enviar(codigo, clave, [deposito(5, 1)])).status, 400);
});

prueba("guarda depósitos y devuelve el conteo", async () => {
  const respuesta = await enviar(codigo, clave, [deposito(100, 8.28), deposito(100, 8.33), deposito(500, 10.37)]);
  assert.equal(respuesta.status, 200);
  assert.deepEqual((await respuesta.json()).conteo, { 100: 2, 500: 1 });
});

prueba("un reintento no duplica el evento", async () => {
  const evento = deposito(25, 4.31);
  await enviar(codigo, clave, [evento]);
  const cuerpo = await (await enviar(codigo, clave, [evento])).json();
  assert.equal(cuerpo.conteo[25], 1);
});

prueba("el rechazo no cambia el saldo", async () => {
  const cuerpo = await (await enviar(codigo, clave, [{ id: randomUUID(), tipo: "rechazo", peso_g: 6.71 }])).json();
  assert.deepEqual(cuerpo.conteo, { 25: 1, 100: 2, 500: 1 });
});

prueba("la orden de abrir se entrega una sola vez", async () => {
  const { error } = await dueno.from("comandos").insert({ alcancia_id: alcanciaId });
  assert.equal(error, null);
  assert.equal((await (await enviar(codigo, clave)).json()).abrir, true);
  assert.equal((await (await enviar(codigo, clave)).json()).abrir, false);
});

prueba("el retiro descuenta del saldo", async () => {
  const { error } = await dueno.from("eventos").insert({
    id: randomUUID(), alcancia_id: alcanciaId, tipo: "retiro", origen: "app", denominacion: 100, cantidad: 1,
  });
  assert.equal(error, null);
  assert.equal((await (await enviar(codigo, clave)).json()).conteo[100], 1);
});

prueba("no se puede retirar más de lo que hay", async () => {
  const { error } = await dueno.from("eventos").insert({
    id: randomUUID(), alcancia_id: alcanciaId, tipo: "retiro", origen: "app", denominacion: 500, cantidad: 2,
  });
  assert.match(error?.message ?? "", /Solo hay 1 monedas/);
});

prueba("la app no puede inventar depósitos", async () => {
  const { error } = await dueno.from("eventos").insert({
    id: randomUUID(), alcancia_id: alcanciaId, tipo: "deposito", denominacion: 500,
  });
  assert.ok(error);
});

prueba("otra persona no ve ni controla la alcancía", async () => {
  const otra = await crearUsuario();
  assert.deepEqual((await otra.from("eventos").select("id").eq("alcancia_id", alcanciaId)).data, []);
  assert.deepEqual((await otra.from("saldo_por_denominacion").select("*").eq("alcancia_id", alcanciaId)).data, []);
  assert.ok((await otra.from("comandos").insert({ alcancia_id: alcanciaId })).error);
});

prueba("sin sesión no se lee nada ni se crean alcancías", async () => {
  const anonimo = cliente();
  assert.deepEqual((await anonimo.from("alcancias").select("id")).data ?? [], []);
  assert.deepEqual((await anonimo.from("eventos").select("id")).data ?? [], []);
  assert.ok((await anonimo.rpc("crear_alcancia", { p_nombre: "x", p_meta_colones: 1 })).error);
});

prueba("nadie lee las claves de dispositivos", async () => {
  assert.deepEqual((await dueno.from("dispositivos").select("*")).data ?? [], []);
});

let fallos = 0;
for (const [nombre, fn] of pruebas) {
  try {
    await fn();
    console.log(`ok   ${nombre}`);
  } catch (error) {
    fallos++;
    console.log(`FALLA ${nombre}\n     ${error.message}`);
  }
}
for (const id of usuariosTemporales) {
  await administrador.auth.admin.deleteUser(id);
}

console.log(`\n${pruebas.length - fallos} de ${pruebas.length} pruebas pasaron`);
process.exit(fallos ? 1 : 0);

// Se comporta como el ESP32 para probar la app sin hardware.
// Uso: node pruebas/simular_dispositivo.mjs <url-funcion> <codigo> <clave> [monedas...]
import { randomUUID } from "node:crypto";

const PESOS = { 10: 2.43, 25: 4.3, 50: 5.54, 100: 8.3, 500: 10.5 };
const [url, codigo, clave, ...monedas] = process.argv.slice(2);

const eventos = monedas.map((moneda) => ({
  id: randomUUID(),
  tipo: "deposito",
  denominacion: Number(moneda),
  peso_g: PESOS[moneda],
}));

const respuesta = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-clave-dispositivo": clave },
  body: JSON.stringify({ codigo, eventos }),
});
console.log(respuesta.status, await respuesta.text());

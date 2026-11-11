// Análisis del historial de eventos guardado en la nube y sus gráficos en SVG.
// Los cálculos no tocan el DOM, así que también se prueban con Node.

const DIA_MS = 24 * 60 * 60 * 1000;
const VENTANA_RITMO_DIAS = 28;  // El ritmo de ahorro se mide sobre las últimas 4 semanas
const DIAS_SEMANA = ["L", "K", "M", "J", "V", "S", "D"];
const NOMBRES_DIA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const NOMBRES_DIA_PLURAL = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];

const inicioDelDia = (fecha) => new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
const montoDe = (evento) => evento.denominacion * evento.cantidad;

function calcularAnalisis(eventos, meta, ahora = new Date()) {
  const ordenados = [...eventos].sort((a, b) => new Date(a.ocurrido_en) - new Date(b.ocurrido_en));
  const movimientos = ordenados.filter((e) => e.tipo === "deposito" || e.tipo === "retiro");
  const depositos = ordenados.filter((e) => e.tipo === "deposito");

  const depositado = depositos.reduce((suma, e) => suma + montoDe(e), 0);
  const retirado = movimientos.filter((e) => e.tipo === "retiro").reduce((suma, e) => suma + montoDe(e), 0);
  const saldo = depositado - retirado;

  // Saldo al cierre de cada día, desde el primer movimiento hasta hoy
  const serie = [];
  if (movimientos.length > 0) {
    let acumulado = 0;
    let i = 0;
    const hoy = inicioDelDia(ahora);
    for (let dia = inicioDelDia(new Date(movimientos[0].ocurrido_en)); dia <= hoy; dia = new Date(dia.getTime() + DIA_MS)) {
      const finDelDia = new Date(dia.getTime() + DIA_MS);
      while (i < movimientos.length && new Date(movimientos[i].ocurrido_en) < finDelDia) {
        acumulado += (movimientos[i].tipo === "deposito" ? 1 : -1) * montoDe(movimientos[i]);
        i++;
      }
      serie.push({ fecha: dia, saldo: acumulado });
    }
  }

  // Ritmo neto (depósitos menos retiros) en la ventana, en colones por día
  let ritmoDiario = null;
  if (movimientos.length > 0) {
    const desdeVentana = new Date(ahora.getTime() - VENTANA_RITMO_DIAS * DIA_MS);
    const primero = new Date(movimientos[0].ocurrido_en);
    const desde = primero > desdeVentana ? primero : desdeVentana;
    const dias = Math.max(1, (ahora - desde) / DIA_MS);
    const neto = movimientos
      .filter((e) => new Date(e.ocurrido_en) >= desde)
      .reduce((suma, e) => suma + (e.tipo === "deposito" ? 1 : -1) * montoDe(e), 0);
    ritmoDiario = neto / dias;
  }

  let fechaMeta = null;
  if (saldo < meta && ritmoDiario > 0) {
    fechaMeta = new Date(ahora.getTime() + ((meta - saldo) / ritmoDiario) * DIA_MS);
  }

  // Hábitos: monedas depositadas por día de la semana (lunes primero) y por hora
  const porDia = Array(7).fill(0);
  const porHora = Array(24).fill(0);
  for (const e of depositos) {
    const fecha = new Date(e.ocurrido_en);
    porDia[(fecha.getDay() + 6) % 7] += e.cantidad;
    porHora[fecha.getHours()] += e.cantidad;
  }
  const horaPico = depositos.length > 0 ? porHora.indexOf(Math.max(...porHora)) : null;

  // Monedas devueltas: solo cuentan las que pasaron por el monedero
  const aceptadas = depositos.filter((e) => (e.origen ?? "dispositivo") === "dispositivo")
    .reduce((suma, e) => suma + e.cantidad, 0);
  const devueltas = ordenados.filter((e) => e.tipo === "rechazo").length;
  const tasaDevueltas = aceptadas + devueltas > 0 ? devueltas / (aceptadas + devueltas) : null;

  return {
    saldo, depositado, retirado, serie, ritmoDiario, fechaMeta,
    porDia, horaPico, aceptadas, devueltas, tasaDevueltas,
  };
}

// ---------- Gráficos ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function trazo(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElementNS(SVG_NS, etiqueta);
  for (const [nombre, valor] of Object.entries(atributos)) nodo.setAttribute(nombre, valor);
  nodo.append(...hijos);
  return nodo;
}

const titulo = (texto) => trazo("title", {}, texto);
const fechaDia = (fecha) => fecha.toLocaleDateString("es-CR", { day: "numeric", month: "short" });

// Escala "bonita" para el eje: 1, 2 o 5 por potencia de 10
function pasoEje(maximo, marcas = 3) {
  const crudo = maximo / marcas;
  const potencia = 10 ** Math.floor(Math.log10(crudo));
  const paso = [1, 2, 5, 10].map((m) => m * potencia).find((p) => p >= crudo);
  return paso;
}

// Saldo acumulado por día, la meta como referencia y la proyección punteada
function graficoAhorro({ serie, fechaMeta, saldo }, meta, formato) {
  const ancho = 440, alto = 190;
  const margen = { arriba: 16, derecha: 12, abajo: 26, izquierda: 52 };
  const inicio = serie[0].fecha;
  const hoy = serie[serie.length - 1].fecha;
  const tramo = Math.max(DIA_MS, hoy - inicio);
  // La proyección se dibuja si la meta queda a menos del doble del tiempo ya registrado
  const proyectar = fechaMeta && fechaMeta - hoy <= 2 * tramo;
  const fin = proyectar ? fechaMeta : hoy;

  const maxY = Math.max(meta, ...serie.map((p) => p.saldo));
  const paso = pasoEje(maxY);
  const techo = Math.ceil(maxY / paso) * paso;
  const x = (fecha) => margen.izquierda + ((fecha - inicio) / Math.max(DIA_MS, fin - inicio)) * (ancho - margen.izquierda - margen.derecha);
  const y = (valor) => alto - margen.abajo - (valor / techo) * (alto - margen.arriba - margen.abajo);

  const svg = trazo("svg", { viewBox: `0 0 ${ancho} ${alto}`, class: "grafico", role: "img",
    "aria-label": `Saldo acumulado por día. Hoy: ${formato(saldo)}. Meta: ${formato(meta)}.` });

  for (let valor = 0; valor <= techo; valor += paso) {
    svg.append(
      trazo("line", { x1: margen.izquierda, x2: ancho - margen.derecha, y1: y(valor), y2: y(valor), class: valor === 0 ? "base" : "rejilla" }),
      trazo("text", { x: margen.izquierda - 6, y: y(valor) + 4, "text-anchor": "end", class: "eje" }, formato(valor)));
  }

  svg.append(
    trazo("line", { x1: margen.izquierda, x2: ancho - margen.derecha, y1: y(meta), y2: y(meta), class: "referencia" }),
    trazo("text", { x: margen.izquierda + 4, y: y(meta) - 6, "text-anchor": "start", class: "eje" }, "Meta"));

  const puntos = serie.map((p) => `${x(p.fecha).toFixed(1)},${y(p.saldo).toFixed(1)}`).join(" ");
  svg.append(trazo("polyline", { points: puntos, class: "linea" }));

  if (proyectar) {
    svg.append(
      trazo("line", { x1: x(hoy), y1: y(saldo), x2: x(fechaMeta), y2: y(meta), class: "proyeccion" }),
      trazo("circle", { cx: x(fechaMeta), cy: y(meta), r: 4, class: "punto-hueco" }, titulo(`Meta estimada: ${fechaDia(fechaMeta)}`)));
  }
  svg.append(trazo("circle", { cx: x(hoy), cy: y(saldo), r: 4, class: "punto" }));

  // Zonas invisibles para ver el saldo de cada día al pasar el cursor o tocar
  const anchoDia = (x(hoy) - x(inicio)) / Math.max(1, serie.length - 1);
  for (const p of serie) {
    svg.append(trazo("rect", { x: x(p.fecha) - anchoDia / 2, y: margen.arriba, width: Math.max(anchoDia, 1), height: alto - margen.arriba - margen.abajo, class: "zona" },
      titulo(`${fechaDia(p.fecha)}: ${formato(p.saldo)}`)));
  }

  const etiquetasX = [[inicio, "start"], [hoy, proyectar ? "middle" : "end"]];
  if (proyectar) etiquetasX.push([fechaMeta, "end"]);
  for (const [fecha, ancla] of etiquetasX) {
    svg.append(trazo("text", { x: x(fecha), y: alto - 6, "text-anchor": ancla, class: "eje" }, fecha === hoy ? "Hoy" : fechaDia(fecha)));
  }
  return svg;
}

// Monedas depositadas por día de la semana; solo la barra mayor lleva su número
function graficoSemana(porDia) {
  const ancho = 440, alto = 150;
  const margen = { arriba: 20, abajo: 24, lados: 8 };
  const maximo = Math.max(1, ...porDia);
  const hueco = (ancho - 2 * margen.lados) / 7;
  const barra = Math.min(36, hueco * 0.6);
  const altoUtil = alto - margen.arriba - margen.abajo;
  const mayor = porDia.indexOf(Math.max(...porDia));

  const svg = trazo("svg", { viewBox: `0 0 ${ancho} ${alto}`, class: "grafico", role: "img",
    "aria-label": `Monedas depositadas por día de la semana. Más depósitos el ${NOMBRES_DIA[mayor]}.` });
  svg.append(trazo("line", { x1: margen.lados, x2: ancho - margen.lados, y1: alto - margen.abajo, y2: alto - margen.abajo, class: "base" }));

  porDia.forEach((cantidad, i) => {
    const centro = margen.lados + hueco * (i + 0.5);
    const h = (cantidad / maximo) * altoUtil;
    const base = alto - margen.abajo;
    if (cantidad > 0) {
      // Extremo superior redondeado, base recta sobre el eje
      const r = Math.min(4, h, barra / 2);
      const izq = centro - barra / 2, der = centro + barra / 2, arriba = base - h;
      svg.append(trazo("path", {
        d: `M${izq},${base} V${arriba + r} Q${izq},${arriba} ${izq + r},${arriba} H${der - r} Q${der},${arriba} ${der},${arriba + r} V${base} Z`,
        class: i === mayor ? "barra" : "barra tenue",
      }, titulo(`${NOMBRES_DIA[i]}: ${cantidad} ${cantidad === 1 ? "moneda" : "monedas"}`)));
    }
    if (i === mayor && cantidad > 0) {
      svg.append(trazo("text", { x: centro, y: base - h - 6, "text-anchor": "middle", class: "valor" }, String(cantidad)));
    }
    svg.append(trazo("text", { x: centro, y: alto - 6, "text-anchor": "middle", class: "eje" }, DIAS_SEMANA[i]));
  });
  return svg;
}

if (typeof module !== "undefined") module.exports = { calcularAnalisis, pasoEje };

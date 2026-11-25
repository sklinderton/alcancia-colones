// App web instalable de la alcancía. Sin url en config.js abre en modo demostración.
const BILLETES = [20000, 10000, 5000, 2000, 1000];
const MONEDAS = [500, 100, 50, 25, 10];
const DENOMINACIONES = [...BILLETES, ...MONEDAS];
const TEXTO_EVENTO = { deposito: "Depósito", retiro: "Retiro", rechazo: "Moneda devuelta", apertura: "Alcancía abierta" };

const { url, anonKey } = window.ALCANCIA_CONFIG;
const modoDemo = !url;
const supabase = modoDemo ? null : window.supabase.createClient(url, anonKey);

const raiz = document.getElementById("app");
const dialogoRetiro = document.getElementById("dialogo-retiro");

const estado = {
  alcancia: null,
  conteo: Object.fromEntries(DENOMINACIONES.map((valor) => [valor, 0])),
  eventos: [],
  aviso: "",
  conectado: modoDemo,
  retiro: {},
};
let canal = null;

const colones = (monto) => `₡${monto.toLocaleString("de-DE")}`;
const esBillete = (valor) => valor >= 1000;
const textoCantidad = (valor, cantidad) => {
  const nombre = esBillete(valor) ? "billete" : "moneda";
  return `${cantidad} ${cantidad === 1 ? nombre : nombre + "s"}`;
};
const ficha = (valor) => elemento("span", { class: esBillete(valor) ? "ficha billete" : "ficha" },
  esBillete(valor) ? `${valor / 1000} mil` : String(valor));
const dialogoMeta = document.getElementById("dialogo-meta");
const total = () => DENOMINACIONES.reduce((suma, valor) => suma + valor * estado.conteo[valor], 0);

function elemento(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [nombre, valor] of Object.entries(atributos)) {
    if (nombre.startsWith("on")) nodo.addEventListener(nombre.slice(2), valor);
    else if (nombre === "class") nodo.className = valor;
    else if (nombre in nodo) nodo[nombre] = valor;
    else nodo.setAttribute(nombre, valor);
  }
  nodo.append(...hijos.filter((hijo) => hijo !== null));
  return nodo;
}

function mostrarLogin(mensaje = "") {
  const entrar = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) mostrarLogin("No se pudo abrir GitHub. Intenta de nuevo.");
  };

  // Para cualquier persona: sin crear cuenta, la sesión queda en este teléfono
  const entrarSinCuenta = async () => {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      mostrarLogin("No se pudo entrar sin cuenta. Intenta de nuevo o entra con GitHub.");
      return;
    }
    iniciar();
  };

  estado.vista = "login";
  raiz.replaceChildren(...[
    tarjetaInstalacion({ antesDeEmpezar: true }),
    elemento("div", { class: "tarjeta" },
      elemento("h1", {}, "Tu alcancía"),
      elemento("p", { class: "ayuda" }, "Guarda tu vuelto y mira cuánto llevas desde el teléfono."),
      elemento("p", { class: "error", role: "alert" }, mensaje),
      elemento("div", { class: "columna" },
        elemento("button", { onclick: entrarSinCuenta }, "Empezar sin cuenta"),
        elemento("button", { class: "secundario", onclick: entrar }, "Entrar con GitHub")),
      elemento("p", { class: "ayuda" }, "Sin cuenta, tu alcancía queda guardada en este teléfono.")),
  ].filter((parte) => parte !== null));
}

// ---------- Usabilidad: medición de tareas ----------
// Cada tarea empezada en la app guarda si se terminó o se canceló, cuánto tardó
// y cuántos ajustes necesitó. Responde con datos "¿qué cambiaría en la interfaz?".
let tareaActual = null;

function empezarTarea(accion, { desdePanel = true } = {}) {
  tareaActual = { accion, inicio: performance.now(), ajustes: 0, desdePanel };
}

function contarAjuste() {
  if (tareaActual) tareaActual.ajustes++;
}

function terminarTarea(resultado) {
  if (!tareaActual) return;
  const { accion, inicio, ajustes, desdePanel } = tareaActual;
  tareaActual = null;
  // Volver de "Echar dinero" sin tocar nada después de guardar no es una tarea abandonada
  if (resultado === "cancelada" && ajustes === 0 && !desdePanel) return;
  if (modoDemo || !estado.alcancia?.id) return;
  const duracion = Math.min(3600000, Math.round(performance.now() - inicio));
  supabase.from("interacciones")
    .insert({ alcancia_id: estado.alcancia.id, accion, resultado, duracion_ms: duracion, ajustes: Math.min(ajustes, 10000) })
    .then(({ error }) => error && console.warn("No se guardó la interacción", error.message));
}

// ---------- Usabilidad: cuestionario SUS ----------
// Escala de usabilidad del sistema (SUS), 10 afirmaciones de 1 a 5
const AFIRMACIONES_SUS = [
  "Creo que me gustaría usar esta alcancía con frecuencia.",
  "La encontré innecesariamente complicada.",
  "Me pareció fácil de usar.",
  "Creo que necesitaría ayuda de alguien con conocimientos técnicos para usarla.",
  "Las distintas partes de la app funcionan bien juntas.",
  "Encontré demasiadas cosas que no concuerdan entre sí.",
  "Imagino que la mayoría de la gente aprendería a usarla muy rápido.",
  "Me resultó muy incómoda de usar.",
  "Me sentí con confianza al usarla.",
  "Necesité aprender muchas cosas antes de poder usarla.",
];
const claveEncuesta = (id) => `alcancia-encuesta:${id}`;

function tarjetaOpinion() {
  if (leerLocal(claveEncuesta(estado.alcancia.id), false)) {
    return elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Tu opinión"),
      elemento("p", { class: "ayuda" }, "¡Gracias! Ya respondiste el cuestionario."));
  }
  return elemento("section", { class: "tarjeta instalar" },
    elemento("h2", {}, "¿Qué te parece la alcancía?"),
    elemento("p", { class: "ayuda" }, "Son 10 preguntas cortas, unos 2 minutos. Tu opinión ayuda a mejorarla."),
    elemento("div", { class: "columna" }, elemento("button", { class: "secundario", onclick: mostrarEncuesta }, "Dar mi opinión")));
}

function mostrarEncuesta() {
  estado.vista = "encuesta";
  const error = elemento("p", { class: "error", role: "alert" });
  const comentario = elemento("textarea", { name: "comentario", maxLength: 1000, rows: 3,
    placeholder: "¿Algo te confundió o te gustaría que cambiara? (opcional)" });
  const preguntas = AFIRMACIONES_SUS.map((texto, i) => elemento("fieldset", { class: "pregunta" },
    elemento("legend", {}, `${i + 1}. ${texto}`),
    elemento("div", { class: "escala" }, ...[1, 2, 3, 4, 5].map((valor) => elemento("label", { class: "opcion" },
      elemento("input", { type: "radio", name: `p${i}`, value: valor, required: true }),
      elemento("span", {}, String(valor))))),
    elemento("div", { class: "extremos" }, elemento("span", {}, "Nada de acuerdo"), elemento("span", {}, "Muy de acuerdo"))));

  const enviar = async (evento) => {
    evento.preventDefault();
    const datos = new FormData(evento.target);
    const respuestas = AFIRMACIONES_SUS.map((_, i) => Number(datos.get(`p${i}`)));
    if (respuestas.some((r) => !r)) {
      error.textContent = "Responde las 10 preguntas.";
      return;
    }
    if (!modoDemo) {
      const { error: fallo } = await supabase.from("encuestas")
        .insert({ alcancia_id: estado.alcancia.id, respuestas, comentario: comentario.value.trim() || null });
      if (fallo) {
        error.textContent = "No se pudo enviar. Revisa tu conexión e intenta de nuevo.";
        return;
      }
    }
    guardarLocal(claveEncuesta(estado.alcancia.id), true);
    estado.aviso = "¡Gracias por tu opinión!";
    volverAlPanel();
  };

  raiz.replaceChildren(
    elemento("header", { class: "encabezado" },
      elemento("div", {}, elemento("h1", {}, "Tu opinión"), elemento("div", { class: "estado" }, "10 preguntas")),
      elemento("button", { class: "enlace", onclick: volverAlPanel }, "Volver")),
    elemento("form", { class: "tarjeta", onsubmit: enviar },
      elemento("p", { class: "ayuda" }, "Marca qué tan de acuerdo estás con cada frase. No hay respuestas correctas."),
      ...preguntas,
      elemento("label", {}, "Comentarios", comentario),
      error,
      elemento("div", { class: "columna" }, elemento("button", { type: "submit" }, "Enviar"))));
  scrollTo(0, 0);
}

// ---------- Instalar como app ----------
// Chrome y Edge en Android avisan que se puede instalar; en iPhone hay que hacerlo desde Safari.
let avisoInstalacion = null;
const estaInstalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const esIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

window.addEventListener("beforeinstallprompt", (evento) => {
  evento.preventDefault();
  avisoInstalacion = evento;
  if (estado.vista !== "virtual") dibujarActual();
});
window.addEventListener("appinstalled", () => {
  avisoInstalacion = null;
  guardarLocal("instalacion-oculta", true);
  dibujarActual();
});

async function instalar() {
  if (!avisoInstalacion) return;
  avisoInstalacion.prompt();
  await avisoInstalacion.userChoice;
  avisoInstalacion = null;
  dibujarActual();
}

// Antes de empezar se muestra siempre; dentro del panel se puede ocultar
function tarjetaInstalacion({ antesDeEmpezar = false } = {}) {
  if (modoDemo || estaInstalada() || (!antesDeEmpezar && leerLocal("instalacion-oculta", false))) return null;
  const ocultar = () => {
    guardarLocal("instalacion-oculta", true);
    dibujarActual();
  };
  let pasos;
  if (avisoInstalacion) {
    pasos = [elemento("div", { class: "columna" }, elemento("button", { onclick: instalar }, "Instalar la app"))];
  } else if (esIphone()) {
    pasos = [
      elemento("ol", { class: "pasos" },
        elemento("li", {}, "Abre esta página en Safari."),
        elemento("li", {}, "Toca Compartir: el cuadro con una flecha hacia arriba."),
        elemento("li", {}, "Elige \"Agregar a inicio\" y luego \"Agregar\"."),
        elemento("li", {}, "Abre la alcancía desde el ícono nuevo.")),
      antesDeEmpezar ? elemento("p", { class: "ayuda" }, "En iPhone hazlo antes de empezar: la app instalada no ve lo que hiciste en Safari.") : null,
    ];
  } else {
    pasos = [elemento("ol", { class: "pasos" },
      elemento("li", {}, "Toca el menú del navegador (⋮ o ☰)."),
      elemento("li", {}, "Elige \"Instalar app\" o \"Agregar a la pantalla principal\"."),
      elemento("li", {}, "Abre la alcancía desde el ícono nuevo."))];
  }
  return elemento("section", { class: "tarjeta instalar", "aria-label": "Instalar la app" },
    elemento("h2", {}, "Tenla como una app"),
    elemento("p", { class: "ayuda" }, "Con su ícono en la pantalla de inicio y sin la barra del navegador."),
    ...pasos.filter((paso) => paso !== null),
    antesDeEmpezar ? null : elemento("button", { class: "enlace", onclick: ocultar }, "Ahora no"));
}

// Redibuja la pantalla actual (inicio de sesión o panel) cuando cambia la instalación
function dibujarActual() {
  if (estado.vista === "login") mostrarLogin();
  else if (estado.alcancia && (estado.vista === "panel" || estado.vista === "virtual")) dibujarVista();
}

// ---------- Alcancía virtual: hace de ESP32 desde el teléfono ----------
// Guarda el código y la clave del dispositivo solo en este navegador y envía
// los depósitos a la misma Edge Function que usa la alcancía física.
const claveVirtual = (id) => `alcancia-virtual:${id}`;
const claveCola = (id) => `alcancia-virtual-cola:${id}`;

function leerLocal(clave, porDefecto) {
  try {
    return JSON.parse(localStorage.getItem(clave)) ?? porDefecto;
  } catch {
    return porDefecto;
  }
}

function guardarLocal(clave, valor) {
  try {
    if (valor === null) localStorage.removeItem(clave);
    else localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento (modo privado): la alcancía virtual pedirá los datos otra vez
  }
}

const dispositivoVirtual = () => (estado.alcancia ? leerLocal(claveVirtual(estado.alcancia.id), null) : null);

function mostrarCredenciales({ alcancia_id: alcanciaId, codigo, clave }) {
  guardarLocal(claveVirtual(alcanciaId), { codigo, clave });
  estado.vista = "crear";
  raiz.replaceChildren(elemento("div", { class: "tarjeta" },
    elemento("h1", {}, "Tu alcancía está lista"),
    elemento("p", { class: "ayuda" }, "Ya puedes echar dinero desde este teléfono con \"Echar dinero\"."),
    elemento("details", {},
      elemento("summary", {}, "Datos para la alcancía física (ESP32)"),
      elemento("p", { class: "ayuda" }, "Si armas la alcancía física, copia estos datos en el firmware. Solo se muestran esta vez."),
      elemento("span", { class: "etiqueta" }, "CODIGO_ALCANCIA"),
      elemento("code", { class: "clave" }, codigo),
      elemento("span", { class: "etiqueta" }, "CLAVE_ALCANCIA"),
      elemento("code", { class: "clave" }, clave)),
    elemento("div", { class: "columna" }, elemento("button", { onclick: iniciar }, "Empezar"))));
}

const virtual = { ultimo: "", estado: "", enviando: false, carrito: {} };
const MAXIMO_POR_DENOMINACION = 500;

function sonidoDeposito() {
  try {
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    [[1200, 0, 0.08], [1800, 0.09, 0.12]].forEach(([frecuencia, inicio, duracion]) => {
      const tono = audio.createOscillator();
      const volumen = audio.createGain();
      tono.frequency.value = frecuencia;
      volumen.gain.value = 0.08;
      tono.connect(volumen).connect(audio.destination);
      tono.start(audio.currentTime + inicio);
      tono.stop(audio.currentTime + inicio + duracion);
    });
  } catch {
    // Sin sonido: la pantalla y la vibración igual confirman
  }
  navigator.vibrate?.(30);
}

const montoCarrito = () => DENOMINACIONES.reduce((suma, valor) => suma + valor * (virtual.carrito[valor] ?? 0), 0);

// Guarda de una vez todo lo que la persona indicó. Cada moneda o billete es un
// evento, igual que cuando cae uno por uno en la alcancía física.
async function guardarVirtual() {
  const monto = montoCarrito();
  if (monto === 0) return;
  const ahora = new Date().toISOString();
  const eventos = DENOMINACIONES.flatMap((valor) => Array.from({ length: virtual.carrito[valor] ?? 0 }, () => (
    { id: `virtual-${crypto.randomUUID()}`, tipo: "deposito", denominacion: valor, ocurrido_en: ahora })));
  sonidoDeposito();
  terminarTarea("completada");
  empezarTarea("echar_dinero", { desdePanel: false });  // Puede seguir guardando sin volver al panel
  virtual.carrito = {};
  virtual.ultimo = `+${colones(monto)}`;
  if (modoDemo) {
    eventos.forEach((evento) => aplicarEvento({ ...evento, cantidad: 1, origen: "dispositivo" }));
    virtual.estado = `Guardado. Total: ${colones(total())}`;
    mostrarAlcanciaVirtual();
    return;
  }
  guardarLocal(claveCola(estado.alcancia.id), [...leerLocal(claveCola(estado.alcancia.id), []), ...eventos]);
  virtual.estado = "Guardando…";
  mostrarAlcanciaVirtual();
  await enviarColaVirtual();
}

// Envía los depósitos pendientes; si falla la red quedan para el próximo intento
async function enviarColaVirtual() {
  const dispositivo = dispositivoVirtual();
  if (virtual.enviando || !dispositivo) return;
  virtual.enviando = true;
  try {
    let cola = leerLocal(claveCola(estado.alcancia.id), []);
    while (cola.length > 0) {
      const lote = cola.slice(0, 20);
      const respuesta = await fetch(`${url}/functions/v1/dispositivo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-clave-dispositivo": dispositivo.clave },
        body: JSON.stringify({ codigo: dispositivo.codigo, eventos: lote }),
      });
      if (respuesta.status === 401) {
        guardarLocal(claveVirtual(estado.alcancia.id), null);
        virtual.estado = "El código o la clave no son de esta alcancía. Vuelve a conectarla.";
        break;
      }
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      const { conteo } = await respuesta.json();
      for (const evento of lote) {
        if (!estado.eventos.some((conocido) => conocido.id === evento.id)) {
          estado.eventos.unshift({ ...evento, cantidad: 1, origen: "dispositivo" });
        }
      }
      cola = leerLocal(claveCola(estado.alcancia.id), []).slice(lote.length);
      guardarLocal(claveCola(estado.alcancia.id), cola);
      for (const valor of DENOMINACIONES) estado.conteo[valor] = conteo?.[valor] ?? 0;
      virtual.estado = `Guardado. Total: ${colones(total())}`;
    }
  } catch {
    const pendientes = leerLocal(claveCola(estado.alcancia.id), []).length;
    virtual.estado = `Sin conexión: ${pendientes} pendiente${pendientes === 1 ? "" : "s"}, se enviará${pendientes === 1 ? "" : "n"} después.`;
  } finally {
    virtual.enviando = false;
    if (estado.vista === "virtual") mostrarAlcanciaVirtual();
  }
}

function formularioConexionVirtual() {
  const error = elemento("p", { class: "error", role: "alert" });
  const codigo = elemento("input", { name: "codigo", placeholder: "alcancia-xxxxxx", required: true, autocomplete: "off" });
  const clave = elemento("input", { name: "clave", required: true, autocomplete: "off", spellcheck: false });
  const conectar = (evento) => {
    evento.preventDefault();
    guardarLocal(claveVirtual(estado.alcancia.id), { codigo: codigo.value.trim(), clave: clave.value.trim() });
    virtual.estado = "";
    mostrarAlcanciaVirtual();
  };
  return elemento("section", { class: "tarjeta" },
    elemento("h2", {}, "Conecta esta alcancía"),
    elemento("p", { class: "ayuda" }, "Escribe el código y la clave que recibiste al crear la alcancía. Se guardan solo en este teléfono."),
    elemento("form", { onsubmit: conectar },
      elemento("label", {}, "Código", codigo),
      elemento("label", {}, "Clave", clave),
      error,
      elemento("div", { class: "columna" }, elemento("button", { type: "submit" }, "Conectar"))));
}

function mostrarAlcanciaVirtual() {
  estado.vista = "virtual";
  const conectada = modoDemo || dispositivoVirtual();
  if (!conectada) {
    raiz.replaceChildren(encabezadoVirtual(), formularioConexionVirtual());
    return;
  }

  // Se actualizan solo los textos al cambiar una cantidad, para no perder el foco al escribir
  const pantallaMonto = elemento("div", { class: "ultimo" });
  const pantallaDetalle = elemento("div", { class: "detalle-pantalla" });
  const guardar = elemento("button", { type: "button", onclick: guardarVirtual });
  const refrescar = () => {
    const monto = montoCarrito();
    pantallaMonto.textContent = monto ? colones(monto) : (virtual.ultimo || colones(total()));
    pantallaDetalle.textContent = monto ? "Esto vas a guardar" : (virtual.estado || "Indica cuántas monedas y billetes vas a guardar");
    guardar.textContent = monto ? `Guardar ${colones(monto)}` : "Guardar";
    guardar.disabled = monto === 0;
  };

  const fila = (valor) => {
    const campo = elemento("input", {
      type: "number", inputMode: "numeric", min: 0, max: MAXIMO_POR_DENOMINACION, step: 1,
      value: String(virtual.carrito[valor] ?? 0), "aria-label": `Cantidad de ${colones(valor)}`,
    });
    const fijar = (cantidad) => {
      const limpia = Math.min(MAXIMO_POR_DENOMINACION, Math.max(0, Math.floor(Number(cantidad) || 0)));
      if (limpia !== (virtual.carrito[valor] ?? 0)) contarAjuste();
      virtual.carrito[valor] = limpia;
      if (String(limpia) !== campo.value) campo.value = String(limpia);
      refrescar();
    };
    campo.addEventListener("input", () => fijar(campo.value));
    campo.addEventListener("focus", () => campo.select());
    const nombre = esBillete(valor) ? "un billete" : "una moneda";
    return elemento("div", { class: "fila" },
      elemento("span", { class: "moneda" }, ficha(valor)),
      elemento("span", { class: "contador" },
        elemento("button", { type: "button", class: "secundario", "aria-label": `Quitar ${nombre} de ${colones(valor)}`, onclick: () => fijar((virtual.carrito[valor] ?? 0) - 1) }, "−"),
        campo,
        elemento("button", { type: "button", class: "secundario", "aria-label": `Agregar ${nombre} de ${colones(valor)}`, onclick: () => fijar((virtual.carrito[valor] ?? 0) + 1) }, "+")));
  };

  raiz.replaceChildren(
    encabezadoVirtual(),
    elemento("section", { class: "pantalla-virtual", "aria-live": "polite" }, pantallaMonto, pantallaDetalle),
    elemento("section", { class: "tarjeta" }, elemento("h2", {}, "Monedas"), ...[...MONEDAS].reverse().map(fila)),
    elemento("section", { class: "tarjeta" }, elemento("h2", {}, "Billetes"), ...[...BILLETES].reverse().map(fila)),
    elemento("div", { class: "barra-guardar" }, guardar));
  refrescar();
}

const encabezadoVirtual = () => elemento("header", { class: "encabezado" },
  elemento("div", {},
    elemento("h1", {}, "Echar dinero"),
    elemento("div", { class: "estado" }, "Alcancía virtual")),
  elemento("button", { class: "enlace", onclick: volverAlPanel }, "Volver"));

function abrirEcharDinero() {
  empezarTarea("echar_dinero");
  mostrarAlcanciaVirtual();
}

function volverAlPanel() {
  if (estado.vista === "virtual") terminarTarea("cancelada");
  estado.vista = "panel";
  virtual.carrito = {};
  virtual.ultimo = "";
  virtual.estado = "";
  mostrarPanel();
}

function mostrarCrearAlcancia() {
  estado.vista = "crear";
  const error = elemento("p", { class: "error", role: "alert" });
  const nombre = elemento("input", { name: "nombre", value: "Mi alcancía", maxLength: 40, required: true });
  const meta = elemento("input", { name: "meta", type: "number", value: 10000, min: 100, step: 100, required: true });

  const crear = async (evento) => {
    evento.preventDefault();
    const { data, error: fallo } = await supabase.rpc("crear_alcancia", {
      p_nombre: nombre.value,
      p_meta_colones: Number(meta.value),
    });
    if (fallo) {
      error.textContent = "No se pudo crear la alcancía.";
      return;
    }
    mostrarCredenciales(data[0]);
  };

  raiz.replaceChildren(elemento("div", { class: "tarjeta" },
    elemento("h1", {}, "Crea tu alcancía"),
    elemento("p", { class: "ayuda" }, "La meta te ayuda a ver cuánto te falta."),
    elemento("form", { onsubmit: crear },
      elemento("label", {}, "Nombre", nombre),
      elemento("label", {}, "Meta en colones", meta),
      error,
      elemento("div", { class: "columna" }, elemento("button", { type: "submit" }, "Crear alcancía")))));
}

function textoEvento(evento) {
  const titulo = TEXTO_EVENTO[evento.tipo];
  if (evento.tipo === "deposito") return `${titulo} de ${colones(evento.denominacion)}`;
  if (evento.tipo === "retiro") return `${titulo}: ${evento.cantidad} de ${colones(evento.denominacion)}`;
  return titulo;
}

const fechaCorta = (fecha) => new Date(fecha).toLocaleString("es-CR", {
  day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
});
const fechaLarga = (fecha) => fecha.toLocaleDateString("es-CR", { day: "numeric", month: "long" });
const porcentaje = (fraccion) => `${(fraccion * 100).toLocaleString("es-CR", { maximumFractionDigits: 1 })} %`;

// Análisis del historial completo guardado en la nube
function seccionesAnalisis() {
  const meta = estado.alcancia.meta_colones;
  const analisis = calcularAnalisis(estado.eventos, meta);
  if (analisis.serie.length === 0) {
    return [elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Análisis"),
      elemento("p", { class: "ayuda" }, "Cuando eches monedas, aquí verás cómo crece tu ahorro y cuándo ahorras más."))];
  }

  let proyeccion = "Sin ahorro en las últimas 4 semanas todavía no se puede estimar cuándo llegarás a la meta.";
  if (analisis.saldo >= meta) {
    proyeccion = `¡Superaste la meta por ${colones(analisis.saldo - meta)}! Puedes subirla con "Cambiar meta".`;
  } else if (analisis.fechaMeta) {
    const semanal = Math.round(analisis.ritmoDiario * 7);
    proyeccion = `Al ritmo de ${colones(semanal)} por semana, llegarás a la meta cerca del ${fechaLarga(analisis.fechaMeta)}.`;
  }

  const diaPico = analisis.porDia.indexOf(Math.max(...analisis.porDia));
  const habitos = analisis.horaPico === null
    ? "Todavía no hay depósitos para ver tus hábitos."
    : `Ahorras más los ${NOMBRES_DIA_PLURAL[diaPico]}, y la hora con más depósitos es de ${analisis.horaPico}:00 a ${analisis.horaPico + 1}:00.`;

  const secciones = [
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Tu ahorro en el tiempo"),
      elemento("p", { class: "ayuda" }, proyeccion),
      graficoAhorro(analisis, meta, colones)),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Cuándo ahorras"),
      elemento("p", { class: "ayuda" }, habitos),
      graficoSemana(analisis.porDia)),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Depósitos y retiros"),
      elemento("div", { class: "fila" },
        elemento("span", {}, "Depositado"),
        elemento("span", { class: "detalle" }, colones(analisis.depositado))),
      elemento("div", { class: "fila" },
        elemento("span", {}, "Retirado"),
        elemento("span", { class: "detalle" }, analisis.depositado > 0
          ? `${colones(analisis.retirado)} (${porcentaje(analisis.retirado / analisis.depositado)})`
          : colones(analisis.retirado)))),
  ];

  if (analisis.tasaDevueltas !== null) {
    const revisar = analisis.tasaDevueltas > 0.05;
    secciones.push(elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Monedas devueltas"),
      elemento("div", { class: "fila" },
        elemento("span", {}, `${analisis.devueltas} de ${analisis.aceptadas + analisis.devueltas} intentos`),
        elemento("span", { class: "detalle" }, porcentaje(analisis.tasaDevueltas))),
      elemento("p", { class: "ayuda" }, revisar
        ? "Más del 5 % vuelve a salir: conviene entrenar el monedero con más monedas de distintos años."
        : "La alcancía reconoce bien lo que entra. Si pasa del 5 %, conviene volver a entrenar el monedero.")));
  }
  return secciones;
}

const filaDenominacion = (valor) => elemento("div", { class: "fila" },
  elemento("span", { class: "moneda" }, ficha(valor), textoCantidad(valor, estado.conteo[valor])),
  elemento("span", { class: "detalle" }, colones(valor * estado.conteo[valor])));

function mostrarPanel() {
  const meta = estado.alcancia.meta_colones;
  raiz.replaceChildren(...[
    elemento("header", { class: "encabezado" },
      elemento("div", {},
        elemento("h1", {}, estado.alcancia.nombre),
        elemento("div", { class: "estado" }, modoDemo ? "Datos de ejemplo" : estado.conectado ? "En vivo" : "Reconectando…")),
      modoDemo ? null : elemento("button", { class: "enlace", onclick: salir }, "Salir")),
    modoDemo ? elemento("div", { class: "aviso" }, "Modo demostración: nada de esto es dinero real.") : null,
    estado.aviso ? elemento("div", { class: "aviso" }, estado.aviso) : null,
    elemento("section", { class: "tarjeta", "aria-label": "Saldo" },
      elemento("div", { class: "etiqueta" }, "Saldo"),
      elemento("div", { class: "total" }, colones(total())),
      elemento("progress", { max: meta, value: Math.min(total(), meta), "aria-label": "Avance hacia la meta" }),
      elemento("div", { class: "meta" },
        // Sin tope: el ahorro puede pasar del 100 % de la meta
        elemento("span", {}, total() >= meta
          ? `${Math.floor((total() / meta) * 100)} % · meta superada`
          : `${Math.floor((total() / meta) * 100)} % de la meta`),
        elemento("span", {}, `Meta ${colones(meta)} `,
          elemento("button", { class: "enlace", onclick: abrirMeta }, "Cambiar")))),
    elemento("div", { class: "acciones" },
      elemento("button", { onclick: abrirEcharDinero }, "Echar dinero"),
      elemento("button", { class: "secundario", onclick: abrirRetiro, disabled: total() === 0 }, "Hacer retiro")),
    tarjetaInstalacion(),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Billetes"),
      ...BILLETES.map(filaDenominacion)),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Monedas"),
      ...MONEDAS.map(filaDenominacion)),
    ...seccionesAnalisis(),
    modoDemo ? null : tarjetaOpinion(),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Actividad reciente"),
      ...(estado.eventos.length === 0
        ? [elemento("p", { class: "ayuda" }, "Echa tu primera moneda o billete y aparecerá aquí.")]
        : estado.eventos.slice(0, 10).map((evento) => elemento("div", { class: "fila" },
            elemento("span", {}, textoEvento(evento)),
            elemento("span", { class: "detalle" }, fechaCorta(evento.ocurrido_en)))))),
  ].filter((seccion) => seccion !== null));
}

function aplicarEvento(evento) {
  if (estado.eventos.some((conocido) => conocido.id === evento.id)) return;
  estado.eventos.unshift(evento);
  if (evento.tipo === "deposito") estado.conteo[evento.denominacion] += evento.cantidad;
  if (evento.tipo === "retiro") estado.conteo[evento.denominacion] -= evento.cantidad;
  if (evento.tipo === "apertura") {
    estado.aviso = "La alcancía se abrió: saca lo que registraste.";
  }
  dibujarVista();
}

// Redibuja la pantalla en la que está la persona sin sacarla de ella
function dibujarVista() {
  if (estado.vista === "encuesta") return;
  if (estado.vista === "virtual") mostrarAlcanciaVirtual();
  else mostrarPanel();
}

async function salir() {
  if (estado.anonimo && !confirm("Entraste sin cuenta: si sales, no podrás volver a esta alcancía. ¿Salir de todas formas?")) return;
  await supabase.auth.signOut();
  iniciar();
}

// La orden de abrir llega al ESP32 en la siguiente sincronización
async function pedirApertura() {
  if (modoDemo) {
    aplicarEvento({ id: crypto.randomUUID(), tipo: "apertura", cantidad: 1, ocurrido_en: new Date().toISOString() });
    return true;
  }
  const { error } = await supabase.from("comandos").insert({ alcancia_id: estado.alcancia.id });
  return !error;
}

function abrirMeta() {
  const campo = document.getElementById("nueva-meta");
  campo.value = estado.alcancia.meta_colones;
  document.getElementById("error-meta").textContent = "";
  empezarTarea("cambiar_meta");
  dialogoMeta.showModal();
}

async function guardarMeta(evento) {
  evento.preventDefault();
  const nueva = Number(document.getElementById("nueva-meta").value);
  if (!Number.isInteger(nueva) || nueva <= 0) {
    document.getElementById("error-meta").textContent = "Escribe una meta en colones mayor que cero.";
    return;
  }
  if (!modoDemo) {
    const { error } = await supabase.from("alcancias").update({ meta_colones: nueva }).eq("id", estado.alcancia.id);
    if (error) {
      document.getElementById("error-meta").textContent = "No se pudo guardar la meta.";
      return;
    }
  }
  estado.alcancia.meta_colones = nueva;
  terminarTarea("completada");
  dialogoMeta.close();
  mostrarPanel();
}

function dibujarRetiro() {
  const filas = DENOMINACIONES.filter((valor) => estado.conteo[valor] > 0).map((valor) => {
    const cambiar = (delta) => {
      const nuevo = Math.min(estado.conteo[valor], Math.max(0, (estado.retiro[valor] ?? 0) + delta));
      if (nuevo !== (estado.retiro[valor] ?? 0)) contarAjuste();
      estado.retiro[valor] = nuevo;
      dibujarRetiro();
    };
    return elemento("div", { class: "fila" },
      elemento("span", { class: "moneda" }, ficha(valor),
        elemento("span", { class: "detalle" }, `hay ${estado.conteo[valor]}`)),
      elemento("span", { class: "contador" },
        elemento("button", { type: "button", class: "secundario", "aria-label": `Quitar uno de ${valor}`, onclick: () => cambiar(-1) }, "−"),
        elemento("output", {}, String(estado.retiro[valor] ?? 0)),
        elemento("button", { type: "button", class: "secundario", "aria-label": `Agregar uno de ${valor}`, onclick: () => cambiar(1) }, "+")));
  });
  document.getElementById("lista-retiro").replaceChildren(...filas);
  const monto = DENOMINACIONES.reduce((suma, valor) => suma + valor * (estado.retiro[valor] ?? 0), 0);
  const confirmar = document.getElementById("confirmar-retiro");
  confirmar.textContent = monto ? `Retirar ${colones(monto)}` : "Retirar";
  confirmar.disabled = monto === 0;
}

function abrirRetiro() {
  estado.retiro = {};
  document.getElementById("error-retiro").textContent = "";
  dibujarRetiro();
  empezarTarea("hacer_retiro");
  dialogoRetiro.showModal();
}

async function confirmarRetiro(evento) {
  evento.preventDefault();
  const filas = Object.entries(estado.retiro)
    .filter(([, cantidad]) => cantidad > 0)
    .map(([denominacion, cantidad]) => ({
      id: crypto.randomUUID(),
      tipo: "retiro",
      origen: "app",
      denominacion: Number(denominacion),
      cantidad,
      ocurrido_en: new Date().toISOString(),
    }));

  if (!modoDemo) {
    const { error } = await supabase.from("eventos")
      .insert(filas.map((fila) => ({ ...fila, alcancia_id: estado.alcancia.id })));
    if (error) {
      document.getElementById("error-retiro").textContent = "No se pudo registrar. Revisa las cantidades.";
      return;
    }
  }
  terminarTarea("completada");
  dialogoRetiro.close();
  filas.forEach(aplicarEvento);
  // Un solo paso: el retiro queda registrado y la alcancía se abre para sacarlo
  const ordenEnviada = await pedirApertura();
  if (!modoDemo) {
    if (dispositivoVirtual()) {
      estado.aviso = "Retiro registrado.";  // La alcancía virtual no tiene cerradura que abrir
    } else {
      estado.aviso = ordenEnviada
        ? "Retiro registrado. La alcancía se abrirá en unos 10 segundos."
        : "Retiro registrado, pero no se pudo enviar la orden de abrir. Revisa tu conexión.";
    }
  }
  mostrarPanel();
}

function escucharEventos() {
  canal?.unsubscribe();
  canal = supabase
    .channel("eventos-alcancia")
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "eventos",
      filter: `alcancia_id=eq.${estado.alcancia.id}`,
    }, ({ new: evento }) => aplicarEvento(evento))
    .subscribe((estadoCanal) => {
      estado.conectado = estadoCanal === "SUBSCRIBED";
      dibujarVista();
    });
}

// Ocho semanas de ejemplo, siempre iguales: más monedas los viernes y sábados por la tarde
function eventosDemo(ahora = new Date()) {
  let semilla = 7;
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  const frecuencia = [[10, 3], [25, 2], [50, 3], [100, 4], [500, 1], [1000, 0.6], [2000, 0.3], [5000, 0.1]];
  const pesoTotal = frecuencia.reduce((suma, [, peso]) => suma + peso, 0);
  const elegirMoneda = () => {
    let resto = azar() * pesoTotal;
    for (const [valor, peso] of frecuencia) {
      resto -= peso;
      if (resto < 0) return valor;
    }
    return 10;
  };

  const eventos = [];
  const conteo = Object.fromEntries(DENOMINACIONES.map((valor) => [valor, 0]));
  const agregar = (evento) => eventos.push({ id: `demo-${eventos.length}`, cantidad: 1, ...evento });
  for (let atras = 55; atras >= 0; atras--) {
    const dia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - atras);
    const finDeSemana = dia.getDay() === 5 || dia.getDay() === 6;
    const monedas = Math.floor(azar() * (finDeSemana ? 5 : 3));
    for (let i = 0; i < monedas; i++) {
      const fecha = new Date(dia);
      fecha.setHours(azar() < 0.15 ? 7 : 17 + Math.floor(azar() * 3), Math.floor(azar() * 60));
      if (fecha > ahora) continue;
      if (azar() < 0.05) {
        agregar({ tipo: "rechazo", ocurrido_en: fecha.toISOString() });
        continue;
      }
      const valor = elegirMoneda();
      conteo[valor]++;
      agregar({ tipo: "deposito", origen: "dispositivo", denominacion: valor, ocurrido_en: fecha.toISOString() });
    }
    if (atras === 20 && conteo[100] > 0) {
      const fecha = new Date(dia);
      fecha.setHours(12, 0);
      const cantidad = Math.min(5, conteo[100]);
      conteo[100] -= cantidad;
      agregar({ tipo: "apertura", ocurrido_en: fecha.toISOString() });
      agregar({ tipo: "retiro", origen: "app", denominacion: 100, cantidad, ocurrido_en: new Date(fecha.getTime() + 60000).toISOString() });
    }
  }
  eventos.sort((a, b) => new Date(b.ocurrido_en) - new Date(a.ocurrido_en));
  return { eventos, conteo };
}

function cargarDemo() {
  const { eventos, conteo } = eventosDemo();
  estado.alcancia = { nombre: "Alcancía de ejemplo", meta_colones: 50000 };
  estado.conteo = conteo;
  estado.eventos = eventos;
  mostrarPanel();
}

async function iniciar() {
  if (modoDemo) {
    cargarDemo();
    return;
  }

  const { data: { session: sesion } } = await supabase.auth.getSession();
  estado.vista = "panel";
  estado.anonimo = Boolean(sesion?.user?.is_anonymous);
  if (!sesion) {
    canal?.unsubscribe();
    mostrarLogin();
    return;
  }

  const { data: alcancias, error } = await supabase.from("alcancias").select("*").order("creada_en").limit(1);
  if (error) {
    raiz.replaceChildren(elemento("p", { class: "error" }, "No se pudo cargar tu alcancía. Revisa tu conexión."));
    return;
  }
  if (alcancias.length === 0) {
    mostrarCrearAlcancia();
    return;
  }

  estado.alcancia = alcancias[0];
  const [{ data: saldo }, { data: eventos }] = await Promise.all([
    supabase.from("saldo_por_denominacion").select("denominacion, cantidad").eq("alcancia_id", estado.alcancia.id),
    // El historial completo alimenta el análisis; 1000 es el máximo por consulta de Supabase
    supabase.from("eventos").select("*").eq("alcancia_id", estado.alcancia.id).order("ocurrido_en", { ascending: false }).limit(1000),
  ]);
  for (const valor of DENOMINACIONES) estado.conteo[valor] = 0;
  for (const fila of saldo ?? []) estado.conteo[fila.denominacion] = fila.cantidad;
  estado.eventos = eventos ?? [];
  mostrarPanel();
  escucharEventos();
  enviarColaVirtual();  // Depósitos que quedaron sin enviar la última vez
}

document.getElementById("formulario-retiro").addEventListener("submit", confirmarRetiro);
document.getElementById("cancelar-retiro").addEventListener("click", () => dialogoRetiro.close());
document.getElementById("formulario-meta").addEventListener("submit", guardarMeta);
document.getElementById("cancelar-meta").addEventListener("click", () => dialogoMeta.close());
dialogoRetiro.addEventListener("close", () => tareaActual?.accion === "hacer_retiro" && terminarTarea("cancelada"));
dialogoMeta.addEventListener("close", () => tareaActual?.accion === "cambiar_meta" && terminarTarea("cancelada"));
document.getElementById("nueva-meta").addEventListener("input", contarAjuste);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

iniciar();

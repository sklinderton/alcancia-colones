// App web instalable de la alcancía. Sin url en config.js abre en modo demostración.
const DENOMINACIONES = [500, 100, 50, 25, 10];
const TEXTO_EVENTO = { deposito: "Depósito", retiro: "Retiro", rechazo: "Objeto rechazado", apertura: "Alcancía abierta" };

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
const textoMonedas = (cantidad) => `${cantidad} ${cantidad === 1 ? "moneda" : "monedas"}`;
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

  raiz.replaceChildren(elemento("div", { class: "tarjeta" },
    elemento("h1", {}, "Tu alcancía"),
    elemento("p", { class: "ayuda" }, "Inicia sesión para ver tu saldo desde cualquier lugar."),
    elemento("p", { class: "error", role: "alert" }, mensaje),
    elemento("div", { class: "columna" },
      elemento("button", { onclick: entrar }, "Entrar con GitHub"))));
}

function mostrarCrearAlcancia() {
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

function mostrarCredenciales({ codigo, clave }) {
  raiz.replaceChildren(elemento("div", { class: "tarjeta" },
    elemento("h1", {}, "Datos para el ESP32"),
    elemento("p", { class: "ayuda" }, "Copia la clave en el firmware. Solo se muestra esta vez."),
    elemento("span", { class: "etiqueta" }, "CODIGO_ALCANCIA"),
    elemento("code", { class: "clave" }, codigo),
    elemento("span", { class: "etiqueta" }, "CLAVE_ALCANCIA"),
    elemento("code", { class: "clave" }, clave),
    elemento("div", { class: "columna" }, elemento("button", { onclick: iniciar }, "Ya la guardé"))));
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

function mostrarPanel() {
  const meta = estado.alcancia.meta_colones;
  raiz.replaceChildren(...[
    elemento("header", { class: "encabezado" },
      elemento("div", {},
        elemento("h1", {}, estado.alcancia.nombre),
        elemento("div", { class: "estado" }, modoDemo ? "Datos de ejemplo" : estado.conectado ? "En vivo" : "Reconectando…")),
      modoDemo ? null : elemento("button", { class: "enlace", onclick: () => supabase.auth.signOut().then(iniciar) }, "Salir")),
    modoDemo ? elemento("div", { class: "aviso" }, "Modo demostración: nada de esto es dinero real.") : null,
    estado.aviso ? elemento("div", { class: "aviso" }, estado.aviso) : null,
    elemento("section", { class: "tarjeta", "aria-label": "Saldo" },
      elemento("div", { class: "etiqueta" }, "Saldo"),
      elemento("div", { class: "total" }, colones(total())),
      elemento("progress", { max: meta, value: Math.min(total(), meta), "aria-label": "Avance hacia la meta" }),
      elemento("div", { class: "meta" },
        elemento("span", {}, `${Math.min(100, Math.floor((total() / meta) * 100))} % de la meta`),
        elemento("span", {}, colones(meta)))),
    elemento("div", { class: "acciones" },
      elemento("button", { onclick: pedirApertura }, "Abrir"),
      elemento("button", { class: "secundario", onclick: abrirRetiro, disabled: total() === 0 }, "Registrar retiro")),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Monedas"),
      ...DENOMINACIONES.map((valor) => elemento("div", { class: "fila" },
        elemento("span", { class: "moneda" }, elemento("span", { class: "ficha" }, String(valor)), textoMonedas(estado.conteo[valor])),
        elemento("span", { class: "detalle" }, colones(valor * estado.conteo[valor]))))),
    elemento("section", { class: "tarjeta" },
      elemento("h2", {}, "Actividad reciente"),
      ...(estado.eventos.length === 0
        ? [elemento("p", { class: "ayuda" }, "Echa tu primera moneda y aparecerá aquí.")]
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
    estado.aviso = "La alcancía se abrió. Si sacas monedas, registra el retiro.";
  }
  mostrarPanel();
}

async function pedirApertura() {
  if (modoDemo) {
    aplicarEvento({ id: crypto.randomUUID(), tipo: "apertura", cantidad: 1, ocurrido_en: new Date().toISOString() });
    return;
  }
  const { error } = await supabase.from("comandos").insert({ alcancia_id: estado.alcancia.id });
  estado.aviso = error ? "No se pudo enviar la orden." : "Orden enviada. Se abrirá en unos 10 segundos.";
  mostrarPanel();
}

function dibujarRetiro() {
  const filas = DENOMINACIONES.filter((valor) => estado.conteo[valor] > 0).map((valor) => {
    const cambiar = (delta) => {
      const nuevo = Math.min(estado.conteo[valor], Math.max(0, (estado.retiro[valor] ?? 0) + delta));
      estado.retiro[valor] = nuevo;
      dibujarRetiro();
    };
    return elemento("div", { class: "fila" },
      elemento("span", { class: "moneda" }, elemento("span", { class: "ficha" }, String(valor))),
      elemento("span", { class: "contador" },
        elemento("button", { type: "button", class: "secundario", "aria-label": `Quitar una de ${valor}`, onclick: () => cambiar(-1) }, "−"),
        elemento("output", {}, String(estado.retiro[valor] ?? 0)),
        elemento("button", { type: "button", class: "secundario", "aria-label": `Agregar una de ${valor}`, onclick: () => cambiar(1) }, "+")));
  });
  document.getElementById("lista-retiro").replaceChildren(...filas);
  const monto = DENOMINACIONES.reduce((suma, valor) => suma + valor * (estado.retiro[valor] ?? 0), 0);
  const confirmar = document.getElementById("confirmar-retiro");
  confirmar.textContent = monto ? `Registrar ${colones(monto)}` : "Registrar retiro";
  confirmar.disabled = monto === 0;
}

function abrirRetiro() {
  estado.retiro = {};
  document.getElementById("error-retiro").textContent = "";
  dibujarRetiro();
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
  dialogoRetiro.close();
  estado.aviso = "";
  filas.forEach(aplicarEvento);
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
      mostrarPanel();
    });
}

function cargarDemo() {
  estado.alcancia = { nombre: "Alcancía de ejemplo", meta_colones: 10000 };
  estado.conteo = { 500: 3, 100: 7, 50: 4, 25: 2, 10: 5 };
  estado.eventos = [{ id: "demo-1", tipo: "deposito", denominacion: 100, cantidad: 1, ocurrido_en: new Date().toISOString() }];
  mostrarPanel();
}

async function iniciar() {
  if (modoDemo) {
    cargarDemo();
    return;
  }

  const { data: { session: sesion } } = await supabase.auth.getSession();
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
    supabase.from("eventos").select("*").eq("alcancia_id", estado.alcancia.id).order("ocurrido_en", { ascending: false }).limit(20),
  ]);
  for (const valor of DENOMINACIONES) estado.conteo[valor] = 0;
  for (const fila of saldo ?? []) estado.conteo[fila.denominacion] = fila.cantidad;
  estado.eventos = eventos ?? [];
  mostrarPanel();
  escucharEventos();
}

document.getElementById("formulario-retiro").addEventListener("submit", confirmarRetiro);
document.getElementById("cancelar-retiro").addEventListener("click", () => dialogoRetiro.close());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

iniciar();

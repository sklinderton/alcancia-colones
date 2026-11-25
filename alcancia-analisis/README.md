# Análisis de datos

**Pregunta:** ¿cuánto efectivo acumula una persona sin darse cuenta, cuándo lo ahorra y qué tan rápido llega a su meta? ¿Se pueden detectar movimientos anómalos?

| Archivo | Qué es |
|---|---|
| [`analisis_alcancia.ipynb`](analisis_alcancia.ipynb) | Cuaderno de Python que responde la pregunta con gráficos y estadísticas. Abre en Jupyter o Google Colab |
| [`descargar_eventos.py`](descargar_eventos.py) | Descarga las tablas de Supabase a CSV, sin nombres ni ids |
| `datos/eventos.csv`, `datos/alcancias.csv` | Copia de la base de datos: evidencia de que los datos se guardaron |

## Qué responde el cuaderno

| Parte | Técnica | Pregunta |
|---|---|---|
| 1 | Limpieza y resumen | ¿Cuántos datos hay y de cuándo? |
| 2 | Proporciones por denominación | ¿Cuánto se acumula y qué denominación explica el valor? |
| 3 | Mapa de calor día × momento | ¿Cuándo se ahorra? |
| 4 | Simulación Monte Carlo | ¿En qué fecha se llega a la meta, con un rango del 80 %? |
| 5 | Reglas + **Isolation Forest** | ¿Hay aperturas sin retiro, retiros inusuales o días raros? |
| 6 | Tasa de devolución | ¿Qué tan bien reconoce el monedero? |
| 7 | Resumen | Respuesta a la pregunta y preguntas de IPM |

**Dónde está la IA:** el Isolation Forest es un modelo de aprendizaje automático no supervisado (scikit-learn). Aprende cómo es un día normal de cada alcancía (cuánto se deposita, cuánto se retira, aperturas y devoluciones) y marca los días que se alejan de ese patrón, sin necesitar ejemplos de fraude. La simulación Monte Carlo no es IA, es estadística: convierte el ritmo de ahorro en un rango de fechas en lugar de una sola.

## Cómo ejecutarlo

1. Descarga los datos (la clave de servicio se toma de Supabase, **Project Settings → API**, y nunca se sube al repositorio):

   ```bash
   set SUPABASE_URL=https://oflheydjuluwqliunakd.supabase.co
   set SUPABASE_SERVICE_ROLE_KEY=<clave de servicio>
   python descargar_eventos.py
   ```

2. Abre `analisis_alcancia.ipynb` y ejecuta todas las celdas. En Google Colab, sube los dos CSV a una carpeta `datos/` primero.

Con `FUENTE = "simulado"` en la primera celda de código, el cuaderno genera cinco alcancías de ejemplo con dos anomalías sembradas. Sirve para ver el método funcionando, pero **esos datos no son resultados del proyecto** y no se presentan como tales.

## Estado de los datos

Hoy hay 21 eventos reales de 1 alcancía en 2 días, todos de pruebas. Alcanza para las partes 1, 2, 3 y 6, pero no para responder la pregunta con confianza:

- La proyección a la meta necesita al menos 5 días con movimientos.
- El Isolation Forest necesita al menos 20 días-alcancía para saber qué es normal.

## Cómo recolectar datos reales

**Participantes:** de 3 a 5 personas que reciban vuelto en efectivo, además del autor.

**Duración:** al menos 2 semanas, mejor 3.

1. Cada participante abre la app en su teléfono, toca **Empezar sin cuenta** y crea su alcancía con una meta propia. No necesita GitHub ni Wokwi.
2. Cada vez que recibe vuelto en la vida real, toca en **Echar dinero** las mismas monedas y billetes ese mismo día. La alcancía virtual envía los depósitos a la nube igual que el ESP32.
3. Cuando gasta efectivo ahorrado, hace un retiro desde la app con **Hacer retiro**.
4. Al final, `descargar_eventos.py` y el cuaderno con `FUENTE = "real"`.

La columna `fuente` de `eventos.csv` dice de dónde vino cada evento: `esp32` (la alcancía física o Wokwi), `alcancia_virtual` (los botones de la app) o `app` (retiros). Así el análisis puede separar los datos del prototipo de los de la alcancía física.

Para las preguntas de IPM, al cierre cada participante hace tres tareas cronometradas (decir su saldo, hacer un retiro de ₡1000 y cambiar la meta) y responde el cuestionario SUS de 10 preguntas. Los tiempos, los errores y el puntaje SUS responden "¿qué cambiarían en la interfaz?".

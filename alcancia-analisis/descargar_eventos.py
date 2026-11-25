"""Descarga los eventos de Supabase a CSV para el análisis.

Uso:
    set SUPABASE_URL=https://<proyecto>.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=<clave de servicio>
    python descargar_eventos.py

La clave de servicio salta las políticas RLS para leer todas las alcancías:
nunca se guarda en el repositorio ni se comparte. Los CSV salen anonimizados:
cada alcancía se identifica como "usuario_1", "usuario_2"... sin nombre ni id.
"""
import csv
import os
import sys
from pathlib import Path

import requests

CARPETA_DATOS = Path(__file__).parent / "datos"
POR_PAGINA = 1000


def leer_tabla(url_base, clave, tabla, columnas, orden):
    encabezados = {"apikey": clave, "Authorization": f"Bearer {clave}"}
    filas, desde = [], 0
    while True:
        respuesta = requests.get(
            f"{url_base}/rest/v1/{tabla}",
            params={"select": columnas, "order": orden},
            headers={**encabezados, "Range": f"{desde}-{desde + POR_PAGINA - 1}"},
            timeout=30,
        )
        respuesta.raise_for_status()
        pagina = respuesta.json()
        filas.extend(pagina)
        if len(pagina) < POR_PAGINA:
            return filas
        desde += POR_PAGINA


def escribir_csv(ruta, filas, columnas):
    with open(ruta, "w", newline="", encoding="utf-8") as archivo:
        escritor = csv.DictWriter(archivo, fieldnames=columnas)
        escritor.writeheader()
        escritor.writerows(filas)


def main():
    url_base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    clave = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url_base or not clave:
        sys.exit("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.")

    alcancias = leer_tabla(url_base, clave, "alcancias", "id,meta_colones,creada_en", "creada_en")
    eventos = leer_tabla(url_base, clave, "eventos",
                         "alcancia_id,tipo,denominacion,cantidad,origen,ocurrido_en", "ocurrido_en")

    # Anonimiza: el orden de creación decide el número de usuario
    alias = {a["id"]: f"usuario_{i}" for i, a in enumerate(alcancias, start=1)}

    CARPETA_DATOS.mkdir(exist_ok=True)
    escribir_csv(CARPETA_DATOS / "alcancias.csv",
                 [{"usuario": alias[a["id"]], "meta_colones": a["meta_colones"], "creada_en": a["creada_en"]}
                  for a in alcancias],
                 ["usuario", "meta_colones", "creada_en"])
    escribir_csv(CARPETA_DATOS / "eventos.csv",
                 [{"usuario": alias.get(e["alcancia_id"], "desconocido"), "tipo": e["tipo"],
                   "denominacion": e["denominacion"] or "", "cantidad": e["cantidad"],
                   "origen": e["origen"], "ocurrido_en": e["ocurrido_en"]}
                  for e in eventos],
                 ["usuario", "tipo", "denominacion", "cantidad", "origen", "ocurrido_en"])
    print(f"{len(alcancias)} alcancías y {len(eventos)} eventos guardados en {CARPETA_DATOS}")


if __name__ == "__main__":
    main()

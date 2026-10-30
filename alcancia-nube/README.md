# Alcancía: nube

Base de datos, seguridad y Edge Function de la alcancía en Supabase.

## Probar en local

Requiere Docker. Este proyecto usa los puertos 544xx para no chocar con otros proyectos.

```bash
npm install
supabase start
```

Copia `API_URL`, `ANON_KEY` y `SERVICE_ROLE_KEY` de la salida de `supabase status`, expórtalas como `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`, y ejecuta:

```bash
npm run prueba
```

## Publicar en Supabase

El proyecto ya está publicado con el identificador `oflheydjuluwqliunakd` y `alcancia-app/config.js` ya apunta a él. La contraseña de la base de datos está en `.env.local`. Estos pasos sirven para repetir la publicación.

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Conecta y publica, reemplazando `<ref>` por el identificador del proyecto:

```bash
supabase login
```

```bash
supabase link --project-ref <ref>
```

```bash
supabase db push
```

```bash
supabase functions deploy dispositivo --no-verify-jwt
```

3. En `alcancia-app/config.js` pon la URL del proyecto y su clave pública (anon).
4. Publica `alcancia-app` en un hosting estático con HTTPS, como GitHub Pages o Netlify.
5. Activa GitHub en Authentication > Providers, entra a la app y crea tu alcancía. Guarda el código y la clave que se muestran una sola vez.
6. Copia `alcancia-wokwi/secretos.ejemplo.h` como `secretos.h` y complétalo.

`secretos.h` y `.env.local` están excluidos del repositorio. Los proyectos gratuitos de Wokwi son visibles para otros: no guardes ahí la clave real.

## Probar la app sin hardware

```bash
node pruebas/simular_dispositivo.mjs <url-funcion> <codigo> <clave> 100 500 25
```

## Pendiente antes de la versión final

- Fijar el certificado de Supabase en el ESP32 en lugar de `setInsecure()`.
- Guardar la cola de eventos en memoria persistente: hoy se pierde si el ESP32 se reinicia sin conexión.

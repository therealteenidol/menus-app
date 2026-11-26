# 🍽️ Menús en familia

App web (PWA, se instala en el móvil) para organizar el **menú semanal con IA** y la **lista de la compra compartida** de toda la familia.

- **Familias**: cada persona tiene su cuenta; una crea la familia y comparte un enlace o código de invitación. Todos ven y editan lo mismo, y los cambios aparecen al instante en los demás móviles.
- **Gustos**: cada miembro apunta lo que le gusta, lo que no y sus alergias (también se pueden apuntar las de otro miembro, p. ej. los niños).
- **Menú con IA (Claude)**: genera la semana teniendo en cuenta los gustos de todos y los *tips* de la familia («pescado 2 veces», «cenas ligeras»…). Cada plato se puede editar a mano o cambiar por otra idea de la IA.
- **Lista de la compra**: se crea desde el menú, sumando ingredientes repetidos y agrupada por secciones del súper. Todos pueden añadir, marcar y borrar.

El agente que compra en dia.es llegará en una fase posterior.

## Cómo está hecha

| Parte | Dónde vive | Coste |
|---|---|---|
| La app (HTML + CSS + JavaScript, sin compilar nada) | GitHub Pages | Gratis |
| Cuentas, base de datos y tiempo real | [Supabase](https://supabase.com) | Gratis (plan Free) |
| Llamadas a la IA | Una *Edge Function* de Supabase (`supabase/functions/ai`) | Gratis en Supabase; Claude se paga aparte con tu API key (unos céntimos por menú) |

La **API key de Claude** se guarda cifrada (AES-GCM) en una tabla que el navegador no puede leer. Solo la Edge Function la descifra para llamar a Claude, así que nunca llega al móvil de nadie. Cada familia solo puede ver sus propios datos gracias a las reglas de seguridad (RLS) de la base de datos.

```
index.html, styles.css, js/          la app
config.js                            URL y clave pública de Supabase (lo rellenas tú)
manifest.webmanifest, sw.js, icons/  lo que la hace instalable (PWA)
supabase/migrations/0001_init.sql    tablas, seguridad y funciones de la base de datos
supabase/functions/ai/index.ts       función que habla con Claude
```

## Puesta en marcha (unos 15 minutos)

### 1. Crear el proyecto de Supabase

1. Entra en [supabase.com](https://supabase.com), crea una cuenta y pulsa **New project**. Elige una región de Europa (p. ej. *West EU (Ireland)*) y una contraseña para la base de datos (guárdala).
2. Cuando termine de crearse, ve a **SQL Editor → New query**, pega todo el contenido de [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) y pulsa **Run**. Debe terminar con *Success*.

### 2. Configurar el inicio de sesión

En **Authentication → URL Configuration**:

- **Site URL**: `https://therealteenidol.github.io/menus-app/`
- **Redirect URLs**: añade esa misma dirección y, si vas a probar en tu PC con WAMP, también `http://localhost/menus-app/`.

Opcional: en **Authentication → Sign In / Providers → Email** puedes desactivar *Confirm email* para que las cuentas funcionen sin tener que confirmar el correo. Si lo dejas activado, Supabase envía el email de confirmación (el plan gratis tiene un límite bajo de emails por hora).

### 3. Crear la función de IA

1. Genera una clave de cifrado. Lo más fácil: abre la consola del navegador (F12 → Consola), pega esto y copia el resultado (64 letras y números):
   ```js
   [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("")
   ```
2. En Supabase, ve a **Edge Functions → Secrets** y añade un secreto llamado `APP_ENCRYPTION_KEY` con ese valor. Guárdalo también en un sitio seguro: si lo pierdes o lo cambias, solo habrá que volver a escribir la API key de Claude en la app.
3. Ve a **Edge Functions → Deploy a new function → Via Editor**, llámala exactamente `ai`, borra el código de ejemplo, pega el de [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts) y pulsa **Deploy**.

   (Alternativa con terminal: `npx supabase login`, `npx supabase link --project-ref TU_REF` y `npx supabase functions deploy ai`.)

### 4. Conectar la app con Supabase

En **Project Settings → API** (o **API Keys**) copia la **Project URL** y la clave pública (**anon public** o **publishable key**) y pégalas en [`config.js`](config.js):

```js
window.MENUS_CONFIG = {
  supabaseUrl: "https://abcdefghijkl.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
};
```

Esta clave está pensada para ir en el navegador, no pasa nada por subirla a GitHub. **Nunca** pongas ahí la `service_role` / *secret key* ni la API key de Claude.

### 5. Publicarla en GitHub Pages

En el repositorio: **Settings → Pages → Build and deployment → Deploy from a branch**, rama `main`, carpeta `/ (root)`. En un par de minutos estará en `https://therealteenidol.github.io/menus-app/`.

### 6. Primer uso

1. Abre la web, crea tu cuenta y pulsa **Crear familia**.
2. En **Familia → Inteligencia artificial**, pega tu API key de Claude (se consigue en [console.anthropic.com](https://console.anthropic.com) → *API Keys*; hay que tener saldo en la cuenta).
3. Comparte el enlace de invitación con tu familia.
4. Cada uno rellena sus **Gustos**, y en **Menú** pulsa **Generar semana con IA**.

Para instalarla en el móvil: en Android (Chrome) menú ⋮ → *Añadir a pantalla de inicio*; en iPhone (Safari) botón compartir → *Añadir a pantalla de inicio*.

## Probar en local con WAMP

Copia la carpeta a `C:\wamp64\www\menus-app`, rellena `config.js` y abre `http://localhost/menus-app/`. No hace falta PHP ni MySQL: WAMP solo sirve los archivos. (Cualquier servidor estático vale, p. ej. `python -m http.server`.)

## Modelos de IA

Por defecto usa **Claude Opus 5.5**. El administrador de la familia puede cambiar a **Sonnet 5.5** o **Haiku 5.5** (más baratos) en *Familia → Inteligencia artificial*. La generación va en dos pasos para no superar el tiempo máximo de la función: primero los platos de la semana y después los ingredientes en tandas pequeñas.

## Cosas a saber

- El plan gratis de Supabase **pausa el proyecto tras una semana sin uso**. Si pasa, se reactiva desde el panel de Supabase con un clic.
- Si cambias la base de datos en el futuro, las nuevas migraciones irán en `supabase/migrations/` numeradas (`0002_…`), y se ejecutan igual desde el SQL Editor.
- Si actualizas la app y el móvil sigue mostrando la versión vieja, cierra y vuelve a abrir la app (el service worker se actualiza solo).

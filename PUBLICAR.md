# Publicar Inventario LEGO con Supabase

GitHub Pages sirve la interfaz desde `docs/`. Supabase Auth identifica tu cuenta y la función `lego` guarda los sets, piezas, cajas y fotos en PostgreSQL. Puedes seguir abriendo la aplicación local con `node server.mjs`.

## 1. Crear el proyecto en Supabase

1. Crea un proyecto. En **SQL Editor**, ejecuta el contenido de `supabase/migrations/20261117000000_inventario.sql` para instalar las tablas y funciones.
2. En **Authentication → Users**, crea y confirma el usuario con el correo que usarás para entrar. Si usas el correo integrado de Supabase, utiliza un correo que pertenezca a la organización del proyecto. Para otros destinatarios, configura SMTP propio. En **Authentication → Email Templates**, edita **Magic Link** para mostrar un código, por ejemplo `<p>Tu código de acceso es {{ .Token }}</p>`. El formulario de la app enviará el código al correo de ese usuario.
3. En **Edge Functions → Secrets**, añade `LEGO_OWNER_ID` con el UUID del usuario creado y `LEGO_ORIGIN` con el origen de GitHub Pages, por ejemplo `https://TU-USUARIO.github.io`, sin ruta ni barra final. Si usas un dominio personalizado de Pages, escribe su origen HTTPS. La función valida la sesión con Supabase Auth y comprueba ese UUID antes de acceder a la base.
4. Desde la carpeta descomprimida, publica la función con la CLI de Supabase. Se puede usar con Node.js 24 y `npx`.

```powershell
npx supabase login
npx supabase functions deploy lego --project-ref TU_PROJECT_REF --use-api
```

Consulta [las plantillas OTP](https://supabase.com/docs/guides/auth/auth-email-templates), [los límites del correo integrado](https://supabase.com/docs/guides/auth/auth-smtp) y [el despliegue de funciones](https://supabase.com/docs/guides/functions/deploy).

## 2. Llevar tu inventario actual

Hazlo antes de registrar cambios en el inventario web. Usa la base que contiene tu colección actual, normalmente `datos/inventario.sqlite` en la instalación local. La migración lee los cambios confirmados y transfiere el inventario y las fotos en una transacción. La base de origen se abre en modo de solo lectura.

En **Settings → API Keys** de Supabase, copia una clave privada que empiece por `sb_secret_`. En PowerShell, introdúcela desde el terminal local y ejecuta:

```powershell
$env:SUPABASE_SECRET_KEY = [Net.NetworkCredential]::new('', (Read-Host 'Clave privada de Supabase' -AsSecureString)).Password
try {
    node .\migrar-supabase.mjs '.\datos\inventario.sqlite' 'https://TU_PROJECT_REF.supabase.co'
} finally {
    Remove-Item Env:SUPABASE_SECRET_KEY
}
```

Sustituye la ruta si tu copia SQLite está en otra carpeta. El comando imprime el número de sets, cajas, listados y fotos. Guarda la base SQLite y las claves privadas fuera del repositorio.

## 3. Publicar GitHub Pages

1. Descomprime el paquete. Edita `docs/config.js` y pon la URL HTTPS del proyecto y la **clave publicable** de Supabase que empieza por `sb_publishable_`.
2. Sube los archivos descomprimidos a la raíz del repositorio. Incluye la carpeta `.github`. En **Settings → Pages**, elige **Deploy from a branch → main → /docs**.
3. Abre la página, escribe tu correo y usa el código recibido. Comprueba los datos migrados desde el ordenador y el móvil. La sesión se mantiene mientras la pestaña está abierta.

Para actualizar la interfaz y los módulos de la función en el futuro, ejecuta `node preparar-pages.mjs --supabase` y vuelve a publicar los archivos cambiados. El comando conserva la configuración de Supabase que ya esté en `docs/config.js`.

## 4. Activar la consulta periódica

1. En **Settings → Secrets and variables → Actions**, crea una variable **SUPABASE_URL** con `https://TU_PROJECT_REF.supabase.co`. En **Secrets**, crea **SUPABASE_PUBLISHABLE_KEY** con la misma clave publicable de `docs/config.js`.
2. Abre **Actions → Actividad de Supabase → Run workflow**. La ejecución debe mostrar «Consulta a PostgreSQL correcta». El workflow consulta la base tres veces al día, a las 07:17, 15:17 y 23:17 UTC.

La consulta verifica la disponibilidad de la base. El plan gratuito puede pausar proyectos con actividad insuficiente. En repositorios públicos GitHub puede desactivar el calendario después de 60 días de inactividad del repositorio. Si Supabase ya está pausado, reactívalo desde su panel. Consulta [la política de pausas de Supabase](https://supabase.com/docs/guides/platform/free-project-pausing) y [las ejecuciones programadas de GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

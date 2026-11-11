# Pipeline Reclamos · Puesta en marcha (Google)

Corre sobre **Google Apps Script + Google Sheets + Google Drive**, igual que Biprop y Pipeline ACM.
Hacé todos los pasos **logueado como `mantenimiento@juarezbeltran.com.ar`**, en una ventana con esa sola cuenta.

| Archivo | Qué es |
|---|---|
| `Code.gs` | Backend: permisos, planilla, etapas, proveedores, adjuntos, Biprop, alertas, mails |
| `Index.html` | La app (pantallas, estilos y lógica en un solo archivo) |
| `appsscript.json` | Permisos que pide y acceso por dominio |

## Paso 1 · Crear el proyecto de Apps Script

1. Entrá a <https://script.google.com> → **Nuevo proyecto**. Nombre: **Pipeline Reclamos**.
2. Reemplazá el contenido de `Código.gs` por **todo** `Code.gs`.
3. **+** → **HTML** → nombralo `Index` (sin `.html`) y pegá **todo** `Index.html`.
4. ⚙ Configuración del proyecto → tildá **"Mostrar el archivo de manifiesto appsscript.json"** → pegá el `appsscript.json` de esta carpeta.
5. Guardá (Ctrl+S).

No hay IDs para pegar en el código: la planilla y la carpeta las crea el paso siguiente.

## Paso 2 · Instalar

1. En el desplegable de funciones elegí **`instalar`** y tocá **Ejecutar**. Autorizá los permisos con `mantenimiento@`.
2. `instalar` crea la planilla **Pipeline Reclamos · Base** y la carpeta **Reclamos** en el Drive de `mantenimiento@`,
   arma las ocho hojas, carga los rubros iniciales y la hoja `Config`, toma el padrón de la planilla de Biprop si la encuentra, comparte la carpeta en solo lectura con Gerardo y
   Máximo, y programa dos disparadores: `tic` (cada hora: mails y reintentos de Biprop) y `dailyBackup` (~03:00).
3. En **Registro de ejecución** tienen que aparecer renglones `OK`. Los `OJO` sobre Biprop se resuelven en el Paso 5.

Se puede volver a ejecutar `instalar` las veces que haga falta: no duplica nada.

## Paso 3 · Publicar como aplicación web

1. **Implementar → Nueva implementación → Aplicación web**.
2. **Ejecutar como:** *Yo* (`mantenimiento@`). **Quién tiene acceso:** *Cualquier usuario de Juárez Beltrán*.
3. **Implementar**. La URL que termina en `/exec` es la app.

Aunque el acceso sea para el dominio, solo entran las tres cuentas de la lista `USUARIOS` de `Code.gs`.

> Para actualizar: pegá los archivos nuevos y **Implementar → Gestionar implementaciones → ✎ → Versión: Nueva → Implementar**.
> Así la URL no cambia.

## Paso 4 · Página de acceso (GitHub Pages)

1. En el `index.html` de la **raíz** del repo, reemplazá `PEGAR_AQUI_LA_URL_DE_LA_APP` por la URL `/exec`.
2. GitHub → **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
3. Queda en **https://majaxu.github.io/reclamos/**. Para el ícono en el celular: `https://majaxu.github.io/reclamos/?instalar`.
4. En la hoja `Config` de la planilla, poné esa dirección o la `/exec` en `url_app` (la usan los enlaces de los mails).

## Paso 5 · Conectar con Biprop

Primero hay que publicar en Biprop la versión que trae las acciones para Reclamos (rama `reclamos-integracion` del repo Biprop).

En **Pipeline Reclamos** → ⚙ Configuración del proyecto → **Propiedades de la secuencia de comandos**:

| Propiedad | Valor |
|---|---|
| `BIPROP_SHEET_ID` | ID de la planilla *Historial Multimedia · Base* (de ahí se lee el padrón de propiedades) |
| `BIPROP_URL` | URL `/exec` de Biprop |
| `BIPROP_TOKEN` | La misma clave que `API_TOKEN` en las propiedades de Biprop |

Después ejecutá **`verificarInstalacion`**: tiene que decir "Padrón de Biprop: N propiedades" y "Biprop responde por la
puerta de servicio". Recién entonces, en la hoja `Config`, cambiá **`biprop_activo`** a `sí`. Los adjuntos que hayan quedado
pendientes se envían solos en la hora siguiente (o al momento, ejecutando `enviarPendientesBiprop`).

Con solo `BIPROP_SHEET_ID` cargado ya se ve el padrón de propiedades, aunque la integración esté apagada.

## Hoja Config (se cambia sin tocar código)

| Clave | Por defecto | Qué es |
|---|---|---|
| `dias_trabado_urgencia_4_5` / `_3` / `_1_2` | 1 / 3 / 7 | Días sin movimiento para marcar Trabado |
| `dias_pausa` | 3 | Días sin movimiento para alertar un reclamo En pausa |
| `mail_diario_activo`, `_para`, `_dias`, `_hora` | sí, mantenimiento@, 1 a 5, 8 | Mail diario a Rodrigo |
| `mail_semanal_activo`, `_para`, `_dia`, `_hora` | sí, gperez@ y mjuarez@, 1, 8 | Resumen semanal |
| `biprop_activo` | no | Enviar a Biprop los adjuntos del ingreso y de la finalización |
| `url_app` | vacío | Dirección de la app para los enlaces de los mails |

Los horarios y el contenido de los mails son valores por defecto, **no confirmados por Máximo**.
Los mails salen dentro de la hora siguiente a la configurada (el disparador corre una vez por hora).

## Probar

1. Abrí la URL `/exec`: arriba a la derecha tiene que decir "Sesión: Rodrigo".
2. **Nuevo reclamo** con una propiedad de prueba y dos adjuntos. Revisá la carpeta `Reclamos/R-0001_XXXX/` en Drive.
3. Recorré las siete etapas hasta cerrar. Probá un rechazo en la etapa 4 (queda En pausa) y una reapertura.
4. Ejecutá `enviarDiario` desde el editor y revisá el mail.
5. Para borrar las pruebas: borrá las filas de las hojas `Reclamos`, `Presupuestos`, `Adjuntos`, `Notas` e `Historial`,
   y las carpetas de prueba en Drive. Los números de reclamo no se reutilizan salvo que además borres la propiedad
   `ULTIMO_RECLAMOS` en las Propiedades de la secuencia de comandos.

## Preguntas frecuentes

**¿Quién entra?** Solo las cuentas de `USUARIOS` en `Code.gs` (Rodrigo con mantenimiento@, Gerardo y Máximo). Para
sumar a alguien se agrega ahí y se publica una versión nueva.

**¿Dónde están los datos?** En la planilla `Pipeline Reclamos · Base`. Se puede abrir y filtrar, pero no cambies el orden
ni el nombre de las columnas. La hoja `Config` sí está pensada para editarse a mano.

**Un archivo de menos de 30 MB falló.** Puede pasar con conexiones lentas. Se vuelve a elegir y se sube de nuevo.

# Inventario LEGO · Web propia

Aplicación para tablet con una base SQLite en el servidor. Mis sets, Cajas y Faltantes comparten los mismos datos. El servidor acepta una colección por instalación. Los dispositivos ven los cambios al actualizar o en el siguiente refresco automático.

Para usar GitHub Pages con tu colección sincronizada en Supabase, sigue [la guía de publicación y migración](PUBLICAR.md).

## Arranque en Windows

Requisito: Node.js 24 o superior. En PowerShell, abre esta carpeta y ejecuta:

```powershell
node .\server.mjs
```

Abre http://127.0.0.1:4173. En «Mis sets», pulsa «Añadir set» o importa el HTML de un set. Para parar el servidor, pulsa Ctrl+C.

## Prueba desde la tablet en la misma red

Ejecuta el siguiente comando en la carpeta de la web. El script pide la contraseña de la colección y muestra las direcciones de red a las que puedes conectarte:

```powershell
.\Iniciar.ps1 -EnRed
```

Abre en la tablet la dirección IPv4 del ordenador con el puerto 4173. Usa la misma contraseña en ambos dispositivos. El ordenador debe seguir encendido y la red Wi-Fi debe ser de confianza. Es una prueba por HTTP en tu red local. Para acceder desde fuera de casa, aloja el servidor en un equipo con almacenamiento persistente y un proxy HTTPS, configura APP_PASSWORD, APP_ORIGIN y APP_SECURE_COOKIE=1. El acceso remoto y la instalación como app con HTTPS quedan pendientes de despliegue.

## Catálogo y fotos

- **Añadir set.** Selecciona el código de un inventario del catálogo o impórtalo desde un HTML. En ambos casos puedes indicar un nombre y subir una foto principal. Al reimportar un set, los campos vacíos conservan el nombre y la foto que ya tenga.

- **Fotos del set.** Abre un set y pulsa «Fotos del set». Puedes subir varias imágenes JPG, PNG, WebP o GIF, abrirlas desde sus miniaturas y pulsar «Marcar como principal». La primera foto subida es la principal inicialmente. Se muestra en la tarjeta de Mis sets y el código sigue visible debajo. Las fotos se guardan en la misma base de datos del inventario.

- **Importar HTML** desde «Mis sets» o «Piezas». Indica el código del set (por ejemplo, 31058) y selecciona el archivo .html o .htm de «Export Parts» → «HTML Table» (máximo 2 MB). Con el mismo código, la app compara el inventario y guarda los cambios en el set existente. Si es un código nuevo, lo añade a Mis sets. Las imágenes con enlaces de Rebrickable se cargan con conexión a internet. Las referencias a archivos locales muestran «Sin imagen».
- **Mis sets** tiene un único registro por código. Al unificar datos anteriores se conserva el inventario completo si había una muestra. Para referencias y colores compatibles se conserva el mayor recuento directo registrado y se mantienen las asignaciones hasta la cantidad necesaria. El excedente vuelve a quedar disponible en su caja.
- **Eliminar set** borra su listado, recuento y fotos tras dos confirmaciones. Las referencias siguen en «Piezas» y las unidades asignadas vuelven a estar disponibles en sus cajas. Para añadir de nuevo el mismo set, vuelve a importar su inventario.
- **Inventario del set.** Por defecto las piezas salen agrupadas bajo el nombre de su color. Puedes filtrar por color o tipo y cambiar el orden a nombre o tipo. Usa −, +, Todas o X directamente en cada fila. Guardar una cantidad o cambiarla desde la fila marca la pieza como revisada. Las unidades que queden por conseguir aparecen en «Faltantes». X confirma el recuento a cero, registra todas las unidades como faltantes y libera las asignaciones de esa fila en sus cajas. Los tipos se deducen de la descripción de la pieza. Desde el panel de la pieza puedes consultar los sets donde falta y los que tienen unidades registradas. Usa «Ocultar detalle» para ampliar el listado.
- **Piezas** reúne las referencias por código y color de los inventarios cargados. Puedes buscar por nombre, código o color, ampliar la imagen y consultar los sets que llevan esa pieza, con las unidades registradas en Mis sets.

Correspondencias de nombres e IDs de color adaptadas de [TabOtter](https://tabotter.com/lego-color-names/), a partir de Rebrickable y LDraw, bajo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). El importador utiliza solo el nombre y el ID de Rebrickable y traduce algunos nombres al español.

- **Muestra incluida** con líneas seleccionadas de 60411, 31058 y 31032. Está marcada como parcial e incluye una minifigura de prueba. Las fotos apuntan a fichas del catálogo y requieren internet. Si una foto falla, se muestra «Sin imagen».
- **Importar CSV** desde Mis sets. Usa [la plantilla de muestra](catalogo/Muestra-inventario.csv) como estructura. El CSV contiene una fila por pieza, color, versión y condición de repuesto. Usa los IDs de color de Rebrickable cuando compartas piezas entre fuentes. Para una versión verificada, usa un identificador nuevo distinto de `muestra`.
- **Rebrickable** se habilita si el proceso recibe `REBRICKABLE_API_KEY`. Las credenciales se leen solo en el servidor. Si el inventario cambia, se actualiza el registro del mismo código. La API y la cobertura completa de fotos quedan pendientes de probar con una clave real. Contrasta la variante del 31058 con tus instrucciones.

Fuentes de la muestra: [31058 en BrickLink](https://www.bricklink.com/CatalogItemInv.asp?S=31058-1), [31032 en BrickLink](https://www.bricklink.com/catalogItemInv.asp?S=31032-1&bt=0&sortAsc=A&sortBy=0&v=0), [60411 en BrickLink](https://www.bricklink.com/CatalogItemInv.asp?S=60411-1) y [documentación de Rebrickable](https://rebrickable.com/api/v3/docs/).

## Recorrido para comparar

1. Desde «Añadir set», elige los inventarios de 60411, 31058 y 31032 uno a uno. Abre el 60411, guarda un recuento parcial y comprueba que las unidades restantes aparecen en «Faltantes».
2. Crea una caja, busca **53451** y guarda **13**. Asigna **4** a Grandes dinosaurios y **9** a Criaturas Rojas.
3. En Criaturas Rojas, selecciona esa garra y pulsa «Confirmar faltantes». En Faltantes verás **3** del set 31032. Abre «Dónde la estoy usando» para ver **4** y **9** en los respectivos sets.
4. Abre la colección en un segundo dispositivo. Comprueba que el recuento coincide y prueba el filtro por color y la exportación.
5. Con una sola unidad libre en una caja, comprueba que dos asignaciones simultáneas solo guardan una.

Los datos se guardan en `datos/inventario.sqlite`. Para hacer una copia de seguridad manual, detén el servidor y copia la carpeta `datos`. El CSV de faltantes es un listado para reposición.


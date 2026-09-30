# Activar el álbum de fotos del casamiento (5 minutos)

Esto conecta la página de fotos con tu Google Drive. Las fotos y videos de los invitados
se guardan en tu cuenta, en la carpeta **"Casamiento Jesús & Dana"**.

Te vamos a pasar dos textos para pegar, como archivos adjuntos o mensajes:
**"el archivo Code.gs"** y **"el archivo appsscript.json"**. Tenelos a mano.

## Pasos

1. Entrá a https://script.google.com con tu cuenta de Google y tocá **Nuevo proyecto**.
2. Arriba a la izquierda, cambiá el nombre "Proyecto sin título" por **Álbum casamiento**.
3. Borrá todo el texto del editor y pegá el código del archivo `Code.gs` que te pasamos.
   Después **guardá con Ctrl+S**. Mientras no lo hagas, la pestaña muestra
   "Cambios sin guardar" y un punto naranja al lado del nombre del archivo; cuando
   guardás, desaparecen.
4. Tocá el engranaje **Configuración del proyecto** (barra de la izquierda) y activá
   **Mostrar el archivo de manifiesto "appsscript.json" en el editor**.
   Ojo: eso no sube nada, solo hace que el archivo aparezca en la lista.
5. Volvé al editor (el ícono `< >` de la barra de la izquierda). Arriba de `Código.gs`,
   en la lista de **Archivos**, ahora aparece `appsscript.json`. Hacé clic ahí, borrá todo
   su contenido, pegá el texto del archivo `appsscript.json` que te pasamos y
   **guardá con Ctrl+S**.
6. Tocá **Implementar → Nueva implementación**. En el engranaje de "Seleccionar tipo",
   elegí **Aplicación web**.
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
7. Tocá **Implementar** y después **Autorizar acceso**. Elegí tu cuenta.
8. Google va a mostrar **"Google no verificó esta app"**. Es normal: la app la creaste vos
   y solo accede a tu Drive. Tocá **Configuración avanzada** → **Ir a Álbum casamiento (no seguro)**
   → **Permitir**.
9. Copiá la **URL de la aplicación web** (termina en `/exec`).

### Chequeo rápido

Pegá esa URL `/exec` en una pestaña nueva del navegador. Tiene que aparecer exactamente:

```
{"ok":true,"service":"wedding-upload"}
```

Si aparece eso, está todo bien: mandánosla. Si aparece otra cosa, mandanos una captura y lo vemos.

Listo. Nosotros conectamos la página y hacemos una prueba final.

## Preguntas frecuentes

- **¿Pueden ver mi Drive los invitados?** No. Solo pueden subir archivos; no ven nada.
- **¿Dónde quedan las fotos?** En la carpeta "Casamiento Jesús & Dana" de tu Drive.
- **¿Cómo lo desactivo después?** En script.google.com → Álbum casamiento →
  Implementar → Gestionar implementaciones → Archivar.

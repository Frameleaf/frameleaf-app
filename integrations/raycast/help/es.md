# Usar Frameleaf en Raycast

1. Instala la extensión de Frameleaf en Raycast y abre **Search Photos** o **Browse Albums**.
2. Introduce la dirección de tu Library, por ejemplo `https://photos.example.com`. HTTP sin cifrar solo funciona con direcciones de tu propia red, como `http://192.168.1.20:2283`; en ese caso, el inicio de sesión y las fotos viajan sin cifrar por esa red.
3. Inicia sesión en tu Library en el navegador y elige los álbumes que Raycast puede leer, o permite toda tu biblioteca. Vuelve a Raycast.

Selecciona una foto para ver una vista previa. Desde el panel de acciones puedes abrirla en Frameleaf, copiar la imagen o su enlace, o descargarla. Las descargas son JPEG grandes sin ubicación ni datos de la cámara y nunca sustituyen un archivo existente.

Para descargar originales, activa **Original downloads** en las preferencias de la extensión. Tu Library te pedirá permiso la próxima vez que te conectes; en cualquier foto, elige **Allow Original Downloads** para volver a conectarte. Los originales conservan la ubicación y los datos de la cámara.

Una conexión directa no necesita un plan de Frameleaf Cloud; el relé de Frameleaf depende de tu plan de Cloud. Si tu Library no permite que las apps se registren solas, pide a su administrador que registre la dirección de retorno `https://raycast.com/redirect?packageName=Extension` e introduce el ID de cliente en las preferencias de la extensión.

Raycast no puede ver personas, ubicaciones, elementos compartidos ni otros álbumes, y no puede cambiar ni eliminar nada. Cambia sus álbumes en **Apps conectadas**, en los ajustes de tu Library. **Disconnect Library** revoca el acceso; si no se puede contactar con tu Library, Raycast conserva su sesión para que puedas volver a intentarlo. Las fotos que ya descargaste permanecen en tu ordenador.

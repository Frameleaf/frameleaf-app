# Publicar desde Lightroom Classic

1. Descarga el ZIP del plugin de Frameleaf, descomprímelo y, en Lightroom Classic, elige **Archivo → Administrador de plugins → Añadir**. Selecciona `frameleaf.lrplugin`.
2. En el panel **Servicios de publicación**, haz clic en **Configurar** junto a Frameleaf. Escribe la dirección de tu biblioteca, por ejemplo `https://photos.example.com` o `http://192.168.1.20:2283`. Deja **ID de la app** vacío, salvo que tu administrador haya registrado Lightroom para ti.
3. Haz clic en **Conectar…**. Tu navegador abre Frameleaf. Inicia sesión, elige los álbumes a los que Lightroom puede añadir fotos y permite crear álbumes nuevos si quieres que cada colección tenga su propio álbum. Cuando el navegador vuelva a Lightroom, el cuadro de diálogo mostrará **Conectado**.
4. Crea una colección publicada. En sus ajustes, elige un álbum de Frameleaf existente o deja **Crear un álbum nuevo**. Arrastra las fotos y haz clic en **Publicar**.

Lightroom envía JPEG sRGB con su título, leyenda, palabras clave y derechos de autor. La ubicación se elimina salvo que marques **Incluir ubicación**, y las etiquetas de personas nunca se envían. Marca **Añadir las palabras clave de Lightroom como etiquetas de Frameleaf** antes de conectar para etiquetar también las fotos en Frameleaf.

Frameleaf conserva todas las copias que publicas. Si vuelves a publicar una foto editada, se añade una copia nueva junto a la anterior. Quitar una foto o una colección en Lightroom nunca elimina nada de Frameleaf.

Conectar desde tu red doméstica o con tu propia dirección HTTPS no requiere un plan de Frameleaf Cloud. Conectar mediante el relé de Frameleaf requiere un plan que incluya acceso remoto.

Si Lightroom dice que la conexión ha terminado, abre los ajustes del servicio de publicación y haz clic en **Conectar…** otra vez. **Desconectar** cierra la sesión de Lightroom y elimina su acceso en Frameleaf; también puedes quitar Lightroom en Frameleaf, en **Ajustes › Tu inicio de sesión y privacidad › Apps conectadas**.

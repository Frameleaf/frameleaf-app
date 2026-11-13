# Importar imágenes de Frameleaf

1. Instala y activa el ZIP Frameleaf Connect en WordPress.
2. Como administrador, abre **Medios → Frameleaf** y añade el origen HTTPS de tu Library. Permite la red privada solo para tu propia Library. Si el registro automático está desactivado, registra la dirección de retorno exacta mostrada en Frameleaf Connect e introduce su ID de cliente.
3. Cada editor elige **Conectar Frameleaf** y autoriza los álbumes seleccionados. La dirección de retorno de WordPress requiere HTTPS con un certificado de confianza.
4. En el selector de medios de Gutenberg o del editor clásico, elige **Frameleaf**. Explora un álbum o busca, acepta la copia local e importa la imagen. Edita la leyenda y el texto alternativo con los controles de WordPress.

Las imágenes JPEG, PNG y WebP importadas se convierten en adjuntos normales de WordPress con la visibilidad del sitio. Permanecen tras desconectar o revocar el acceso. No hay sincronización ni eliminación en segundo plano. Cada nueva importación descarga la representación actual para comparar su SHA-256: el contenido idéntico reutiliza el adjunto; el contenido cambiado crea otra copia.

El servidor WordPress debe acceder a Library y confiar en su certificado. El acceso HTTPS local o proporcionado por el cliente no necesita un plan Frameleaf Cloud; el relé Frameleaf requiere su plan habitual. Los archivos deben respetar el límite de WordPress y el del plugin de 16 MiB / 40 megapíxeles.

Si no hay conexión, comprueba la dirección y el certificado y vuelve a conectarte. Una renovación incierta requiere reconexión. Desconectar reintenta la revocación y conserva las credenciales cifradas hasta completarla. Tras cambiar las claves o sales de WordPress, revoca el acceso en Frameleaf, confírmalo aquí y elige **Restablecer tras cambiar una clave de WordPress**.

Un fallo de importación elimina los datos temporales. Una publicación interrumpida con un recibo incierto bloquea duplicados automáticos. Pide al administrador revisar el adjunto local y el registro pendiente `frameleaf_imports` antes de recuperar. Nunca borres registros pendientes sin revisarlos. Soporte: support@frameleaf.app.

Frameleaf requiere PHP cURL compatible con HTTPS y una ruta de red directa a Library. Las solicitudes a Library no utilizan proxies HTTP.

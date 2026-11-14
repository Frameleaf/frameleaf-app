# Conectar Frameleaf a n8n

Utiliza n8n autoalojado en modo normal con un único proceso. No se admiten el modo de cola, varios workers ni n8n Cloud. La interfaz del nodo n8n está en inglés.

1. Instala el nodo comunitario Frameleaf y añade una credencial Frameleaf OAuth2 API.
2. Copia exactamente OAuth Redirect URL. Pide al administrador de tu Library que la registre como cliente público PKCE con una devolución HTTPS de confianza.
3. Introduce Library URL y el Client ID proporcionado por el administrador. Elige el perfil mínimo de permisos y conecta.
4. Selecciona por separado los álbumes que se pueden leer y los destinos de escritura. Vuelve a conectar tras cambiar la dirección o los permisos.

El acceso directo por LAN o HTTPS propio no requiere un plan Frameleaf Cloud. El acceso mediante retransmisión requiere un plan compatible. Mantén activadas la validación de certificados y la protección de red de n8n; permite únicamente tu Library cuando sea necesario.

Para crear álbumes y subir archivos, asigna a Source ID una identidad estable del evento original. Las subidas también necesitan una Source Date estable. Conserva el ID, la fecha, el nombre, el contenido y el destino al reintentar. Espera el plazo Retry-After indicado. Los archivos utilizan campos binarios de n8n; las descargas tienen un límite de tamaño configurable.

Los disparadores para fotos nuevas, adiciones a álbumes y exportaciones de Studio llegarán en una próxima versión. Mientras tanto, inicia los flujos con otro disparador, como una programación o un webhook.

Para desconectar, revoca el acceso en Frameleaf y elimina la credencial de n8n. Las copias guardadas en otros lugares permanecen allí. Contacta con support@frameleaf.app indicando la operación y el estado HTTP, sin credenciales, nombres de archivos privados ni contenido multimedia.

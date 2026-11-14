# Frameleaf Connect para Zapier

Beta privada. Los disparadores, búsquedas, acciones y archivos están implementados; aún se requieren la calificación alojada y la revisión de Zapier. No publiques este paquete.

La conexión solicita library:read, library:download, albums:write, tags:write, photos:upload, boards:upload y events:read. En el consentimiento de Frameleaf, elige los álbumes propios exactos que se pueden leer y los álbumes o espacios de trabajo donde se puede escribir. Leer toda la Library es una opción explícita. Nunca se solicitan personas, compartir, retirar ni eliminar.

Zapier debe acceder a una dirección HTTPS pública de Library. Tu propio HTTPS no requiere un plan de Frameleaf Cloud; el relé de Frameleaf necesita un plan apto. Las suscripciones y límites de Zapier son independientes. No admite acceso exclusivo por LAN.

Obtén en Zapier la URL de retorno exacta de esta aplicación privada. Un administrador de Frameleaf debe registrarla en Connect y facilitar el ID de cliente no secreto. Introduce el origen canónico del servidor y el ID, y autoriza en el navegador. Nunca pegues tokens en campos de un Zap.

Los disparadores de eventos comprueban los 1000 eventos coincidentes más recientes en cada sondeo. Si hay más de 1000 eventos entre dos sondeos, se omiten los más antiguos; no es una sincronización sin pérdidas.

Las acciones que crean algo requieren un ID de origen que se mantenga igual para el mismo elemento, como el ID del paso anterior. Así, las repeticiones, reintentos y ejecuciones simultáneas crean un único álbum o archivo, sin duplicados.

Los archivos solo se obtienen cuando un paso posterior los usa, con el acceso actual de la conexión. Revocar el acceso en las aplicaciones conectadas de Frameleaf detiene los archivos posteriores; no puede eliminar las copias ya enviadas a otro lugar. Quitar la conexión de Zapier no revoca la autorización de Frameleaf.

Antes de publicar, califica la aplicación alojada: OAuth en el navegador con la devolución real, varios Zaps que comparten una conexión que caduca y producen una única rotación segura, una respuesta de renovación perdida, la revocación, y cada disparador, búsqueda, acción y archivo con una Library de prueba.

# Frameleaf Connect para Zapier

Solo incluye la base de conexión. Las acciones, búsquedas, archivos y activadores aún no están disponibles. No publiques este paquete ni lo uses en producción.

Esta conexión de prueba solo solicita library:read. Selecciona tus álbumes exactos al autorizar en Frameleaf; leer toda la biblioteca requiere una elección explícita. No solicita originales, personas ni escritura.

Zapier debe acceder a una dirección HTTPS pública de Library. Tu propio HTTPS no requiere un plan de Frameleaf Cloud; el relé de Frameleaf necesita un plan apto. Las suscripciones y límites de Zapier son independientes. No admite acceso exclusivo por LAN.

Obtén en Zapier la URL de retorno exacta de esta aplicación privada. Un administrador de Frameleaf debe registrarla en Connect y facilitar el ID de cliente no secreto. Introduce el origen canónico del servidor y el ID, y autoriza en el navegador. Nunca pegues tokens en campos de un Zap.

Hay que validar OAuth alojado y la renovación simultánea antes de añadir funciones. Comprueba que varios Zaps con una conexión compartida realizan una única rotación segura, guardan todos los tokens nuevos, conservan las credenciales tras una respuesta incierta y revocan correctamente. Este código no demuestra esos comportamientos de la plataforma.

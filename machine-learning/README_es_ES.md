# Frameleaf machine learning

- Incorporación de CLIP
- Reconocimiento facial

# Configuración

Este proyecto utiliza [uv](https://docs.astral.sh/uv/getting-started/installation/), así que asegúrate de instalarlo primero.
Ejecutar `uv sync --extra cpu` instalará todo lo necesario en un entorno virtual aislado. Para usar aceleración, sustituye `--extra cpu` por `--extra cuda`, `--extra rocm` o `--extra openvino`.

Para agregar o eliminar dependencias, puedes utilizar los comandos `uv add $PACKAGE_NAME` y `uv remove $PACKAGE_NAME`, respectivamente.
Asegúrate de hacer commit de los archivos `uv.lock` y `pyproject.toml` para reflejar cualquier cambio en las dependencias.

# Pruebas de carga

Para medir la velocidad y latencia de inferencia, puedes utilizar [Locust](https://locust.io/) con el archivo `locustfile.py` proporcionado.
Locust funciona haciendo consultas a los puntos finales del modelo y agregando estadísticas, lo que significa que la aplicación debe estar desplegada.
Ejecuta `locust --web-host 127.0.0.1` y abre `localhost:8089` en un navegador para acceder a la interfaz; consulta la [documentación](https://docs.locust.io/en/stable/index.html). Ten en cuenta que, en la jerga de Locust, la concurrencia se mide en `usuarios`, y cada usuario ejecuta una tarea a la vez. Para lograr una concurrencia específica por punto final, multiplica ese número por la cantidad de puntos finales que se desean consultar. Por ejemplo, si hay 3 puntos finales y deseas que cada uno de ellos reciba 8 solicitudes al mismo tiempo, debes configurar el número de usuarios en 24.

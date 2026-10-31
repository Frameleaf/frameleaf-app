# Frameleaf apprentissage machine

- Embarquement de CLIP
- Reconnaissance faciale

# Mise en place

Ce projet utilise [uv](https://docs.astral.sh/uv/getting-started/installation/), donc soyez certain de l'installer en premier.
Exécuter `uv sync --extra cpu` installera tout ce dont vous avez besoin dans un environnement virtuel isolé. Pour l'accélération, remplacez `--extra cpu` par `--extra cuda`, `--extra rocm` ou `--extra openvino`.

Pour ajouter ou supprimer des dépendances, vous pouvez utiliser les commandes `uv add $PACKAGE_NAME` et `uv remove $PACKAGE_NAME` respectivement.
Soyez sûr de commit les fichiers `uv.lock` et `pyproject.toml` pour refléter les changements de dépendances.

# Test de charge

Pour mesurer le débit d'inférence et la latence, vous pouvez utiliser [Locust](https://locust.io/) avec le fichier fourni `locustfile.py`.
Locust fonctionne en interrogeant les endpoints des modèles et en agrégeant leurs statistiques, signifiant que l'application doit être déployée.
Exécutez `locust --web-host 127.0.0.1` et ouvrez `localhost:8089` dans un navigateur pour accéder à l'interface ; voir la [documentation](https://docs.locust.io/en/stable/index.html). Notez que dans le jargon de Locust, la concurrence est mesurée en `users` et que chaque user exécute une tâche après l'autre. Pour parvenir à une concurrence par endpoint, multipliez ce nombre par le nombre d'endpoints à interroger. Par exemple, s'il y a 3 endpoints et que vous voulez que chacun d'entre eux reçoive 8 requêtes à la fois, vous devrez mettre ce nombre d'users à 24.

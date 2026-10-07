"""Run the restoration worker: ``python -m immich_ml.video_restoration``.

One process, one uvicorn worker: restorations run one at a time on the GPU and a second
request is answered ``busy`` rather than queued behind the first.

``python -m immich_ml.video_restoration fetch-weights [model-id ...]`` downloads every manifest
weight that names a ``source`` from the Frameleaf model source (FL-162) and keeps it only when it
hashes to its pinned sha256. It never qualifies a model; that still needs a qualification record.
"""

import json
import logging
import socket
import sys

import uvicorn
from fastapi import FastAPI

from .app import WorkerSettings, create_app_from_env
from .models import Manifest, RestorationFailure, fetch_weights


class RestorationServer(uvicorn.Server):
    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        # Uvicorn waits for active requests BEFORE sending lifespan.shutdown.
        # Stop the model first so a blocked inference cannot hold SIGTERM shutdown.
        assert isinstance(self.config.app, FastAPI)
        await self.config.app.state.shutdown_restoration()
        await super().shutdown(sockets)


def fetch(model_ids: list[str]) -> int:
    settings = WorkerSettings.from_env()
    with settings.manifest.open("rb") as handle:
        manifest = Manifest.model_validate(json.load(handle))
    try:
        for line in fetch_weights(manifest, model_ids=model_ids or None):
            print(line)
    except RestorationFailure as failure:
        print(failure.message, file=sys.stderr)
        return 1
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if len(sys.argv) > 1 and sys.argv[1] == "fetch-weights":
        sys.exit(fetch(sys.argv[2:]))
    app, settings = create_app_from_env()
    RestorationServer(uvicorn.Config(app, host=settings.host, port=settings.port, workers=1)).run()


if __name__ == "__main__":
    main()

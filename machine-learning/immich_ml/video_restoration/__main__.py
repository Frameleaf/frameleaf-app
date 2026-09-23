"""Run the restoration worker: ``python -m immich_ml.video_restoration``.

One process, one uvicorn worker: restorations run one at a time on the GPU and a second
request is answered ``busy`` rather than queued behind the first.
"""

import logging

import uvicorn

from .app import create_app_from_env


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app, settings = create_app_from_env()
    uvicorn.run(app, host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()

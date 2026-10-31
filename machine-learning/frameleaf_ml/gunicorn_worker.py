"""Unix container process lifecycle; never imported by the native runtime."""

import sys
from socket import socket

from gunicorn.arbiter import Arbiter
from uvicorn import Server
from uvicorn.workers import UvicornWorker


# patches this issue https://github.com/encode/uvicorn/discussions/1803
class CustomUvicornServer(Server):
    async def shutdown(self, sockets: list[socket] | None = None) -> None:
        for sock in sockets or []:
            sock.close()
        await super().shutdown()


class CustomUvicornWorker(UvicornWorker):
    async def _serve(self) -> None:
        self.config.app = self.wsgi
        server = CustomUvicornServer(config=self.config)
        self._install_sigquit_handler()
        await server.serve(sockets=self.sockets)
        if not server.started:
            sys.exit(Arbiter.WORKER_BOOT_ERROR)

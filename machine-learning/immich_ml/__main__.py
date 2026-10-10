import os
import signal
import subprocess
from ipaddress import ip_address
from pathlib import Path

from .config import DEPRECATED_ENV, log, non_prefixed_settings, settings
from .env_aliases import deprecated_env_warning

if source_ref := os.getenv("FRAMELEAF_SOURCE_REF"):
    log.info(f"Initializing Frameleaf ML [{source_ref}]")
else:
    log.info("Initializing Frameleaf ML")

# FL-294: once, in the master process; the gunicorn workers resolve the same names quietly
if deprecated_warning := deprecated_env_warning(DEPRECATED_ENV):
    log.warning(deprecated_warning)

module_dir = Path(__file__).parent


def is_ipv6(host: str) -> bool:
    try:
        return ip_address(host).version == 6
    except ValueError:
        return False


bind_host = non_prefixed_settings.frameleaf_host
if is_ipv6(bind_host):
    bind_host = f"[{bind_host}]"
bind_address = f"{bind_host}:{non_prefixed_settings.frameleaf_port}"

try:
    with subprocess.Popen(
        [
            "python",
            "-m",
            "gunicorn",
            "immich_ml.main:app",
            "-k",
            "immich_ml.config.CustomUvicornWorker",
            "-c",
            module_dir / "gunicorn_conf.py",
            "-b",
            bind_address,
            "-w",
            str(settings.workers),
            "-t",
            str(settings.worker_timeout),
            "--log-config-json",
            module_dir / "log_conf.json",
            "--keep-alive",
            str(settings.http_keepalive_timeout_s),
            "--graceful-timeout",
            "10",
            "--no-control-socket",
        ],
    ) as cmd:
        cmd.wait()
except KeyboardInterrupt:
    cmd.send_signal(signal.SIGINT)
exit(cmd.returncode)

import os
import signal
import sqlite3
import subprocess
from ipaddress import ip_address
from pathlib import Path
from tempfile import TemporaryDirectory

from .config import DEPRECATED_ENV, log, non_prefixed_settings, settings
from .env_aliases import deprecated_env_warning
from .studio_worker import start_studio_worker
from .worker_logs import initialize_worker_log_spool

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

# FL-408: the bundled Studio render worker runs beside inference, in its own process
studio_worker = start_studio_worker()

# on i915, Intel's runtime submits every allocation in the process with each run it gives OpenVINO's GPU plugin
if any(driver.resolve().name == "i915" for driver in Path("/sys/class/drm").glob("renderD*/device/driver")):
    os.environ.setdefault("NEOReadDebugKeys", "1")
    os.environ.setdefault("EnableDirectSubmission", "0")

# The image's allocator preload applies to the inference workers only; Chromium in the Studio worker
# must not load it.
inference_env = os.environ.copy()
mimalloc_preload = Path("/etc/frameleaf-mimalloc-preload")
if mimalloc_preload.is_file() and (library := mimalloc_preload.read_text().strip()):
    inference_env["LD_PRELOAD"] = library

log_directory = None
if settings.workers > 1:
    try:
        log_directory = TemporaryDirectory(prefix="frameleaf-ml-logs-")
        log_spool = Path(log_directory.name) / "recent.sqlite3"
        initialize_worker_log_spool(log_spool)
        inference_env["FRAMELEAF_INTERNAL_ML_LOG_SPOOL"] = str(log_spool)
    except (OSError, sqlite3.Error):
        log.warning("Could not initialize the shared worker log spool")

try:
    with subprocess.Popen(
        [
            "python",
            "-m",
            "gunicorn",
            "frameleaf_ml.nas_app:app",
            "-k",
            "frameleaf_ml.config.CustomUvicornWorker",
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
        env=inference_env,
    ) as cmd:
        cmd.wait()
except KeyboardInterrupt:
    cmd.send_signal(signal.SIGINT)
finally:
    if log_directory is not None:
        log_directory.cleanup()
    if studio_worker is not None:
        studio_worker.stop()
exit(cmd.returncode)

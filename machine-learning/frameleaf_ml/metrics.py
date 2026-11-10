import os
from contextlib import contextmanager
from ipaddress import IPv6Address, ip_address
from typing import Iterator

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Histogram, generate_latest
from prometheus_client.multiprocess import MultiProcessCollector

from .env_aliases import read_env


def metrics_enabled(env: dict[str, str] | None = None) -> bool:
    return read_env(os.environ if env is None else env, "FRAMELEAF_ML_METRICS_ENABLED").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def private_scraper(host: str | None) -> bool:
    try:
        address = ip_address(host or "")
    except ValueError:
        return False
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_loopback or (address.is_private and not address.is_unspecified and not address.is_link_local)


class InferenceMetrics:
    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        self.request_duration = Histogram(
            "frameleaf_ml_request_duration_seconds",
            "Inference request duration by task",
            ("task",),
            registry=self.registry,
        )
        self.request_errors = Counter(
            "frameleaf_ml_request_errors_total",
            "Inference requests that failed by task",
            ("task",),
            registry=self.registry,
        )
        self.inference_duration = Histogram(
            "frameleaf_ml_inference_duration_seconds",
            "Model prediction duration by task, model and preferred execution provider",
            ("task", "model", "provider"),
            registry=self.registry,
        )

    @contextmanager
    def request(self, task: str) -> Iterator[None]:
        with self.request_duration.labels(task=task).time():
            try:
                yield
            except Exception:
                self.request_errors.labels(task=task).inc()
                raise

    def scrape(self) -> tuple[bytes, str]:
        registry = self.registry
        if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
            registry = CollectorRegistry()
            MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
        return generate_latest(registry), CONTENT_TYPE_LATEST

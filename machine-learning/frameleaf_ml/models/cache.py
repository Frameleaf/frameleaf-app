import time
from asyncio import Lock
from collections import OrderedDict
from typing import Any

from aiocache.backends.memory import SimpleMemoryCache
from aiocache.plugins import TimingPlugin

from frameleaf_ml.models import from_model_type
from frameleaf_ml.models.base import InferenceModel

from ..schemas import ModelTask, ModelType, has_profiling

ModelCacheKey = tuple[str, str, str, str, str]

# Resident model instances before the least recently used one is dropped. Every library task has a
# handful of instances; the bound stops caller-supplied device strings or model names from keeping an
# unbounded number of them alive when unloading is disabled.
DEFAULT_MAX_ENTRIES = 32


def normalize_identity(value: Any) -> str:
    """A cache identity field as the caller supplied it, less case and whitespace: "CPU" and " cpu " are one device."""
    return str(value or "").strip().lower()


class ModelCache:
    """Fetches a model from an in-memory cache, instantiating it if it's missing."""

    def __init__(
        self,
        revalidate: bool = False,
        timeout: int | None = None,
        profiling: bool = False,
        max_entries: int = DEFAULT_MAX_ENTRIES,
    ) -> None:
        """
        Args:
            revalidate: Resets TTL on cache hit. Useful to keep models in memory while active. Defaults to False.
            timeout: Maximum allowed time for model to load. Disabled if None. Defaults to None.
            profiling: Collects metrics for cache operations, adding slight overhead. Defaults to False.
            max_entries: Resident instances kept; beyond it the least recently used is dropped.
        """

        plugins = []

        if profiling:
            plugins.append(TimingPlugin())

        self.should_revalidate = revalidate
        self.max_entries = max(1, max_entries)
        self._create_lock = Lock()
        # Keys in order of last use, for the eviction of the least recently used entry.
        self._recent: OrderedDict[ModelCacheKey, None] = OrderedDict()

        self.cache = SimpleMemoryCache(timeout=timeout, plugins=plugins, namespace=None)

    async def get(
        self, model_name: str, model_type: ModelType, model_task: ModelTask, **model_kwargs: Any
    ) -> InferenceModel:
        key: ModelCacheKey = (
            model_name,
            str(model_type),
            str(model_task),
            normalize_identity(model_kwargs.get("device")),
            normalize_identity(model_kwargs.get("acceleration")),
        )
        ttl = model_kwargs.get("ttl")
        model: InferenceModel | None = await self.cache.get(key)
        if model is not None and self._expired(model):
            # The instance asked to be replaced (it no longer runs where its key says); the next request
            # constructs one on the configured device again.
            await self.cache.delete(key)
            self._recent.pop(key, None)
            model = None
        if model is None:
            # Serialize synchronous construction and publication, but leave cache hits unlocked.
            async with self._create_lock:
                model = await self.cache.get(key)
                if model is None:
                    model = from_model_type(model_name, model_type, model_task, **model_kwargs)
                    await self.cache.set(key, model, ttl=ttl)
                    self._touch(key)
                    await self._evict_surplus()
                    return model
        self._touch(key)
        if self.should_revalidate:
            await self.revalidate(key, ttl)
        return model

    async def get_profiling(self) -> dict[str, float] | None:
        if not has_profiling(self.cache):
            return None

        return self.cache.profiling

    async def revalidate(self, key: ModelCacheKey, ttl: int | None) -> None:
        if ttl is not None and key in self.cache._handlers:
            await self.cache.expire(key, ttl)

    def _touch(self, key: ModelCacheKey) -> None:
        self._recent[key] = None
        self._recent.move_to_end(key)

    async def _evict_surplus(self) -> None:
        # Entries the TTL already dropped are only forgotten; live ones go least recently used first.
        for key in [key for key in self._recent if key not in self.cache._cache]:
            del self._recent[key]
        while len(self._recent) > self.max_entries:
            key, _ = self._recent.popitem(last=False)
            await self.cache.delete(key)

    @staticmethod
    def _expired(model: Any) -> bool:
        evict_at = getattr(model, "evict_at", None)
        return isinstance(evict_at, (int, float)) and time.monotonic() >= evict_at

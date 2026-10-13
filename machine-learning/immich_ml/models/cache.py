from asyncio import Lock
from typing import Any

from aiocache.backends.memory import SimpleMemoryCache
from aiocache.plugins import TimingPlugin

from immich_ml.models import from_model_type
from immich_ml.models.base import InferenceModel

from ..schemas import ModelTask, ModelType, has_profiling

ModelCacheKey = tuple[str, str, str, str, str]


class ModelCache:
    """Fetches a model from an in-memory cache, instantiating it if it's missing."""

    def __init__(
        self,
        revalidate: bool = False,
        timeout: int | None = None,
        profiling: bool = False,
    ) -> None:
        """
        Args:
            revalidate: Resets TTL on cache hit. Useful to keep models in memory while active. Defaults to False.
            timeout: Maximum allowed time for model to load. Disabled if None. Defaults to None.
            profiling: Collects metrics for cache operations, adding slight overhead. Defaults to False.
        """

        plugins = []

        if profiling:
            plugins.append(TimingPlugin())

        self.should_revalidate = revalidate
        self._create_lock = Lock()

        self.cache = SimpleMemoryCache(timeout=timeout, plugins=plugins, namespace=None)

    async def get(
        self, model_name: str, model_type: ModelType, model_task: ModelTask, **model_kwargs: Any
    ) -> InferenceModel:
        key: ModelCacheKey = (
            model_name,
            str(model_type),
            str(model_task),
            str(model_kwargs.get("device", "")),
            str(model_kwargs.get("acceleration", "")),
        )
        ttl = model_kwargs.get("ttl")
        model: InferenceModel | None = await self.cache.get(key)
        if model is None:
            # Serialize synchronous construction and publication, but leave cache hits unlocked.
            async with self._create_lock:
                model = await self.cache.get(key)
                if model is None:
                    model = from_model_type(model_name, model_type, model_task, **model_kwargs)
                    await self.cache.set(key, model, ttl=ttl)
                    return model
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

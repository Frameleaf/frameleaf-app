"""Reads Frameleaf every few minutes for the sensors and the picture."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import FrameleafApi, FrameleafAuthError, FrameleafError, FrameleafForbidden
from .const import DOMAIN, IMAGE_ROTATE, SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


@dataclass
class FrameleafData:
    """What one refresh read. A value this sign-in may not see stays None."""

    user: dict[str, Any]
    statistics: dict[str, Any] | None = None
    last_phone_backup: datetime | None = None
    has_phones: bool = False
    storage: dict[str, Any] | None = None
    cloud_backup: dict[str, Any] | None = None
    attention: int | None = None
    picture: dict[str, Any] | None = None
    picture_at: datetime | None = None

    @property
    def is_admin(self) -> bool:
        return bool(self.user.get("isAdmin"))


def is_shareable(asset: dict[str, Any]) -> bool:
    """A photo for a dashboard: on the timeline, not trashed or offline. Never Locked, hidden or archived."""
    return (
        asset.get("type") == "IMAGE"
        and asset.get("visibility") == "timeline"
        and not asset.get("isTrashed")
        and not asset.get("isOffline")
    )


class FrameleafCoordinator(DataUpdateCoordinator[FrameleafData]):
    """One account on one Frameleaf server."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN, update_interval=SCAN_INTERVAL)
        self.api = api

    async def _optional(self, call):
        """A value this sign-in may not see (an administrator page, or a scope not granted) is left out."""
        try:
            return await call
        except FrameleafForbidden:
            return None

    async def _async_update_data(self) -> FrameleafData:
        try:
            if self.api.is_app:
                # what a connected app can see: the library, never the account or the administrator pages
                user = {"id": self.config_entry.unique_id, "name": None, "isAdmin": False}
                data = FrameleafData(user=user)
                data.statistics = await self.api.get_statistics()
            else:
                data = FrameleafData(user=await self.api.get_me())
                data.statistics = await self._optional(self.api.get_statistics())
            devices = None if self.api.is_app else await self._optional(self.api.get_backup_devices())
            data.has_phones = devices is not None
            if devices:
                times = [
                    parsed
                    for device in devices.get("devices", [])
                    if (parsed := dt_util.parse_datetime(device.get("lastSuccessfulBackupAt") or ""))
                ]
                data.last_phone_backup = max(times) if times else None
            if data.is_admin:
                data.storage = await self._optional(self.api.get_storage())
                data.cloud_backup = await self._optional(self.api.get_cloud_backup())
                attention = await self._optional(self.api.get_attention())
                data.attention = len(attention.get("items", [])) if attention else None
            await self._choose_picture(data)
            return data
        except FrameleafAuthError as error:
            # revoked in Frameleaf (Settings › Connected apps) or the key was removed: sign in again
            raise ConfigEntryAuthFailed(str(error)) from error
        except FrameleafError as error:
            raise UpdateFailed(str(error)) from error

    async def _choose_picture(self, data: FrameleafData) -> None:
        """Today's memory first, otherwise a favourite; a new one only every IMAGE_ROTATE."""
        now = dt_util.utcnow()
        previous = self.data
        if previous and previous.picture and previous.picture_at and now - previous.picture_at < IMAGE_ROTATE:
            data.picture, data.picture_at = previous.picture, previous.picture_at
            return
        candidates: list[dict[str, Any]] = []
        memories = await self._optional(self.api.get_today_memories(dt_util.now().date().isoformat()))
        for memory in memories or []:
            candidates.extend(memory.get("assets", []))
        if not [asset for asset in candidates if is_shareable(asset)]:
            candidates = await self._optional(self.api.random_favorite()) or []
        shareable = [asset for asset in candidates if is_shareable(asset)]
        if shareable:
            index = int(now.timestamp() // IMAGE_ROTATE.total_seconds()) % len(shareable)
            data.picture, data.picture_at = shareable[index], now

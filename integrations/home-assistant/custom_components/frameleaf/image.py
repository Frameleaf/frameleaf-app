"""A picture for dashboards and frames: today's memory, or a favourite."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import FrameleafError
from .coordinator import FrameleafCoordinator, is_shareable
from .entity import FrameleafEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([FrameleafPicture(hass, entry.runtime_data.coordinator)])


class FrameleafPicture(FrameleafEntity, ImageEntity):
    """The picture is fetched through Home Assistant, so the Frameleaf sign-in never reaches a browser."""

    _attr_content_type = "image/jpeg"

    def __init__(self, hass: HomeAssistant, coordinator: FrameleafCoordinator) -> None:
        FrameleafEntity.__init__(self, coordinator, "picture")
        ImageEntity.__init__(self, hass)
        self._asset_id: str | None = None
        self._update_from_data()

    def _update_from_data(self) -> None:
        picture = self.coordinator.data.picture
        asset_id = picture["id"] if picture and is_shareable(picture) else None
        if asset_id != self._asset_id:
            self._asset_id = asset_id
            self._attr_image_last_updated = self.coordinator.data.picture_at if asset_id else None
            self._cached_image = None

    @callback
    def _handle_coordinator_update(self) -> None:
        self._update_from_data()
        super()._handle_coordinator_update()

    @property
    def image_last_updated(self) -> datetime | None:
        return self._attr_image_last_updated

    async def async_image(self) -> bytes | None:
        if self._asset_id is None:
            return None
        try:
            return await self.coordinator.api.thumbnail(self._asset_id)
        except FrameleafError:
            return None

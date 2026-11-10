"""Administrators can start a library scan (looking for new files in the library folders)."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import FrameleafError
from .coordinator import FrameleafCoordinator
from .entity import FrameleafEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: FrameleafCoordinator = entry.runtime_data.coordinator
    if coordinator.data.is_admin and entry.runtime_data.can_administer:
        async_add_entities([FrameleafScanButton(coordinator)])


class FrameleafScanButton(FrameleafEntity, ButtonEntity):
    def __init__(self, coordinator: FrameleafCoordinator) -> None:
        super().__init__(coordinator, "scan_library")

    async def async_press(self) -> None:
        try:
            for library in await self.coordinator.api.get_libraries():
                await self.coordinator.api.scan_library(library["id"])
        except FrameleafError as error:
            raise HomeAssistantError(f"Frameleaf could not start the scan: {error}") from error

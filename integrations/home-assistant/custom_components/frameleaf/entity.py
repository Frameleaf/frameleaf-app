"""The device every Frameleaf entity belongs to."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import FrameleafCoordinator


class FrameleafEntity(CoordinatorEntity[FrameleafCoordinator]):
    _attr_has_entity_name = True

    def __init__(self, coordinator: FrameleafCoordinator, key: str) -> None:
        super().__init__(coordinator)
        entry = coordinator.config_entry
        user = coordinator.data.user
        self._attr_unique_id = f"{entry.unique_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.unique_id or entry.entry_id)},
            name=f"Frameleaf ({who})" if (who := user.get("name") or user.get("email")) else "Frameleaf",
            manufacturer="Frameleaf",
            entry_type=DeviceEntryType.SERVICE,
            configuration_url=coordinator.api.url,
        )

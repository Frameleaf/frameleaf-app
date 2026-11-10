"""Sensors: the library's size, phone backup, storage, Cloud Backup and things to look at."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfInformation
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import FrameleafCoordinator, FrameleafData
from .entity import FrameleafEntity


def _cloud_backup(data: FrameleafData) -> str | None:
    status = data.cloud_backup
    if status is None:
        return None
    if not status.get("configured"):
        return "not_set_up"
    if status.get("activeRun"):
        return "running"
    last = (status.get("lastRun") or {}).get("status")
    return {"completed": "backed_up", "failed": "failed", "cancelled": "cancelled"}.get(last, "waiting")


def _cloud_backup_attributes(data: FrameleafData) -> dict[str, Any]:
    status = data.cloud_backup or {}
    return {"last_success": status.get("lastSuccessAt")}


@dataclass(frozen=True, kw_only=True)
class FrameleafSensorDescription(SensorEntityDescription):
    value_fn: Callable[[FrameleafData], Any]
    # whether this sign-in can see the value at all; a member or a connected app has no administrator sensors
    visible_fn: Callable[[FrameleafData], bool]
    attributes_fn: Callable[[FrameleafData], dict[str, Any]] | None = None


SENSORS: tuple[FrameleafSensorDescription, ...] = (
    FrameleafSensorDescription(
        key="photos",
        visible_fn=lambda data: data.statistics is not None,
        state_class=SensorStateClass.TOTAL,
        value_fn=lambda data: (data.statistics or {}).get("images"),
    ),
    FrameleafSensorDescription(
        key="videos",
        visible_fn=lambda data: data.statistics is not None,
        state_class=SensorStateClass.TOTAL,
        value_fn=lambda data: (data.statistics or {}).get("videos"),
    ),
    FrameleafSensorDescription(
        key="last_phone_backup",
        visible_fn=lambda data: data.has_phones,
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda data: data.last_phone_backup,
    ),
    FrameleafSensorDescription(
        key="storage_used",
        visible_fn=lambda data: data.storage is not None,
        device_class=SensorDeviceClass.DATA_SIZE,
        native_unit_of_measurement=UnitOfInformation.BYTES,
        suggested_unit_of_measurement=UnitOfInformation.GIGABYTES,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: (data.storage or {}).get("diskUseRaw"),
    ),
    FrameleafSensorDescription(
        key="storage_used_percent",
        visible_fn=lambda data: data.storage is not None,
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: (data.storage or {}).get("diskUsagePercentage"),
    ),
    FrameleafSensorDescription(
        key="cloud_backup",
        visible_fn=lambda data: data.cloud_backup is not None,
        device_class=SensorDeviceClass.ENUM,
        options=["not_set_up", "running", "backed_up", "failed", "cancelled", "waiting"],
        value_fn=_cloud_backup,
        attributes_fn=_cloud_backup_attributes,
    ),
    FrameleafSensorDescription(
        key="needs_attention",
        visible_fn=lambda data: data.attention is not None,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda data: data.attention,
    ),
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    coordinator: FrameleafCoordinator = entry.runtime_data.coordinator
    async_add_entities(
        FrameleafSensor(coordinator, description) for description in SENSORS if description.visible_fn(coordinator.data)
    )


class FrameleafSensor(FrameleafEntity, SensorEntity):
    entity_description: FrameleafSensorDescription

    def __init__(self, coordinator: FrameleafCoordinator, description: FrameleafSensorDescription) -> None:
        super().__init__(coordinator, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> Any:
        value = self.entity_description.value_fn(self.coordinator.data)
        if self.entity_description.device_class == SensorDeviceClass.TIMESTAMP and value is not None:
            return dt_util.as_utc(value)
        return value

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self.entity_description.attributes_fn is None:
            return None
        return self.entity_description.attributes_fn(self.coordinator.data)

"""FL-819: Frameleaf events (a finished Studio export, a Cloud Backup result...) as Home Assistant events.

Home Assistant gets a webhook of its own, and Frameleaf gets one workflow per event that sends the event
to it with the webhook step, signed with a secret only the two of them know. Each message that checks out
is fired on the bus as `frameleaf_event`; anything unsigned, stale or seen before is dropped.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time
from collections import OrderedDict
from typing import Any

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .api import FrameleafApi, FrameleafError
from .const import (
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    CONF_WORKFLOW_IDS,
    DOMAIN,
    EVENT_FRAMELEAF,
    SIGNATURE_TOLERANCE_SECONDS,
    WEBHOOK_METHOD,
)

_LOGGER = logging.getLogger(__name__)
_SEEN_LIMIT = 500


def signature_ok(secret: str, timestamp: str | None, body: bytes, signature: str | None, now: float) -> bool:
    """Frameleaf signs `<X-Frameleaf-Timestamp>.<body>` with HMAC-SHA256 (`sha256=<hex>`)."""
    if not timestamp or not signature or not timestamp.isdigit():
        return False
    if abs(now - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        return False
    expected = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def make_handler(secret: str):
    seen: OrderedDict[str, None] = OrderedDict()

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response | None:
        body = await request.read()
        if not signature_ok(
            secret,
            request.headers.get("X-Frameleaf-Timestamp"),
            body,
            request.headers.get("X-Frameleaf-Signature"),
            time.time(),
        ):
            _LOGGER.warning("Ignored a Frameleaf event that was not signed by this server")
            return web.Response(status=401)
        try:
            message = json.loads(body)
            data: dict[str, Any] = message["data"]
        except (ValueError, KeyError, TypeError):
            return web.Response(status=400)
        delivery = request.headers.get("X-Frameleaf-Delivery") or data.get("deliveryId")
        if delivery in seen:
            return web.Response(status=200)
        if delivery:
            seen[delivery] = None
            while len(seen) > _SEEN_LIMIT:
                seen.popitem(last=False)
        hass.bus.async_fire(
            EVENT_FRAMELEAF,
            {
                "trigger": message.get("trigger"),
                "event": data.get("event"),
                "delivery_id": delivery,
                "occurred_at": data.get("occurredAt"),
                "subject": data.get("subject"),
                "detail": data.get("detail"),
            },
        )
        return web.Response(status=200)

    return handle


async def async_setup_events(hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi) -> None:
    """Registers the webhook and, the first time, the Frameleaf workflows that send to it."""
    webhook_id = entry.data.get(CONF_WEBHOOK_ID)
    secret = entry.data.get(CONF_WEBHOOK_SECRET)
    if not webhook_id or not secret:
        webhook_id, secret = webhook.async_generate_id(), secrets.token_urlsafe(32)
        hass.config_entries.async_update_entry(
            entry, data={**entry.data, CONF_WEBHOOK_ID: webhook_id, CONF_WEBHOOK_SECRET: secret}
        )
    webhook.async_register(hass, DOMAIN, "Frameleaf events", webhook_id, make_handler(secret))

    if entry.data.get(CONF_WORKFLOW_IDS):
        return
    url = webhook.async_generate_url(hass, webhook_id)
    created: list[str] = []
    try:
        for item in await api.get_event_triggers():
            workflow = await api.create_workflow(
                {
                    "name": f"Home Assistant: {item['event']}",
                    "description": "Sends this Frameleaf event to Home Assistant (added by its Frameleaf integration).",
                    "trigger": item["trigger"],
                    "enabled": True,
                    "logging": True,
                    "steps": [
                        {"method": WEBHOOK_METHOD, "config": {"url": url, "method": "POST", "secret": secret}},
                    ],
                }
            )
            created.append(workflow["id"])
    except FrameleafError as error:
        _LOGGER.warning(
            "Frameleaf events are not set up yet: %s. A Home Assistant address on your home network needs "
            "'Allow automations to call devices on my network' in Frameleaf",
            error,
        )
        return
    finally:
        if created:
            hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_WORKFLOW_IDS: created})


async def async_remove_events(hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi | None) -> None:
    """Takes the workflows this integration made out of Frameleaf again."""
    if api is None:
        return
    for workflow_id in entry.data.get(CONF_WORKFLOW_IDS, []):
        try:
            await api.delete_workflow(workflow_id)
        except FrameleafError as error:
            _LOGGER.warning("Could not remove Frameleaf workflow %s: %s", workflow_id, error)

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

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .api import FrameleafApi, FrameleafError
from .const import (
    CONF_WEBHOOK_ID,
    CONF_WEBHOOK_SECRET,
    CONF_WORKFLOW_IDS,
    CONF_WORKFLOW_TRIGGERS,
    DOMAIN,
    EVENT_FRAMELEAF,
    SIGNATURE_TOLERANCE_SECONDS,
    WEBHOOK_METHOD,
)

_LOGGER = logging.getLogger(__name__)
_SEEN_LIMIT = 500


def signature_ok(
    secret: str, timestamp: str | None, delivery: str | None, body: bytes, signature: str | None, now: float
) -> bool:
    """Frameleaf signs `<X-Frameleaf-Timestamp>.<X-Frameleaf-Delivery>.<body>` with HMAC-SHA256 (`sha256=<hex>`)."""
    if not timestamp or not delivery or not signature or not timestamp.isdigit():
        return False
    # non-ASCII headers would raise below (int, encode, compare_digest) instead of being refused
    if not (timestamp.isascii() and delivery.isascii() and signature.isascii()):
        return False
    if abs(now - int(timestamp)) > SIGNATURE_TOLERANCE_SECONDS:
        return False
    signed = f"{timestamp}.{delivery}.".encode() + body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def make_handler(secret: str):
    seen: OrderedDict[str, None] = OrderedDict()

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response | None:
        body = await request.read()
        # the delivery id is part of what is signed, so a replay cannot change it
        delivery = request.headers.get("X-Frameleaf-Delivery")
        if not signature_ok(
            secret,
            request.headers.get("X-Frameleaf-Timestamp"),
            delivery,
            body,
            request.headers.get("X-Frameleaf-Signature"),
            time.time(),
        ):
            _LOGGER.warning("Ignored a Frameleaf event that was not signed by this server")
            return web.Response(status=401)
        if delivery in seen:
            return web.Response(status=200)
        try:
            message = json.loads(body)
            data = message["data"]
        except (ValueError, KeyError, TypeError):
            return web.Response(status=400)
        if not isinstance(message, dict) or not isinstance(data, dict):
            return web.Response(status=400)
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
        # remembered only once it was fired, so a failed fire can be delivered again
        seen[delivery] = None
        while len(seen) > _SEEN_LIMIT:
            seen.popitem(last=False)
        return web.Response(status=200)

    return handle


async def async_setup_events(
    hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi, coordinator: DataUpdateCoordinator
) -> None:
    """Registers the webhook and makes the Frameleaf workflows that send to it. A setup that stops partway (the
    server busy, a timeout) carries on with the events still missing at each refresh until every one has a workflow
    (FL-1371)."""
    webhook_id = entry.data.get(CONF_WEBHOOK_ID)
    secret = entry.data.get(CONF_WEBHOOK_SECRET)
    if not webhook_id or not secret:
        webhook_id, secret = webhook.async_generate_id(), secrets.token_urlsafe(32)
        hass.config_entries.async_update_entry(
            entry, data={**entry.data, CONF_WEBHOOK_ID: webhook_id, CONF_WEBHOOK_SECRET: secret}
        )
    webhook.async_register(hass, DOMAIN, "Frameleaf events", webhook_id, make_handler(secret))
    url = webhook.async_generate_url(hass, webhook_id)

    if await _make_workflows(hass, entry, api, url, secret):
        return
    running = False
    stop: CALLBACK_TYPE | None = None

    async def carry_on() -> None:
        nonlocal running, stop
        try:
            if await _make_workflows(hass, entry, api, url, secret) and stop:
                stop()
                stop = None
        finally:
            running = False

    @callback
    def refreshed() -> None:
        nonlocal running
        if running or stop is None:
            return
        running = True
        entry.async_create_background_task(hass, carry_on(), "frameleaf events setup")

    stop = coordinator.async_add_listener(refreshed)

    @callback
    def unload() -> None:
        if stop:
            stop()

    entry.async_on_unload(unload)


async def _make_workflows(hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi, url: str, secret: str) -> bool:
    """One workflow per Frameleaf event not yet given one; True once none is missing. Each workflow is kept as soon
    as it is made, so running this again never makes a second one for the same event."""
    if entry.data.get(CONF_WORKFLOW_IDS) and CONF_WORKFLOW_TRIGGERS not in entry.data:
        # set up before the events made were kept one by one, which happened only when all of them were made
        return True
    ids = list(entry.data.get(CONF_WORKFLOW_IDS, []))
    done = list(entry.data.get(CONF_WORKFLOW_TRIGGERS, []))
    try:
        for item in await api.get_event_triggers():
            if item["trigger"] in done:
                continue
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
            ids.append(workflow["id"])
            done.append(item["trigger"])
            hass.config_entries.async_update_entry(
                entry, data={**entry.data, CONF_WORKFLOW_IDS: ids, CONF_WORKFLOW_TRIGGERS: done}
            )
    except FrameleafError as error:
        _LOGGER.warning(
            "Frameleaf events are not all set up yet, trying again at the next refresh: %s. A Home Assistant "
            "address on your home network needs 'Allow automations to call devices on my network' in Frameleaf",
            error,
        )
        return False
    return True


async def async_remove_events(hass: HomeAssistant, entry: ConfigEntry, api: FrameleafApi | None) -> None:
    """Takes the workflows this integration made out of Frameleaf again."""
    if api is None:
        return
    for workflow_id in entry.data.get(CONF_WORKFLOW_IDS, []):
        try:
            await api.delete_workflow(workflow_id)
        except FrameleafError as error:
            _LOGGER.warning("Could not remove Frameleaf workflow %s: %s", workflow_id, error)

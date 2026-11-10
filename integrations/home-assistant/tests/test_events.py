"""FL-819: signed Frameleaf events become `frameleaf_event` on the bus; anything else is dropped."""

from __future__ import annotations

import hashlib
import hmac
import json
import time

from homeassistant.core import HomeAssistant

from custom_components.frameleaf.const import CONF_WEBHOOK_ID, CONF_WEBHOOK_SECRET, CONF_WORKFLOW_IDS, EVENT_FRAMELEAF
from custom_components.frameleaf.events import signature_ok

from .conftest import API, api_key_entry, mock_server


def sign(secret: str, timestamp: str, delivery: str, body: bytes) -> str:
    signed = f"{timestamp}.{delivery}.".encode() + body
    return "sha256=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


def test_signature() -> None:
    body = b'{"event":"cloud.backup.failed"}'
    now = 1_700_000_000
    delivery = "cloud-backup:run-1:failed"
    good = sign("my-secret", str(now), delivery, body)
    # the same vector the server's own test uses
    assert good == "sha256=9cd2af4efc0ad7feb339dc6ab001fc96bc4253d5ebd2dd7a9206a5b31a99b4c6"
    assert signature_ok("my-secret", str(now), delivery, body, good, now)
    assert not signature_ok("my-secret", str(now), "another", body, good, now)
    assert not signature_ok("my-secret", str(now), delivery, body + b" ", good, now)
    assert not signature_ok("other", str(now), delivery, body, good, now)
    assert not signature_ok("my-secret", str(now), delivery, body, good, now + 301)
    assert not signature_ok("my-secret", None, delivery, body, good, now)


async def setup_with_events(hass: HomeAssistant, aioclient_mock):
    mock_server(aioclient_mock)
    aioclient_mock.get(
        f"{API}/workflows/automation/discovery",
        json={
            "triggers": [],
            "templates": [],
            "eventTriggers": [{"trigger": "CloudBackupFailed", "event": "cloud.backup.failed"}],
        },
    )
    aioclient_mock.post(f"{API}/workflows", json={"id": "workflow-1"})
    entry = api_key_entry(events=True)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_frameleaf_gets_a_signed_workflow(hass: HomeAssistant, aioclient_mock) -> None:
    hass.config.external_url = "https://home.example.com"
    entry = await setup_with_events(hass, aioclient_mock)
    created = next(
        call for call in aioclient_mock.mock_calls if call[0] == "POST" and str(call[1]).endswith("/workflows")
    )
    body = created[2]
    assert body["trigger"] == "CloudBackupFailed"
    [step] = body["steps"]
    assert step["method"] == "immich-plugin-core#webhook"
    assert step["config"]["url"] == f"https://home.example.com/api/webhook/{entry.data[CONF_WEBHOOK_ID]}"
    assert step["config"]["secret"] == entry.data[CONF_WEBHOOK_SECRET]
    assert entry.data[CONF_WORKFLOW_IDS] == ["workflow-1"]


async def test_signed_event_reaches_the_bus_once(hass: HomeAssistant, aioclient_mock, hass_client_no_auth) -> None:
    hass.config.external_url = "https://home.example.com"
    entry = await setup_with_events(hass, aioclient_mock)
    events = []
    hass.bus.async_listen(EVENT_FRAMELEAF, events.append)
    client = await hass_client_no_auth()
    body = json.dumps(
        {
            "type": "EventV1",
            "trigger": "CloudBackupFailed",
            "data": {
                "event": "cloud.backup.failed",
                "deliveryId": "cloud-backup:run-1:failed",
                "occurredAt": "2026-11-10T03:12:00.000Z",
                "subject": {"kind": "cloud-backup", "id": "run-1", "name": "Cloud Backup"},
                "detail": {"uploaded": 3},
            },
        }
    ).encode()
    timestamp = str(int(time.time()))
    path = f"/api/webhook/{entry.data[CONF_WEBHOOK_ID]}"
    headers = {
        "X-Frameleaf-Timestamp": timestamp,
        "X-Frameleaf-Signature": sign(entry.data[CONF_WEBHOOK_SECRET], timestamp, "cloud-backup:run-1:failed", body),
        "X-Frameleaf-Delivery": "cloud-backup:run-1:failed",
        "Content-Type": "application/json",
    }
    assert (await client.post(path, data=body, headers=headers)).status == 200
    assert (await client.post(path, data=body, headers=headers)).status == 200
    # a replay with another delivery header no longer matches its signature
    assert (await client.post(path, data=body, headers={**headers, "X-Frameleaf-Delivery": "other"})).status == 401
    forged = {**headers, "X-Frameleaf-Signature": sign("guess", timestamp, "x", body), "X-Frameleaf-Delivery": "x"}
    assert (await client.post(path, data=body, headers=forged)).status == 401
    await hass.async_block_till_done()

    assert len(events) == 1
    assert events[0].data == {
        "trigger": "CloudBackupFailed",
        "event": "cloud.backup.failed",
        "delivery_id": "cloud-backup:run-1:failed",
        "occurred_at": "2026-11-10T03:12:00.000Z",
        "subject": {"kind": "cloud-backup", "id": "run-1", "name": "Cloud Backup"},
        "detail": {"uploaded": 3},
    }


async def test_message_without_an_object_is_refused(hass: HomeAssistant, aioclient_mock, hass_client_no_auth) -> None:
    hass.config.external_url = "https://home.example.com"
    entry = await setup_with_events(hass, aioclient_mock)
    events = []
    hass.bus.async_listen(EVENT_FRAMELEAF, events.append)
    client = await hass_client_no_auth()
    path = f"/api/webhook/{entry.data[CONF_WEBHOOK_ID]}"
    for n, payload in enumerate(([], {"data": ["a"]}, {"data": {"deliveryId": {"b": 1}, "event": "e"}})):
        body = json.dumps(payload).encode()
        timestamp = str(int(time.time()))
        headers = {
            "X-Frameleaf-Timestamp": timestamp,
            "X-Frameleaf-Delivery": f"d-{n}",
            "X-Frameleaf-Signature": sign(entry.data[CONF_WEBHOOK_SECRET], timestamp, f"d-{n}", body),
        }
        assert (await client.post(path, data=body, headers=headers)).status in (200, 400)
    await hass.async_block_till_done()
    # only the well-formed message fires, keyed on the signed delivery header
    assert [event.data["delivery_id"] for event in events] == ["d-2"]

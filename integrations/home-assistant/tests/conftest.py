"""Fixtures: a Frameleaf server answered by aioclient_mock."""

from __future__ import annotations

import time
from typing import Any

import pytest
from homeassistant.const import CONF_API_KEY, CONF_URL
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.frameleaf.const import (
    AUTH_API_KEY,
    AUTH_OAUTH,
    CONF_AUTH_METHOD,
    CONF_CLIENT_ID,
    CONF_EVENTS,
    DOMAIN,
)

URL = "http://frameleaf.test:2283"
API = f"{URL}/api"
ADMIN = {"id": "user-admin", "name": "Taylor", "email": "taylor@example.com", "isAdmin": True}
MEMBER = {"id": "user-member", "name": "Sam", "email": "sam@example.com", "isAdmin": False}
FAVORITE = {"id": "asset-1", "type": "IMAGE", "visibility": "timeline", "isTrashed": False, "isOffline": False}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


def mock_server(aioclient_mock, *, user: dict[str, Any] = ADMIN, admin_pages: bool = True, picture=FAVORITE) -> None:
    aioclient_mock.get(f"{API}/server/ping", json={"res": "pong"})
    aioclient_mock.get(f"{API}/users/me", json=user)
    aioclient_mock.get(f"{API}/assets/statistics", json={"images": 1200, "videos": 34, "total": 1234})
    aioclient_mock.get(
        f"{API}/users/me/backup-devices",
        json={"devices": [{"lastSuccessfulBackupAt": "2026-11-10T08:00:00.000Z"}, {"lastSuccessfulBackupAt": None}]},
    )
    aioclient_mock.get(f"{API}/memories", json=[])
    aioclient_mock.post(f"{API}/search/random", json=[picture] if picture else [])
    aioclient_mock.get(f"{API}/assets/asset-1/thumbnail?size=preview", content=b"jpeg-bytes")
    if admin_pages:
        aioclient_mock.get(
            f"{API}/server/storage",
            json={"diskUseRaw": 500_000_000_000, "diskUsagePercentage": 41.5},
        )
        aioclient_mock.get(
            f"{API}/admin/cloud/backup",
            json={"configured": True, "activeRun": None, "lastRun": {"status": "failed"}, "lastSuccessAt": None},
        )
        aioclient_mock.get(f"{API}/admin/attention", json={"items": [{"id": "a"}, {"id": "b"}]})
    else:
        for path in ("/server/storage", "/admin/cloud/backup", "/admin/attention"):
            aioclient_mock.get(f"{API}{path}", status=403)


def api_key_entry(events: bool = False) -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{URL}#{ADMIN['id']}",
        title="Taylor",
        data={CONF_URL: URL, CONF_AUTH_METHOD: AUTH_API_KEY, CONF_API_KEY: "key-1", CONF_EVENTS: events},
    )


def oauth_entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{URL}#{MEMBER['id']}",
        title="Sam",
        data={
            CONF_URL: URL,
            CONF_AUTH_METHOD: AUTH_OAUTH,
            CONF_CLIENT_ID: "client-1",
            "auth_implementation": f"{DOMAIN}_client-1",
            "token": {
                "access_token": "fla_access",
                "refresh_token": "flr_refresh",
                "token_type": "Bearer",
                "expires_in": 3600,
                "expires_at": time.time() + 3600,
            },
        },
    )

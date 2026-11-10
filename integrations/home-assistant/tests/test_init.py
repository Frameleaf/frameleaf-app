"""Setting up: sensors for what the sign-in can see, the picture, the administrator button and reauth."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

from .conftest import API, MEMBER, api_key_entry, mock_server, oauth_entry


async def test_admin_api_key_sees_everything(hass: HomeAssistant, aioclient_mock) -> None:
    mock_server(aioclient_mock)
    entry = api_key_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert hass.states.get("sensor.frameleaf_taylor_photos").state == "1200"
    assert hass.states.get("sensor.frameleaf_taylor_videos").state == "34"
    assert hass.states.get("sensor.frameleaf_taylor_last_phone_backup").state == "2026-11-10T08:00:00+00:00"
    assert hass.states.get("sensor.frameleaf_taylor_cloud_backup").state == "failed"
    assert hass.states.get("sensor.frameleaf_taylor_things_to_look_at").state == "2"
    assert hass.states.get("sensor.frameleaf_taylor_storage_used_percent").state == "41.5"
    assert hass.states.get("button.frameleaf_taylor_look_for_new_files") is not None
    assert hass.states.get("image.frameleaf_taylor_picture") is not None
    # the key goes to Frameleaf only, as its own header
    assert all(call[3].get("x-api-key") == "key-1" for call in aioclient_mock.mock_calls if call[3])


async def test_connected_app_sees_the_library_only(hass: HomeAssistant, aioclient_mock) -> None:
    mock_server(aioclient_mock, user=MEMBER, admin_pages=False)
    aioclient_mock.get(f"{API}/users/me/backup-devices", status=403)
    entry = oauth_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert hass.states.get("sensor.frameleaf_photos").state == "1200"
    assert hass.states.get("sensor.frameleaf_cloud_backup") is None
    assert hass.states.get("sensor.frameleaf_storage_used") is None
    assert hass.states.get("button.frameleaf_look_for_new_files") is None
    assert any(call[3].get("Authorization") == "Bearer fla_access" for call in aioclient_mock.mock_calls if call[3])
    # a connected app never asks for the account or administrator pages
    assert not any("/admin/" in str(call[1]) or "/users/me" in str(call[1]) for call in aioclient_mock.mock_calls)


async def test_revoked_app_asks_to_sign_in_again(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/assets/statistics", status=401)
    entry = oauth_entry()
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert [flow["context"]["source"] for flow in flows] == ["reauth"]

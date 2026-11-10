"""The picture never shows a Locked, hidden or archived photo."""

from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from .conftest import FAVORITE, api_key_entry, mock_server


async def test_picture_is_a_favourite(hass: HomeAssistant, aioclient_mock, hass_client) -> None:
    mock_server(aioclient_mock)
    entry = api_key_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    state = hass.states.get("image.frameleaf_taylor_picture")
    client = await hass_client()
    response = await client.get(state.attributes["entity_picture"])
    assert response.status == 200
    assert await response.read() == b"jpeg-bytes"


@pytest.mark.parametrize("visibility", ["locked", "hidden", "archive"])
async def test_private_photo_is_never_shown(hass: HomeAssistant, aioclient_mock, hass_client, visibility) -> None:
    mock_server(aioclient_mock, picture={**FAVORITE, "visibility": visibility})
    entry = api_key_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    state = hass.states.get("image.frameleaf_taylor_picture")
    client = await hass_client()
    response = await client.get(state.attributes["entity_picture"])
    assert response.status != 200
    assert not any("/thumbnail" in str(call[1]) for call in aioclient_mock.mock_calls)

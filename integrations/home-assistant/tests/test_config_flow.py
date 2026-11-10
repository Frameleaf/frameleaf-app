"""Adding Frameleaf: through its Allow page (FL-803) or with an API key."""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_API_KEY, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.frameleaf.const import AUTH_API_KEY, AUTH_OAUTH, CONF_AUTH_METHOD, CONF_EVENTS, DOMAIN

from .conftest import ADMIN, API, URL, mock_server


async def test_api_key(hass: HomeAssistant, aioclient_mock) -> None:
    mock_server(aioclient_mock)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: f"{URL}/", CONF_AUTH_METHOD: AUTH_API_KEY}
    )
    assert result["step_id"] == "api_key"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_API_KEY: " key-1 ", CONF_EVENTS: True}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Taylor"
    assert result["data"] == {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_API_KEY, CONF_API_KEY: "key-1", CONF_EVENTS: True}
    assert result["result"].unique_id == f"{URL}#{ADMIN['id']}"


async def test_api_key_refused(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/server/ping", json={"res": "pong"})
    aioclient_mock.get(f"{API}/users/me", status=401)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_API_KEY}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_API_KEY: "wrong"})
    assert result["errors"] == {"base": "invalid_auth"}


async def test_not_a_frameleaf_server(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/server/ping", status=404)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_OAUTH}
    )
    assert result["errors"] == {"base": "cannot_connect"}


@pytest.mark.usefixtures("current_request_with_host")
async def test_sign_in_through_frameleaf(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/server/ping", json={"res": "pong"})
    aioclient_mock.get(
        f"{URL}/.well-known/oauth-authorization-server",
        json={"registration_endpoint": f"{API}/oauth/apps/register"},
    )
    aioclient_mock.post(f"{API}/oauth/apps/register", status=201, json={"client_id": "client-1"})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_OAUTH}
    )

    assert result["type"] is FlowResultType.EXTERNAL_STEP
    url = urlparse(result["url"])
    query = parse_qs(url.query)
    assert f"{url.scheme}://{url.netloc}{url.path}" == f"{API}/oauth/apps/authorize"
    assert query["client_id"] == ["client-1"]
    # only seeing the library, with PKCE S256
    assert query["scope"] == ["library:read"]
    assert query["code_challenge_method"] == ["S256"]
    registration = next(call for call in aioclient_mock.mock_calls if str(call[1]).endswith("/register"))
    assert registration[2]["token_endpoint_auth_method"] == "none"
    assert registration[2]["redirect_uris"] == [query["redirect_uri"][0]]


@pytest.mark.usefixtures("current_request_with_host")
async def test_registration_closed(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/server/ping", json={"res": "pong"})
    aioclient_mock.get(f"{URL}/.well-known/oauth-authorization-server", json={})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_OAUTH}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "registration_closed"


async def test_found_on_this_network(hass: HomeAssistant, aioclient_mock) -> None:
    from ipaddress import ip_address

    from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

    info = ZeroconfServiceInfo(
        ip_address=ip_address("192.168.1.20"),
        ip_addresses=[ip_address("192.168.1.20")],
        hostname="frameleaf.local.",
        name="Taylor home._frameleaf._tcp.local.",
        port=2283,
        type="_frameleaf._tcp.local.",
        properties={"id": "server-1", "name": "Taylor home", "scheme": "http"},
    )
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=info
    )
    assert result["step_id"] == "user"
    schema = result["data_schema"].schema
    url = next(key for key in schema if key == CONF_URL)
    assert url.default() == "http://192.168.1.20:2283"


async def test_discovery_of_a_server_already_added(hass: HomeAssistant) -> None:
    from ipaddress import ip_address

    from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    MockConfigEntry(domain=DOMAIN, unique_id="x", data={CONF_URL: "http://192.168.1.20:2283"}).add_to_hass(hass)
    info = ZeroconfServiceInfo(
        ip_address=ip_address("192.168.1.20"),
        ip_addresses=[ip_address("192.168.1.20")],
        hostname="frameleaf.local.",
        name="Taylor home._frameleaf._tcp.local.",
        port=2283,
        type="_frameleaf._tcp.local.",
        properties={"id": "server-1"},
    )
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=info
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_server_that_does_not_answer(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{API}/server/ping", exc=TimeoutError())
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: URL, CONF_AUTH_METHOD: AUTH_OAUTH}
    )
    assert result["errors"] == {"base": "cannot_connect"}

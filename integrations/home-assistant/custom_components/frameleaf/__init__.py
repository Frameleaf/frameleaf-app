"""Frameleaf for Home Assistant: library sensors, a picture for dashboards, and Frameleaf events."""

from __future__ import annotations

from dataclasses import dataclass

from aiohttp import ClientError, ClientResponseError
from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_KEY, CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_entry_oauth2_flow
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.config_entry_oauth2_flow import LocalOAuth2ImplementationWithPkce

from .api import FrameleafApi, FrameleafAuthError, FrameleafError
from .const import (
    AUTH_API_KEY,
    CONF_AUTH_METHOD,
    CONF_CLIENT_ID,
    CONF_EVENTS,
    CONF_WEBHOOK_ID,
    DOMAIN,
    OAUTH_SCOPES,
)
from .coordinator import FrameleafCoordinator
from .events import async_remove_events, async_setup_events

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.IMAGE, Platform.BUTTON]


@dataclass
class FrameleafRuntime:
    coordinator: FrameleafCoordinator
    api: FrameleafApi
    # an administrator's API key can reach the administrator pages; a connected app never can (FL-803)
    can_administer: bool


type FrameleafConfigEntry = ConfigEntry[FrameleafRuntime]


class FrameleafOAuth2Implementation(LocalOAuth2ImplementationWithPkce):
    """FL-803: Home Assistant registered itself with the server as a connected app; no secret, PKCE S256."""

    def __init__(self, hass: HomeAssistant, url: str, client_id: str) -> None:
        base = url.rstrip("/")
        super().__init__(
            hass,
            f"{DOMAIN}_{client_id}",
            client_id,
            authorize_url=f"{base}/api/oauth/apps/authorize",
            token_url=f"{base}/api/oauth/apps/token",
        )

    @property
    def name(self) -> str:
        return "Frameleaf"

    @property
    def extra_authorize_data(self) -> dict:
        return {"scope": OAUTH_SCOPES, **super().extra_authorize_data}


def register_implementation(hass: HomeAssistant, url: str, client_id: str) -> FrameleafOAuth2Implementation:
    implementation = FrameleafOAuth2Implementation(hass, url, client_id)
    config_entry_oauth2_flow.async_register_implementation(hass, DOMAIN, implementation)
    return implementation


def build_api(hass: HomeAssistant, entry: ConfigEntry) -> FrameleafApi:
    session = async_get_clientsession(hass)
    url = entry.data[CONF_URL]
    if entry.data.get(CONF_AUTH_METHOD) == AUTH_API_KEY:
        key = entry.data[CONF_API_KEY]

        async def key_headers() -> dict[str, str]:
            return {"x-api-key": key}

        return FrameleafApi(session, url, key_headers)

    implementation = register_implementation(hass, url, entry.data[CONF_CLIENT_ID])
    oauth = config_entry_oauth2_flow.OAuth2Session(hass, entry, implementation)

    async def token_headers() -> dict[str, str]:
        try:
            await oauth.async_ensure_token_valid()
        except ClientResponseError as error:
            # the app was removed under Connected apps (or its refresh token expired): sign in again
            # 429 is "too many requests": try again later with the same credentials
            if 400 <= error.status < 500 and error.status != 429:
                raise FrameleafAuthError("Frameleaf refused to refresh the sign-in") from error
            raise FrameleafError(f"Frameleaf could not refresh the sign-in: {error}") from error
        except (ClientError, TimeoutError) as error:
            raise FrameleafError(f"Frameleaf could not refresh the sign-in: {error}") from error
        return {"Authorization": f"Bearer {oauth.token['access_token']}"}

    return FrameleafApi(session, url, token_headers, is_app=True)


async def async_setup_entry(hass: HomeAssistant, entry: FrameleafConfigEntry) -> bool:
    api = build_api(hass, entry)
    coordinator = FrameleafCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()
    can_administer = entry.data.get(CONF_AUTH_METHOD) == AUTH_API_KEY and coordinator.data.is_admin
    entry.runtime_data = FrameleafRuntime(coordinator=coordinator, api=api, can_administer=can_administer)
    if can_administer and entry.data.get(CONF_EVENTS):
        await async_setup_events(hass, entry, api)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: FrameleafConfigEntry) -> bool:
    if webhook_id := entry.data.get(CONF_WEBHOOK_ID):
        webhook.async_unregister(hass, webhook_id)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Removing the integration also removes the Frameleaf workflows it made."""
    if entry.data.get(CONF_AUTH_METHOD) == AUTH_API_KEY:
        await async_remove_events(hass, entry, build_api(hass, entry))

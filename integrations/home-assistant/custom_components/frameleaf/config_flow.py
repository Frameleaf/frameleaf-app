"""Adding Frameleaf: sign in through Frameleaf's Allow page (recommended), or with an API key."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import SOURCE_REAUTH, ConfigFlowResult
from homeassistant.const import CONF_API_KEY, CONF_URL
from homeassistant.helpers import config_entry_oauth2_flow
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import SelectSelector, SelectSelectorConfig, SelectSelectorMode
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from . import register_implementation
from .api import FrameleafApi, FrameleafAuthError, FrameleafError, FrameleafForbidden, check_server, register_client
from .const import (
    AUTH_API_KEY,
    AUTH_OAUTH,
    CLIENT_NAME,
    CONF_AUTH_METHOD,
    CONF_CLIENT_ID,
    CONF_EVENTS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


class FrameleafFlowHandler(config_entry_oauth2_flow.AbstractOAuth2FlowHandler, domain=DOMAIN):
    DOMAIN = DOMAIN
    VERSION = 1

    def __init__(self) -> None:
        super().__init__()
        self._url: str | None = None
        self._client_id: str | None = None

    @property
    def logger(self) -> logging.Logger:
        return _LOGGER

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        """FL-229: a Frameleaf server on this network advertises itself (`_frameleaf._tcp`)."""
        properties = discovery_info.properties
        scheme = "https" if properties.get("scheme") == "https" else "http"
        host = f"[{discovery_info.host}]" if ":" in discovery_info.host else discovery_info.host
        self._url = f"{scheme}://{host}:{discovery_info.port}"
        if server_id := properties.get("id"):
            await self.async_set_unique_id(f"discovered#{server_id}")
            self._abort_if_unique_id_configured()
        self.context["title_placeholders"] = {"name": properties.get("name") or "Frameleaf"}
        return await self.async_step_user()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            try:
                await check_server(async_get_clientsession(self.hass), url)
            except FrameleafError:
                errors["base"] = "cannot_connect"
            else:
                self._url = url
                if user_input[CONF_AUTH_METHOD] == AUTH_API_KEY:
                    return await self.async_step_api_key()
                return await self.async_step_oauth()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, self._url or "http://")): str,
                    vol.Required(CONF_AUTH_METHOD, default=AUTH_OAUTH): SelectSelector(
                        SelectSelectorConfig(
                            options=[AUTH_OAUTH, AUTH_API_KEY],
                            translation_key="auth_method",
                            mode=SelectSelectorMode.LIST,
                        )
                    ),
                }
            ),
            errors=errors,
        )

    async def async_step_oauth(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """FL-803: Home Assistant registers itself as a connected app, then the person allows it in Frameleaf."""
        assert self._url
        try:
            self._client_id, _ = await register_client(
                async_get_clientsession(self.hass),
                self._url,
                config_entry_oauth2_flow.async_get_redirect_uri(self.hass),
                CLIENT_NAME,
            )
        except FrameleafForbidden:
            return self.async_abort(reason="registration_closed")
        except FrameleafError:
            return self.async_abort(reason="cannot_connect")
        implementation = register_implementation(self.hass, self._url, self._client_id)
        return await self.async_step_pick_implementation({"implementation": implementation.domain})

    async def async_oauth_create_entry(self, data: dict[str, Any]) -> ConfigFlowResult:
        assert self._url and self._client_id
        token = data["token"]["access_token"]

        async def headers() -> dict[str, str]:
            return {"Authorization": f"Bearer {token}"}

        try:
            # a connected app only sees the library: check the token can read it
            await FrameleafApi(async_get_clientsession(self.hass), self._url, headers, is_app=True).get_statistics()
        except FrameleafError:
            return self.async_abort(reason="cannot_connect")
        entry_data = {**data, CONF_URL: self._url, CONF_AUTH_METHOD: AUTH_OAUTH, CONF_CLIENT_ID: self._client_id}
        if self.source == SOURCE_REAUTH:
            # signing in again registers Home Assistant anew; the entry stays the same
            return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=entry_data)
        await self.async_set_unique_id(f"{self._url}#app-{self._client_id}")
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title="Frameleaf", data=entry_data)

    async def async_step_api_key(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """An API key made in Frameleaf (Settings › API keys). An administrator's key also reaches the
        administrator sensors, the library scan button and Frameleaf events."""
        assert self._url
        errors: dict[str, str] = {}
        if user_input is not None:
            key = user_input[CONF_API_KEY].strip()

            async def headers() -> dict[str, str]:
                return {"x-api-key": key}

            try:
                user = await FrameleafApi(async_get_clientsession(self.hass), self._url, headers).get_me()
            except (FrameleafAuthError, FrameleafForbidden):
                errors["base"] = "invalid_auth"
            except FrameleafError:
                errors["base"] = "cannot_connect"
            else:
                return await self._finish(
                    user,
                    {
                        CONF_URL: self._url,
                        CONF_AUTH_METHOD: AUTH_API_KEY,
                        CONF_API_KEY: key,
                        CONF_EVENTS: bool(user_input.get(CONF_EVENTS)) and bool(user.get("isAdmin")),
                    },
                )
        return self.async_show_form(
            step_id="api_key",
            data_schema=vol.Schema(
                {vol.Required(CONF_API_KEY): str, vol.Optional(CONF_EVENTS, default=True): bool},
            ),
            errors=errors,
        )

    async def _finish(self, user: dict[str, Any], data: dict[str, Any]) -> ConfigFlowResult:
        await self.async_set_unique_id(f"{data[CONF_URL]}#{user['id']}")
        if self.source == SOURCE_REAUTH:
            self._abort_if_unique_id_mismatch(reason="wrong_account")
            return self.async_update_reload_and_abort(self._get_reauth_entry(), data_updates=data)
        self._abort_if_unique_id_configured()
        return self.async_create_entry(title=user.get("name") or user.get("email") or "Frameleaf", data=data)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """The sign-in stopped working: the app was removed in Frameleaf, or the key was deleted."""
        self._url = entry_data[CONF_URL]
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(step_id="reauth_confirm")
        if self._get_reauth_entry().data.get(CONF_AUTH_METHOD) == AUTH_API_KEY:
            return await self.async_step_api_key()
        return await self.async_step_oauth()

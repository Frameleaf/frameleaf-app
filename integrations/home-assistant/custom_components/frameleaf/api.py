"""A small client for the parts of the Frameleaf API this integration reads."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout

TIMEOUT = ClientTimeout(total=30)


class FrameleafError(Exception):
    """Frameleaf could not be reached or answered with an error."""


class FrameleafAuthError(FrameleafError):
    """The sign-in is no longer valid (expired, revoked or removed): sign in again."""


class FrameleafForbidden(FrameleafError):
    """This sign-in may not see that (an administrator-only page, or a scope not granted)."""


class FrameleafApi:
    """Calls Frameleaf as the signed-in account, with its access token or API key."""

    def __init__(
        self,
        session: ClientSession,
        url: str,
        headers: Callable[[], Awaitable[dict[str, str]]],
        *,
        is_app: bool = False,
    ) -> None:
        self._session = session
        self.url = url.rstrip("/")
        self._headers = headers
        # FL-803: a connected app sees the library only; it cannot read the account itself or any admin page
        self.is_app = is_app

    async def _request(self, method: str, path: str, *, json: Any = None, expect: str = "json") -> Any:
        # outside the try below: a refused token refresh must reach the caller as FrameleafAuthError
        headers = await self._headers()
        try:
            async with self._session.request(
                method,
                f"{self.url}/api{path}",
                json=json,
                headers=headers,
                timeout=TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise FrameleafAuthError("Frameleaf asked to sign in again")
                if response.status == 403:
                    raise FrameleafForbidden(f"Frameleaf does not allow {method} {path} for this sign-in")
                if response.status >= 400:
                    raise FrameleafError(f"Frameleaf answered {response.status} to {method} {path}")
                if expect == "bytes":
                    return await response.read()
                if response.status == 204:
                    return None
                return await response.json()
        except (ClientError, TimeoutError) as error:
            raise FrameleafError(f"Frameleaf could not be reached: {error}") from error

    async def get_me(self) -> dict[str, Any]:
        return await self._request("GET", "/users/me")

    async def get_statistics(self) -> dict[str, Any]:
        return await self._request("GET", "/assets/statistics")

    async def get_backup_devices(self) -> dict[str, Any]:
        return await self._request("GET", "/users/me/backup-devices")

    async def get_today_memories(self, day: str) -> list[dict[str, Any]]:
        return await self._request("GET", f"/memories?for={day}")

    async def random_favorite(self) -> list[dict[str, Any]]:
        # only photos on the timeline: never Locked, hidden or archived ones
        return await self._request(
            "POST",
            "/search/random",
            json={"isFavorite": True, "type": "IMAGE", "visibility": "timeline", "size": 1},
        )

    async def get_asset(self, asset_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/assets/{asset_id}")

    async def thumbnail(self, asset_id: str) -> bytes:
        return await self._request("GET", f"/assets/{asset_id}/thumbnail?size=preview", expect="bytes")

    # administrators (API key) only

    async def get_storage(self) -> dict[str, Any]:
        return await self._request("GET", "/server/storage")

    async def get_cloud_backup(self) -> dict[str, Any]:
        return await self._request("GET", "/admin/cloud/backup")

    async def get_attention(self) -> dict[str, Any]:
        return await self._request("GET", "/admin/attention")

    async def get_libraries(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/libraries")

    async def scan_library(self, library_id: str) -> None:
        await self._request("POST", f"/libraries/{library_id}/scan", json={})

    async def get_event_triggers(self) -> list[dict[str, Any]]:
        discovery = await self._request("GET", "/workflows/automation/discovery")
        return discovery.get("eventTriggers", [])

    async def create_workflow(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/workflows", json=body)

    async def delete_workflow(self, workflow_id: str) -> None:
        await self._request("DELETE", f"/workflows/{workflow_id}")


async def check_server(session: ClientSession, url: str) -> None:
    """Raises FrameleafError unless `url` is a Frameleaf server that answers."""
    try:
        async with session.get(f"{url.rstrip('/')}/api/server/ping", timeout=TIMEOUT) as response:
            if response.status != 200 or (await response.json()).get("res") != "pong":
                raise FrameleafError("This address is not a Frameleaf server")
    except (ClientError, TimeoutError, ValueError) as error:
        raise FrameleafError(f"Frameleaf could not be reached: {error}") from error


async def register_client(session: ClientSession, url: str, redirect_uri: str, name: str) -> tuple[str, dict]:
    """FL-803: registers Home Assistant as a connected app; answers its client id and the server's endpoints."""
    base = url.rstrip("/")
    try:
        async with session.get(f"{base}/.well-known/oauth-authorization-server", timeout=TIMEOUT) as response:
            if response.status != 200:
                raise FrameleafError("This Frameleaf server does not offer sign-in for apps")
            metadata = await response.json()
        registration = metadata.get("registration_endpoint")
        if not registration:
            raise FrameleafForbidden("This server does not let new apps register themselves")
        async with session.post(
            registration,
            json={
                "client_name": name,
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            },
            timeout=TIMEOUT,
        ) as response:
            if response.status == 403:
                raise FrameleafForbidden("This server does not let new apps register themselves")
            if response.status >= 400:
                raise FrameleafError(f"Frameleaf answered {response.status} to the app registration")
            client = await response.json()
    except (ClientError, TimeoutError, ValueError) as error:
        raise FrameleafError(f"Frameleaf could not be reached: {error}") from error
    return client["client_id"], metadata

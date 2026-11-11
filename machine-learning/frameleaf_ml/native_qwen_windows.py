"""Bind Windows loopback HTTP to the owned llama-server process before writing."""

import ctypes
import http.client
import socket
import struct
import sys
import time
from typing import Any

import orjson

LOOPBACK = "127.0.0.1"
LOOPBACK_DWORD = int.from_bytes(socket.inet_aton(LOOPBACK), "little")
ESTABLISHED = 5
OWNER_PID_CONNECTIONS = 4
INSUFFICIENT_BUFFER = 122
ROW = struct.Struct("<6I")


def connection_owner(table: bytes, server_port: int, client_port: int) -> int | None:
    if len(table) < 4:
        return None
    count = struct.unpack_from("<I", table)[0]
    if count > (len(table) - 4) // ROW.size:
        return None
    expected = (ESTABLISHED, LOOPBACK_DWORD, socket.htons(server_port), LOOPBACK_DWORD, socket.htons(client_port))
    owners = {
        pid
        for state, local, local_port, remote, remote_port, pid in ROW.iter_unpack(table[4 : 4 + count * ROW.size])
        if (state, local, local_port & 0xFFFF, remote, remote_port & 0xFFFF) == expected
    }
    return next(iter(owners)) if len(owners) == 1 else None


def tcp_owner(server_port: int, client_port: int) -> int | None:
    if sys.platform != "win32":
        return None
    # LOAD_LIBRARY_SEARCH_SYSTEM32 excludes DLLs in the working directory and PATH.
    get_table = ctypes.WinDLL("iphlpapi.dll", winmode=0x800).GetExtendedTcpTable
    get_table.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_int, *([ctypes.c_uint32] * 3)]
    get_table.restype = ctypes.c_uint32
    size = ctypes.c_uint32()
    args = (False, socket.AF_INET, OWNER_PID_CONNECTIONS, 0)
    if get_table(None, ctypes.byref(size), *args) != INSUFFICIENT_BUFFER:
        return None
    for _ in range(3):
        if not 4 <= size.value <= 4 * 1024 * 1024:
            return None
        table = ctypes.create_string_buffer(size.value)
        code = get_table(table, ctypes.byref(size), *args)
        if code == 0:
            return connection_owner(table.raw[: size.value], server_port, client_port)
        if code != INSUFFICIENT_BUFFER:
            return None
    return None


def request_owned(
    port: int,
    pid: int,
    token: str,
    method: str,
    path: str,
    timeout: float,
    limit: int,
    body: dict[str, Any] | None,
) -> bytes:
    # Check the accepted connection, not a listener snapshot. Use that exact socket for HTTP.
    with socket.create_connection((LOOPBACK, port), timeout=timeout) as wire:
        client_address, client_port = wire.getsockname()
        if client_address != LOOPBACK or wire.getpeername() != (LOOPBACK, port) or pid <= 0:
            raise ValueError("native_qwen_peer_unverified")
        # Allow the newly established endpoint to appear in the owner table.
        owner = tcp_owner(port, client_port)
        for _ in range(3):
            if owner is not None:
                break
            time.sleep(0.025)
            owner = tcp_owner(port, client_port)
        if owner != pid:
            raise ValueError("native_qwen_peer_unverified")
        connection = http.client.HTTPConnection(LOOPBACK, port, timeout=timeout)
        connection.auto_open = 0
        connection.sock = wire
        try:
            connection.request(
                method,
                path,
                orjson.dumps(body) if body is not None else None,
                {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Connection": "close"},
            )
            response = connection.getresponse()
            if response.status != 200:
                raise OSError("native_qwen_http_failed")
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("native_qwen_output_invalid")
            return raw
        except http.client.HTTPException as error:
            raise OSError("native_qwen_http_failed") from error
        finally:
            connection.close()

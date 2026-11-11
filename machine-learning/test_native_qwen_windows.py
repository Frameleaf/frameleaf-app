import os
import socket
import struct
import threading

import pytest

from frameleaf_ml import native_qwen_windows as transport


def test_windows_owner_table_requires_exact_established_server_tuple():
    loopback = transport.LOOPBACK_DWORD
    server, client = map(socket.htons, (18191, 18202))
    rows = [
        (2, loopback, server, 0, 0, 1),  # Listener snapshots are insufficient.
        (5, loopback, client, loopback, server, 2),  # The client endpoint is not the server.
        (5, loopback, server, loopback, client, 3),
    ]
    table = struct.pack("<I", len(rows)) + b"".join(transport.ROW.pack(*row) for row in rows)
    assert transport.connection_owner(table, 18191, 18202) == 3
    assert transport.connection_owner(table, 18191, 18203) is None
    assert transport.connection_owner(table[:-1], 18191, 18202) is None
    conflict = struct.pack("<I", 4) + table[4:] + transport.ROW.pack(*rows[-1][:-1], 4)
    assert transport.connection_owner(conflict, 18191, 18202) is None


@pytest.mark.parametrize("trusted", [False, True])
def test_http_uses_only_verified_peer_and_never_sends_to_wrong_owner(monkeypatch, trusted):
    received = []
    token = "q" * 64
    with socket.socket() as listener:
        listener.bind((transport.LOOPBACK, 0))
        port = listener.getsockname()[1]
        listener.listen(1)
        listener.settimeout(4)

        def serve():
            with listener.accept()[0] as wire:
                wire.settimeout(4)
                with wire.makefile("rb") as reader:
                    request = reader.readline()
                    if request:
                        headers = {}
                        while (line := reader.readline()).strip():
                            name, value = line.split(b":", 1)
                            headers[name.lower()] = value.strip()
                        received.append(
                            (request, headers[b"authorization"], reader.read(int(headers[b"content-length"])))
                        )
                        wire.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")

        server = threading.Thread(target=serve)
        server.start()
        try:
            if os.name != "nt":
                monkeypatch.setattr(
                    transport, "tcp_owner", lambda server_port, _client: os.getpid() if server_port == port else None
                )
            expected_pid = os.getpid() if trusted else os.getpid() + 1
            args = (port, expected_pid, token, "POST", "/predict", 3, 64, {"fixture": "synthetic"})
            if trusted:
                assert transport.request_owned(*args) == b"{}"
            else:
                with pytest.raises(ValueError, match="native_qwen_peer_unverified"):
                    transport.request_owned(*args)
        finally:
            server.join(timeout=5)
        assert not server.is_alive()
    assert received == (
        [(b"POST /predict HTTP/1.1\r\n", f"Bearer {token}".encode(), b'{"fixture":"synthetic"}')] if trusted else []
    )

"""Attempt-local HTTP transports. The launcher independently denies IP sockets."""
from contextlib import contextmanager
import os
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
import re
import socket
import time
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

import requests
from curl_cffi import CurlOpt
from requests.cookies import get_cookie_header
from urllib3.exceptions import ConnectTimeoutError, NewConnectionError
from yt_dlp.networking._curlcffi import CurlCFFIRH
from yt_dlp.networking._requests import RequestsRH

SYSTEM_CA = "/etc/ssl/certs/ca-certificates.crt"
CROSS_ORIGIN_HEADERS = frozenset(("accept", "accept-encoding", "accept-language", "range", "user-agent"))
HOST_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
BROWSER_ORIGIN = re.compile(
    rf"https?://(?:\[[0-9a-f:.]+\]|{HOST_LABEL}(?:\.{HOST_LABEL})*\.?)(?::[0-9]{{1,5}})?",
    re.IGNORECASE | re.ASCII,
)


class BridgeError(Exception):
    def __init__(self, code, retry_after=None):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


def http_url(url):
    if not isinstance(url, str) or len(url) > 16384 or re.search(r"[\x00-\x20\x7f\\]", url):
        return None
    try:
        parts = urlsplit(url)
        if parts.scheme in ("https", "http") and parts.hostname and parts.username is None and parts.password is None:
            return url
    except ValueError:
        pass
    return None


def cookie_policy():
    return DefaultCookiePolicy(strict_ns_domain=DefaultCookiePolicy.DomainStrictNonDomain)


def domain_matches(host, domains):
    host = host.lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def session_domains(session):
    return tuple(domain.lower().strip(".") for domain in session.get("domains", ()))


def load_session_cookies(jar, session):
    jar.set_policy(cookie_policy())
    domains = session_domains(session)
    for value in session.get("cookies") or ():
        domain = value["domain"].lower().lstrip(".")
        expires = value.get("expires")
        name = value["name"]
        data = value["value"]
        path = value["path"]
        if (value.get("partitionKey") is not None or not domain_matches(domain, domains)
                or not re.fullmatch(r"[!#$%&'*+.^_`|~\w-]+", name, re.ASCII)
                or re.search(r"[\x00-\x20\x7f;]", data)
                or not path.startswith("/") or re.search(r"[\x00-\x20\x7f]", path)):
            raise BridgeError("unsupported_session")
        if expires is not None:
            if expires <= time.time():
                continue
            expires = int(expires)
        host_only = value["hostOnly"]
        jar.set_cookie(Cookie(
            0, name, data, None, False, domain if host_only else "." + domain,
            not host_only, not host_only, path, True, value["secure"], expires,
            expires is None, None, None, {"HttpOnly": None} if value["httpOnly"] else {}, False,
        ))


def read_exact(connection, length):
    result = bytearray()
    while len(result) < length:
        data = connection.recv(length - len(result))
        if not data:
            raise OSError("SOCKS connection closed")
        result.extend(data)
    return bytes(result)


def unix_connection(path, token, host, port, timeout):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.settimeout(timeout)
        connection.connect(path)
        connection.sendall(b"\x05\x01\x02")
        if read_exact(connection, 2) != b"\x05\x02":
            raise OSError("SOCKS authentication unavailable")
        password = token.encode("ascii")
        connection.sendall(b"\x01\x03job" + bytes([len(password)]) + password)
        if read_exact(connection, 2) != b"\x01\x00":
            raise OSError("SOCKS authentication failed")
        host = host.strip("[]").encode("idna")
        connection.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + port.to_bytes(2, "big"))
        if read_exact(connection, 10) != b"\x05\x00\x00\x01" + b"\x00" * 6:
            raise OSError("SOCKS connection rejected")
        return connection
    except BaseException:
        connection.close()
        raise


def gallery_session_factory(path, token, session):
    domains = session_domains(session)
    auth_hosts = ({"www.reddit.com", "oauth.reddit.com"} if session.get("refreshToken") else
                  {"bsky.social"} if session.get("username") and session.get("password") else None)

    class UnixConnection:
        def _new_conn(self):
            try:
                return unix_connection(path, token, self.host, self.port, self.timeout)
            except TimeoutError as error:
                raise ConnectTimeoutError(self, "SOCKS connection timed out") from error
            except OSError as error:
                raise NewConnectionError(self, "SOCKS connection failed") from error

    class UnixSession(requests.Session):
        def __init__(self):
            super().__init__()
            self.trust_env = False
            self.max_redirects = 5
            self.file_scope = None
            self.header_origin = None
            load_session_cookies(self.cookies, session)

        def mount(self, prefix, adapter):
            manager = adapter.poolmanager
            pools = {}
            for scheme, pool in manager.pool_classes_by_scheme.items():
                if not issubclass(pool.ConnectionCls, UnixConnection):
                    connection = type("UnixConnection", (UnixConnection, pool.ConnectionCls), {})
                    pool = type("UnixPool", (pool,), {"ConnectionCls": connection})
                pools[scheme] = pool
            manager.pool_classes_by_scheme = pools
            super().mount(prefix, adapter)

        def get_adapter(self, url):
            if not http_url(url):
                raise BridgeError("invalid_url")
            return super().get_adapter(url)

        @contextmanager
        def file_headers(self, source_url, target_url, headers):
            self.file_scope = (self.header_origin or origin(source_url), origin(target_url), {
                key: value for key, value in headers.items()
                if key.lower() not in {"host", "proxy-authorization", "connection", "content-length", "transfer-encoding"}
            })
            try:
                yield
            finally:
                self.file_scope = None

        def prepare_request(self, request):
            if (request.method == "POST" and request.url == "https://www.reddit.com/api/v1/access_token"
                    and session.get("clientSecret") and session.get("clientId") and session.get("refreshToken")
                    and domain_matches("www.reddit.com", session_domains(session))):
                request.auth = (session["clientId"], session["clientSecret"])
            prepared = super().prepare_request(request)
            if "Cookie" not in self.headers and "Cookie" not in (request.headers or {}):
                prepared.headers.pop("Cookie", None)
            return prepared

        def get_redirect_target(self, response):
            target = super().get_redirect_target(response)
            if target and response.request.method not in ("GET", "HEAD") and response.status_code in (307, 308):
                url = urljoin(response.url, target)
                if urlsplit(url)[:2] != urlsplit(response.url)[:2]:
                    raise BridgeError("unsupported_session")
            return target

        def send(self, request, **kwargs):
            kwargs["proxies"] = {}
            kwargs["verify"] = SYSTEM_CA if os.path.isfile(SYSTEM_CA) else True
            target = urlsplit(request.url)
            destination = origin(request.url)
            if self.file_scope:
                source, file, headers = self.file_scope
                if destination != source:
                    retain_browser_headers(request)
                if destination == file:
                    for key, value in headers.items():
                        if value is None:
                            request.headers.pop(key, None)
                        else:
                            request.headers[key] = value
                else:
                    for key in headers:
                        request.headers.pop(key, None)
            elif self.header_origin is None:
                self.header_origin = destination
            elif destination != self.header_origin:
                for key in self.headers:
                    if not is_cross_origin_header(key, request.headers.get(key)):
                        request.headers.pop(key, None)
            if not is_browser_origin(request.headers.get("Origin")):
                request.headers.pop("Origin", None)
            if auth_hosts and (target.scheme != "https" or target.hostname not in auth_hosts):
                request.headers.pop("Authorization", None)
            if domains and not domain_matches(target.hostname or "", domains):
                request.headers.pop("Cookie", None)
                request.headers.pop("X-CSRF-Token", None)
            if "Cookie" not in request.headers and request._cookies is not None:
                jar = CookieJar(cookie_policy())
                for cookie in request._cookies:
                    jar.set_cookie(cookie)
                if cookie_header := get_cookie_header(jar, request):
                    request.headers["Cookie"] = cookie_header
            return super().send(request, **kwargs)

        def rebuild_auth(self, prepared_request, response):
            super().rebuild_auth(prepared_request, response)
            if origin(prepared_request.url) != origin(response.request.url):
                retain_browser_headers(prepared_request)

        def rebuild_proxies(self, prepared_request, proxies):
            # Requests rebuilds its own Cookie header on redirects with a liberal policy.
            prepared_request.headers.pop("Cookie", None)
            return {}

    return UnixSession


def origin(url):
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)


def is_browser_origin(value):
    if not isinstance(value, str) or len(value) > 268 or not BROWSER_ORIGIN.fullmatch(value):
        return False
    try:
        parts = urlsplit(value)
        return len(parts.hostname.rstrip(".")) <= 253 and (parts.port is None or 0 <= parts.port <= 65535)
    except ValueError:
        return False


def is_cross_origin_header(name, value):
    name = name.lower()
    return name in CROSS_ORIGIN_HEADERS or (name == "origin" and is_browser_origin(value))


def retain_browser_headers(request):
    referer = http_url(request.headers.get("Referer"))
    for key in tuple(request.headers):
        if not is_cross_origin_header(key, request.headers[key]):
            request.headers.pop(key, None)
    if referer:
        parts = urlsplit(referer)
        if parts.scheme != "https" or urlsplit(request.url).scheme == "https":
            request.headers["Referer"] = urlunsplit((parts.scheme, parts.netloc, "/", "", ""))


def gallery_requests_handler(session):
    class GalleryRequestsRH(RequestsRH):
        def _prepare_headers(self, request, headers):
            super()._prepare_headers(request, headers)
            for key, value in session.headers.items():
                if key.lower() not in {"host", "range", "connection", "content-length", "transfer-encoding"}:
                    headers[key] = value

        def _create_instance(self, cookiejar, legacy_ssl_support=None):
            return session

    return GalleryRequestsRH


def curl_handler(path, token):
    proxy = f"socks5h://job:{token}@localhost{quote(path, safe='/')}"

    class UnixCurlRH(CurlCFFIRH):
        def _get_proxies(self, _request):
            return {"all": proxy, "no": ""}

        def _create_instance(self, cookiejar=None):
            session = super()._create_instance(cookiejar)
            session.curl_options = {
                CurlOpt.PROTOCOLS_STR: "http,https",
                CurlOpt.REDIR_PROTOCOLS_STR: "http,https",
            }
            if os.path.isfile(SYSTEM_CA):
                session.curl_options[CurlOpt.CAINFO] = SYSTEM_CA
            return session

    return UnixCurlRH

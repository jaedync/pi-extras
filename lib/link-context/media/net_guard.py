"""A loopback proxy that refuses private, loopback, link-local and metadata addresses.

yt-dlp follows redirects inside each HTTP library (urllib, requests, and
libcurl through curl_cffi, which Python's socket module never sees), and
ffmpeg makes its own HTTP requests when it cuts clips. All of them send every
HTTP request through yt-dlp's `proxy` setting, so a proxy is the one place
that sees each hop: a redirect, a manifest, a fragment. The proxy resolves the
name itself and connects only to addresses it checked, so a DNS answer that
changes between the check and the connection cannot get past it.

When the user set a proxy (Upstream), each checked request goes on through
it, to the checked address and not the name.

Stdlib only. Loaded by helper.py from this folder.
"""
import base64
import ipaddress
import os
import selectors
import socket
import socketserver
import ssl
import threading
from urllib.parse import unquote, urlsplit
from urllib.request import getproxies_environment, proxy_bypass_environment

MAX_HEADER_BYTES = 64 * 1024
CONNECT_TIMEOUT = 30
# An idle client may not hold a thread for ever while it sends its request head.
HEAD_TIMEOUT = 30
# A stalled transfer ends after this long with no byte in either direction.
IDLE_TIMEOUT = 300
BUFFER = 64 * 1024

NAT64 = ipaddress.ip_network("64:ff9b::/96")
# Local-use NAT64, 6to4 and Teredo carry or route to an address that cannot be checked here.
EMBEDDING_V4 = [ipaddress.ip_network(net) for net in ("64:ff9b:1::/48", "2002::/16", "2001::/32")]

# Names that resolved to a refused address, so the caller can say why a request failed.
REFUSED = []


def private_address(text):
    """True for any address that is not plainly public."""
    ip = ipaddress.ip_address(text.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.version == 6 and ip in NAT64:
        # DNS64 on an IPv6-only network: the last 32 bits are the IPv4 address it reaches.
        ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip.version == 6 and (ip.is_site_local or any(ip in net for net in EMBEDDING_V4)):
        return True
    return not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified


def refused(address):
    try:
        return private_address(address)
    except ValueError:
        return True


class Unresolved(Exception):
    pass


class Guard:
    def __init__(self, allow=()):
        # Exact host:port pairs that skip the check; only the tests set them.
        self.allow = frozenset(allow)

    def resolve(self, host, port):
        """The checked addresses to try in turn, [] when the host is refused; Unresolved when DNS fails."""
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (OSError, UnicodeError) as error:
            raise Unresolved(host) from error
        addresses = list(dict.fromkeys(info[4][0] for info in infos))
        if not addresses:
            raise Unresolved(host)
        if f"{host}:{port}" not in self.allow and any(refused(a) for a in addresses):
            REFUSED.append(host)
            return []
        return addresses


def connect_any(addresses, port):
    """A connection to the first checked address that answers."""
    error = OSError("no address")
    for address in addresses:
        try:
            return socket.create_connection((address, port), timeout=CONNECT_TIMEOUT)
        except OSError as failure:
            error = failure
    raise error


def pending(sock):
    """Bytes that TLS to an https proxy already decrypted: select() cannot see them, so they would wait for the next packet."""
    return sock.pending() if isinstance(sock, ssl.SSLSocket) else 0


def copy(sockets, pairs):
    """Copies bytes from each source to its target until a source closes, a socket fails or nothing moves.

    A source with no target is only watched: its bytes are dropped, and its close ends the copy.
    """
    selector = selectors.DefaultSelector()
    try:
        for source in sockets:
            selector.register(source, selectors.EVENT_READ)
        while True:
            ready = [s for s in sockets if pending(s)] or [key.fileobj for key, _ in selector.select(IDLE_TIMEOUT)]
            if not ready:
                return
            for source in ready:
                data = source.recv(BUFFER)
                if not data:
                    return
                if pairs.get(source) is not None:
                    pairs[source].sendall(data)
    except OSError:
        return
    finally:
        selector.close()


def split_target(target, default_port):
    """host:port or [v6]:port from a CONNECT line."""
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        return host, int(rest.lstrip(":") or default_port)
    host, _, port = target.partition(":")
    return host, int(port or default_port)


def read_head(sock):
    """Bytes up to the blank line after the headers, one at a time, so none of the body is taken; None when cut short."""
    head = b""
    while not head.endswith(b"\r\n\r\n"):
        byte = sock.recv(1)
        if not byte or len(head) > MAX_HEADER_BYTES:
            return None
        head += byte
    return head.decode("latin-1")


def header(headers, name):
    prefix = name.lower() + ":"
    return next((h.split(":", 1)[1].strip() for h in headers if h.lower().startswith(prefix)), None)


def body_length(headers):
    """The request body's length, 0 when there is none; None when the headers disagree or the value is not a count."""
    values = {h.split(":", 1)[1].strip() for h in headers if h.lower().startswith("content-length:")}
    if not values:
        return 0
    value = next(iter(values))
    # isdigit() alone accepts digits such as "²" that int() refuses.
    return int(value) if len(values) == 1 and value.isascii() and value.isdigit() else None


HOP_HEADERS = ("connection:", "keep-alive:", "proxy-", "transfer-encoding:", "te:", "upgrade:", "expect:")


def origin_path(url):
    path = url.path or "/"
    return f"{path}?{url.query}" if url.query else path


def forwarded(method, url, version, headers, target=None, extra=()):
    """The request for the origin (its own path) or for the user's proxy (target, extra), with no hop-by-hop or client proxy headers, and Connection: close."""
    keep = [h for h in headers if h and not h.lower().startswith(HOP_HEADERS)]
    line = f"{method} {target or origin_path(url)} {version}"
    return ("\r\n".join([line, *keep, *extra, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


def closing(head):
    """A response head that tells the client to open a new connection for its next request."""
    status, *headers = head[:-4].split("\r\n")
    keep = [h for h in headers if not h.lower().startswith(("connection:", "keep-alive:", "proxy-connection:"))]
    return ("\r\n".join([status, *keep, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


UPSTREAM_PORTS = {"http": 80, "https": 443, "socks5": 1080, "socks5h": 1080, "socks4": 1080, "socks4a": 1080}
SOCKS5_ERRORS = {1: "general failure", 2: "not allowed by its rules", 3: "network unreachable", 4: "host unreachable",
                 5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported"}
# "Not allowed" and "command not supported": another address would get the same answer.
SOCKS5_FINAL = (2, 7)


class BadProxy(ValueError):
    """A proxy setting that the guard cannot use. The call stops before any request; it never goes around the guard."""


class UpstreamFailure(Exception):
    """The user's proxy failed one request. retry: it could not reach this address, so the next checked one may work."""

    def __init__(self, text, retry=False):
        super().__init__(text)
        self.retry = retry


def bracketed(address):
    return f"[{address}]" if ":" in address else address


def ipv4_first(addresses):
    """The checked addresses with IPv4 first, for a request through the user's proxy.

    The proxy gets an address, not the name, so it cannot pick the family itself,
    and many proxies have no IPv6 route. A host with only IPv6 still works when
    the proxy can reach it.
    """
    return sorted(addresses, key=lambda address: ":" in address)


def receive_exact(sock, count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise ConnectionError("the connection closed")
        data += chunk
    return data


def printable(text):
    return "".join(c if c.isprintable() else "?" for c in text[:100])


class Upstream:
    """The user's proxy. It gets a request only after the check, and only for an address that the guard checked.

    It gets the address and not the name, so a DNS answer that changes between
    the check and the proxy's own lookup cannot reach a private address. A name
    that is private only inside the proxy's network is checked against this
    host's DNS, so the guard cannot see that case.

    The login is never part of a message: errors name the proxy by host:port.
    """

    def __init__(self, url, source):
        try:
            parts = urlsplit(url.strip())
            port = parts.port
            host = parts.hostname
        except ValueError:
            raise BadProxy(f"The proxy in {source} is not a valid URL.") from None
        self.scheme = parts.scheme.lower()
        # The scheme is not quoted: in "user:pass@host" urlsplit reads the user name as the scheme.
        if self.scheme not in UPSTREAM_PORTS:
            raise BadProxy(f"The proxy in {source} must start with one of {', '.join(s + '://' for s in UPSTREAM_PORTS)}.")
        if not host:
            raise BadProxy(f"The proxy in {source} has no host.")
        self.host = host
        self.port = port or UPSTREAM_PORTS[self.scheme]
        self.user = None if parts.username is None else unquote(parts.username)
        self.password = unquote(parts.password or "")
        self.label = f"{bracketed(host)}:{self.port}"
        if self.scheme.startswith("socks5") and max(len((self.user or "").encode()), len(self.password.encode())) > 255:
            raise BadProxy(f"The SOCKS5 proxy in {source} has a user name or password longer than 255 bytes.")
        self.tls = ssl.create_default_context() if self.scheme == "https" else None

    @property
    def absolute(self):
        """An HTTP proxy takes plain http as one absolute-form request; SOCKS takes it through a tunnel."""
        return self.scheme in ("http", "https")

    def authorization(self):
        if self.user is None:
            return []
        token = base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        return [f"Proxy-Authorization: Basic {token}"]

    def refused_login(self):
        if self.user is None:
            return UpstreamFailure(f"the proxy {self.label} needs a user name and password")
        return UpstreamFailure(f"the proxy {self.label} refused the user name or password")

    def connect(self):
        """A socket to the proxy itself, with verified TLS for an https proxy."""
        try:
            sock = socket.create_connection((self.host, self.port), timeout=CONNECT_TIMEOUT)
        except OSError as error:
            raise UpstreamFailure(f"could not connect to the proxy {self.label}: {error}") from None
        if self.tls is None:
            return sock
        try:
            return self.tls.wrap_socket(sock, server_hostname=self.host)
        except OSError as error:
            sock.close()
            raise UpstreamFailure(f"TLS to the proxy {self.label} failed: {error}") from None

    def open(self, addresses, port):
        """A tunnel through the proxy to the first checked address that it reaches."""
        failure = UpstreamFailure(f"the proxy {self.label} got no address")
        for address in addresses:
            sock = self.connect()
            try:
                self.handshake(sock, address.split("%")[0], port)
                return sock
            except UpstreamFailure as error:
                sock.close()
                if not error.retry:
                    raise
                failure = error
            except OSError as error:
                sock.close()
                raise UpstreamFailure(f"the proxy {self.label} failed: {error}") from None
        raise failure

    def handshake(self, sock, address, port):
        if self.absolute:
            self.http_connect(sock, address, port)
        elif self.scheme.startswith("socks5"):
            self.socks5(sock, address, port)
        else:
            self.socks4(sock, address, port)

    def http_connect(self, sock, address, port):
        target = f"{bracketed(address)}:{port}"
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}", *self.authorization()]
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        head = read_head(sock)
        if not head:
            raise UpstreamFailure(f"the proxy {self.label} closed the connection")
        status = head.split("\r\n", 1)[0]
        code = (status.split(" ") + [""])[1]
        if len(code) == 3 and code.startswith("2"):
            return
        if code == "407":
            raise self.refused_login()
        # A proxy that cannot reach this address answers 502 or 504; the next address may work.
        raise UpstreamFailure(f"the proxy {self.label} answered {printable(status)}", retry=True)

    def socks5(self, sock, address, port):
        login = self.user is not None
        sock.sendall(b"\x05\x02\x00\x02" if login else b"\x05\x01\x00")
        version, method = receive_exact(sock, 2)
        if version != 5:
            raise UpstreamFailure(f"the proxy {self.label} is not a SOCKS5 proxy")
        if method == 2 and login:
            self.socks5_login(sock)
        elif method != 0:
            raise self.refused_login()
        ip = ipaddress.ip_address(address)
        sock.sendall(b"\x05\x01\x00" + (b"\x01" if ip.version == 4 else b"\x04") + ip.packed + port.to_bytes(2, "big"))
        version, code, _, kind = receive_exact(sock, 4)
        if version != 5:
            raise UpstreamFailure(f"the proxy {self.label} is not a SOCKS5 proxy")
        if code != 0:
            reason = SOCKS5_ERRORS.get(code, f"error {code}")
            raise UpstreamFailure(f"the proxy {self.label} could not connect to {address}: {reason}", retry=code not in SOCKS5_FINAL)
        # The proxy's bound address comes before the tunnel's first byte.
        size = {1: 4, 4: 16}.get(kind)
        receive_exact(sock, (size if size is not None else receive_exact(sock, 1)[0]) + 2)

    def socks5_login(self, sock):
        user, password = self.user.encode(), self.password.encode()
        sock.sendall(b"\x01" + bytes([len(user)]) + user + bytes([len(password)]) + password)
        if receive_exact(sock, 2)[1] != 0:
            raise self.refused_login()

    def socks4(self, sock, address, port):
        ip = ipaddress.ip_address(address)
        if ip.version != 4:
            raise UpstreamFailure(f"the SOCKS4 proxy {self.label} cannot reach the IPv6 address {address}", retry=True)
        sock.sendall(b"\x04\x01" + port.to_bytes(2, "big") + ip.packed + (self.user or "").encode() + b"\x00")
        code = receive_exact(sock, 8)[1]
        if code != 0x5A:
            # 0x5B is "rejected or failed"; 0x5C and 0x5D are identd failures that another address would repeat.
            raise UpstreamFailure(f"the proxy {self.label} refused the connection to {address} (code {code})", retry=code == 0x5B)


class Routes:
    """Which of the user's proxies, if any, carries a checked request. linkContext.proxy wins over the variables."""

    def __init__(self, explicit=None, environment=None):
        self.explicit = Upstream(explicit, "linkContext.proxy") if explicit else None
        environment = {} if explicit else (environment or {})
        self.variables = {kind: Upstream(url, f"the {kind.upper()}_PROXY variable")
                          for kind, url in environment.items() if kind in ("http", "https", "all") and url}
        self.no_proxy = environment.get("no", "")

    def pick(self, host, port, tunnel):
        if self.explicit:
            return self.explicit
        upstream = self.variables.get("https" if tunnel else "http") or self.variables.get("all")
        if upstream and self.bypass(host, port):
            # A NO_PROXY host goes direct, as with any client of these variables; the guard has still checked it.
            return None
        return upstream

    def bypass(self, host, port):
        if not self.no_proxy:
            return False
        no = {"no": self.no_proxy}
        return proxy_bypass_environment(f"{bracketed(host)}:{port}", no) or proxy_bypass_environment(host, no)


def user_routes(explicit):
    """The user's proxies. Read them before take_over_environment replaces the variables with the guard."""
    return Routes(explicit, getproxies_environment())


def absolute_target(url, address, port):
    """The request-target for an HTTP proxy: the checked address, so the proxy does no lookup of its own."""
    return f"http://{bracketed(address)}:{port}{origin_path(url)}"


class Handler(socketserver.BaseRequestHandler):
    def reply(self, status, text):
        body = f"{text}\n".encode()
        self.request.sendall(b"HTTP/1.1 %s\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" % (status.encode(), len(body), body))

    def handle(self):
        self.request.settimeout(HEAD_TIMEOUT)
        try:
            head = read_head(self.request)
        except OSError:
            return
        if not head:
            return
        # The head timeout is for an idle client only; a slow reader of a long body must not be cut.
        self.request.settimeout(None)
        line, *headers = head[:-4].split("\r\n")
        parts = line.split(" ")
        if len(parts) != 3:
            return self.reply("400 Bad Request", "pull_link's proxy could not read the request")
        method, target, version = parts
        if method != "CONNECT" and not target.lower().startswith("http://"):
            # urllib sends ftp:// through an HTTP proxy too; only plain http is forwarded here.
            return self.reply("403 Forbidden", f"pull_link's proxy forwards only http, not {target.split(':', 1)[0][:20]}")
        try:
            url = None if method == "CONNECT" else urlsplit(target)
            host, port = split_target(target, 443) if url is None else (url.hostname or "", url.port or 80)
        except ValueError:
            return self.reply("403 Forbidden", f"pull_link refused a private or local address: {target[:200]}")
        try:
            addresses = self.server.guard.resolve(host, port)
        except Unresolved:
            return self.reply("502 Bad Gateway", f"pull_link's proxy could not resolve {host}")
        if not addresses:
            return self.reply("403 Forbidden", f"pull_link refused a private or local address: {host}")
        via = self.server.routes.pick(host, port, tunnel=url is None)
        try:
            upstream, target = self.open(via, addresses, port, url)
        except UpstreamFailure as error:
            return self.reply("502 Bad Gateway", f"pull_link's proxy could not reach {host}: {error}")
        except OSError as error:
            return self.reply("502 Bad Gateway", f"pull_link's proxy could not connect to {host}: {error}")
        with upstream:
            try:
                if url is None:
                    self.tunnel(upstream)
                else:
                    self.forward(upstream, method, url, version, headers, via if target else None, target)
            except OSError:
                # A peer that closed or stalled ends this request; the client sees the connection close.
                return

    def open(self, via, addresses, port, url):
        """A socket that reaches the checked target, direct or through the user's proxy, and the absolute-form target if it needs one."""
        if via is None:
            return connect_any(addresses, port), None
        ordered = ipv4_first(addresses)
        if url is not None and via.absolute:
            # One absolute-form request; an error answer from the proxy cannot be told apart from the origin's, so there is no next try.
            return via.connect(), absolute_target(url, ordered[0], port)
        return via.open(ordered, port), None

    def tunnel(self, upstream):
        upstream.settimeout(None)
        self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        copy([self.request, upstream], {self.request: upstream, upstream: self.request})

    def forward(self, upstream, method, url, version, headers, via=None, target=None):
        """One request: its head and Content-Length body go up, then only the response comes back.

        A client that reuses its proxy connection for another host must come back
        through the check, so nothing after the body goes to this upstream. via and
        target: the user's HTTP proxy, which gets the request in absolute form.
        """
        if header(headers, "transfer-encoding"):
            return self.reply("411 Length Required", "pull_link's proxy needs a Content-Length for a request body")
        length = body_length(headers)
        if length is None:
            return self.reply("400 Bad Request", "pull_link's proxy could not read the Content-Length")
        if (header(headers, "expect") or "").lower() == "100-continue":
            self.request.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
        upstream.sendall(forwarded(method, url, version, headers, target, via.authorization() if via else ()))
        while length > 0:
            data = self.request.recv(min(BUFFER, length))
            if not data:
                return
            upstream.sendall(data)
            length -= len(data)
        upstream.settimeout(IDLE_TIMEOUT)
        response = read_head(upstream)
        if not response:
            return
        if via and response.split(" ", 2)[1:2] == ["407"]:
            return self.reply("502 Bad Gateway", f"pull_link's proxy could not reach {url.hostname}: {via.refused_login()}")
        self.request.sendall(closing(response))
        upstream.settimeout(None)
        # The client is watched too: when it closes, a keep-alive upstream no longer holds this thread.
        copy([upstream, self.request], {upstream: self.request, self.request: None})


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    # yt-dlp and ffmpeg open many connections at once for fragments.
    request_queue_size = 128


def start(allow=(), routes=None):
    """Starts the proxy on a free loopback port; returns its URL. It lives as long as the process."""
    server = Server(("127.0.0.1", 0), Handler)
    server.guard = Guard(allow)
    server.routes = routes or Routes()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")


def take_over_environment(proxy):
    """libcurl and ffmpeg read the proxy variables themselves; NO_PROXY would let a host skip the guard."""
    for name in PROXY_VARIABLES:
        os.environ.pop(name, None)
    os.environ["http_proxy"] = proxy
    os.environ["https_proxy"] = proxy

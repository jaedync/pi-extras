"""A loopback proxy that refuses private, loopback, link-local and metadata addresses.

yt-dlp follows redirects inside each HTTP library (urllib, requests, and
libcurl through curl_cffi, which Python's socket module never sees), and
ffmpeg makes its own HTTP requests when it cuts clips. All of them send every
HTTP request through yt-dlp's `proxy` setting, so a proxy is the one place
that sees each hop: a redirect, a manifest, a fragment. The proxy resolves the
name itself and connects only to addresses it checked, so a DNS answer that
changes between the check and the connection cannot get past it.

Stdlib only. Loaded by helper.py from this folder.
"""
import ipaddress
import os
import selectors
import socket
import socketserver
import threading
from urllib.parse import urlsplit

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


def copy(sockets, pairs):
    """Copies bytes from each source to its target until a source closes, a socket fails or nothing moves."""
    selector = selectors.DefaultSelector()
    try:
        for source in sockets:
            selector.register(source, selectors.EVENT_READ)
        while True:
            events = selector.select(IDLE_TIMEOUT)
            if not events:
                return
            for key, _ in events:
                data = key.fileobj.recv(BUFFER)
                if not data:
                    return
                pairs[key.fileobj].sendall(data)
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


HOP_HEADERS = ("connection:", "keep-alive:", "proxy-", "transfer-encoding:", "te:", "upgrade:", "expect:")


def forwarded(method, url, version, headers):
    """The request for the origin: its own path, no hop-by-hop or proxy headers, and Connection: close."""
    path = url.path or "/"
    if url.query:
        path += "?" + url.query
    keep = [h for h in headers if h and not h.lower().startswith(HOP_HEADERS)]
    return ("\r\n".join([f"{method} {path} {version}", *keep, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


def closing(head):
    """A response head that tells the client to open a new connection for its next request."""
    status, *headers = head[:-4].split("\r\n")
    keep = [h for h in headers if not h.lower().startswith(("connection:", "keep-alive:", "proxy-connection:"))]
    return ("\r\n".join([status, *keep, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


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
        line, *headers = head[:-4].split("\r\n")
        parts = line.split(" ")
        if len(parts) != 3:
            return self.reply("400 Bad Request", "pull_link's proxy could not read the request")
        method, target, version = parts
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
        try:
            upstream = connect_any(addresses, port)
        except OSError as error:
            return self.reply("502 Bad Gateway", f"pull_link's proxy could not connect to {host}: {error}")
        with upstream:
            if url is None:
                self.tunnel(upstream)
            else:
                self.forward(upstream, method, url, version, headers)

    def tunnel(self, upstream):
        self.request.settimeout(None)
        upstream.settimeout(None)
        self.request.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        copy([self.request, upstream], {self.request: upstream, upstream: self.request})

    def forward(self, upstream, method, url, version, headers):
        """One request: its head and Content-Length body go up, then only the response comes back.

        A client that reuses its proxy connection for another host must come back
        through the check, so nothing after the body goes to this upstream.
        """
        if header(headers, "transfer-encoding"):
            return self.reply("411 Length Required", "pull_link's proxy needs a Content-Length for a request body")
        try:
            length = int(header(headers, "content-length") or 0)
        except ValueError:
            return self.reply("400 Bad Request", "pull_link's proxy could not read the Content-Length")
        if (header(headers, "expect") or "").lower() == "100-continue":
            self.request.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
        upstream.sendall(forwarded(method, url, version, headers))
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
        self.request.sendall(closing(response))
        copy([upstream], {upstream: self.request})


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    # yt-dlp and ffmpeg open many connections at once for fragments.
    request_queue_size = 128


def start(allow=()):
    """Starts the proxy on a free loopback port; returns its URL. It lives as long as the process."""
    server = Server(("127.0.0.1", 0), Handler)
    server.guard = Guard(allow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy")


def take_over_environment(proxy):
    """libcurl and ffmpeg read the proxy variables themselves; NO_PROXY would let a host skip the guard."""
    for name in PROXY_VARIABLES:
        os.environ.pop(name, None)
    os.environ["http_proxy"] = proxy
    os.environ["https_proxy"] = proxy

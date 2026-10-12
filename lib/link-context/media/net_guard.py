"""A loopback proxy that refuses private, loopback, link-local and metadata addresses.

yt-dlp follows redirects inside each HTTP library (urllib, requests, and
libcurl through curl_cffi, which Python's socket module never sees), and
ffmpeg makes its own requests when it cuts clips. All of them send every
request through yt-dlp's `proxy` setting, so a proxy is the one place that
sees each hop: a redirect, a manifest, a fragment. The proxy resolves the
name itself and connects to the address it checked, so a DNS answer that
changes between the check and the connection cannot get past it.

Stdlib only. Loaded by helper.py from this folder.
"""
import ipaddress
import os
import select
import socket
import socketserver
import threading
from urllib.parse import urlsplit

MAX_HEADER_BYTES = 64 * 1024
CONNECT_TIMEOUT = 30
BUFFER = 64 * 1024

# Addresses that carry an IPv4 address or route to one, as in url.ts isPrivateHost.
EMBEDDING_V4 = [ipaddress.ip_network(net) for net in ("64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32")]

# Names whose resolution was refused, so the caller can say why a request failed.
REFUSED = []


def private_address(text):
    """True for any address that is not plainly public."""
    ip = ipaddress.ip_address(text.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.version == 6 and (ip.is_site_local or any(ip in net for net in EMBEDDING_V4)):
        return True
    return not ip.is_global or ip.is_multicast or ip.is_reserved or ip.is_unspecified


def refused(address):
    try:
        return private_address(address)
    except ValueError:
        return True


class Guard:
    def __init__(self, allow=()):
        # Exact host:port pairs that skip the check; only the tests set them.
        self.allow = frozenset(allow)

    def resolve(self, host, port):
        """The checked address to connect to, or None when the host is refused."""
        try:
            infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError:
            return None
        addresses = [info[4][0] for info in infos]
        if f"{host}:{port}" not in self.allow and (not addresses or any(refused(a) for a in addresses)):
            REFUSED.append(host)
            return None
        return addresses[0] if addresses else None


def pipe(a, b):
    """Copies bytes both ways until one side closes or resets; a reset is a normal end here."""
    sockets = [a, b]
    try:
        while True:
            ready, _, broken = select.select(sockets, [], sockets, 300)
            if broken or not ready:
                return
            for source in ready:
                data = source.recv(BUFFER)
                if not data:
                    return
                (b if source is a else a).sendall(data)
    except OSError:
        return


def split_target(target, default_port):
    """host:port or [v6]:port from a CONNECT line."""
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        return host, int(rest.lstrip(":") or default_port)
    host, _, port = target.partition(":")
    return host, int(port or default_port)


class Handler(socketserver.StreamRequestHandler):
    # Unbuffered, so no byte after the headers is held back from the tunnel.
    rbufsize = 0

    def read_head(self):
        head = b""
        while not head.endswith(b"\r\n\r\n"):
            byte = self.rfile.read(1)
            if not byte or len(head) > MAX_HEADER_BYTES:
                return None
            head += byte
        return head.decode("latin-1")

    def refuse(self, host):
        body = f"pull_link refused a private or local address: {host}\n".encode()
        self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))

    def handle(self):
        head = self.read_head()
        if not head:
            return
        line, *headers = head.split("\r\n")
        parts = line.split(" ")
        if len(parts) != 3:
            return
        method, target, version = parts
        try:
            if method == "CONNECT":
                host, port = split_target(target, 443)
            else:
                url = urlsplit(target)
                host, port = url.hostname or "", url.port or 80
        except ValueError:
            return self.refuse(target[:200])
        address = self.server.guard.resolve(host, port)
        if not address:
            return self.refuse(host)
        try:
            upstream = socket.create_connection((address, port), timeout=CONNECT_TIMEOUT)
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            return
        upstream.settimeout(None)
        with upstream:
            if method == "CONNECT":
                self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            else:
                upstream.sendall(forwarded(method, url, version, headers))
            pipe(self.connection, upstream)


def forwarded(method, url, version, headers):
    """The request for the origin: its own path, no proxy headers, and one request per connection,
    so a client that reuses the connection for another host comes back through the check."""
    path = url.path or "/"
    if url.query:
        path += "?" + url.query
    keep = [h for h in headers if h and not h.lower().startswith(("proxy-", "connection:", "keep-alive:"))]
    return ("\r\n".join([f"{method} {path} {version}", *keep, "Connection: close"]) + "\r\n\r\n").encode("latin-1")


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


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

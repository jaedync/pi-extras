"""VPN-independent guest transport. Stdlib only. AF_HYPERV needs Python 3.12+ (the
server's uv Python); the TCP test mode also runs on 3.8, which the tests use."""
import argparse
import hashlib
import hmac
import json
import os
import re
import select
import socket
import subprocess
import sys
import threading
import time

DATA_SERVICE = "951d64b0-077c-49a9-b668-4ef3f202debf"
CONTROL_SERVICE = "3d0558c2-329e-47c2-8e62-1423eb99519e"
RELAY_VERSION = 1
MAX_CONNECTIONS = 64
MAX_LINE = 4096
BUFFER_SIZE = 65536
MAX_LOG_SIZE = 1024 * 1024
WILDCARD = "00000000-0000-0000-0000-000000000000"
WTS_CONNECT_STATE = 8
# The host compares it with the script it ships, and replaces an outdated relay.
with open(os.path.abspath(__file__), "rb") as _source:
    SCRIPT = hashlib.sha256(_source.read()).hexdigest().upper()
WIN_BUILTIN_ADMINISTRATORS_SID = 26
SECURITY_MAX_SID_SIZE = 68


class Log:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()

    def __call__(self, message):
        # pythonw has no usable stderr; logging must remain optional during repair.
        try:
            with self.lock:
                if os.path.exists(self.path) and os.path.getsize(self.path) > MAX_LOG_SIZE:
                    os.replace(self.path, self.path + ".1")
                with open(self.path, "a", encoding="utf-8") as stream:
                    stream.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")
        except Exception:
            pass


class Config:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.stamp = None
        self.value = None

    def get(self):
        # Readers share a single snapshot so a rotation cannot mix the port and key.
        with self.lock:
            try:
                stat = os.stat(self.path)
                stamp = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
                if stamp == self.stamp:
                    return self.value
                self.stamp, self.value = stamp, None
                with open(self.path, "r", encoding="utf-8") as stream:
                    text = stream.read(BUFFER_SIZE + 1)
                if len(text) > BUFFER_SIZE:
                    return None
                sections = re.findall(r"^\[server\][ \t]*\r?\n([^\[]*)", text, re.M)
                if len(sections) != 1:
                    return None
                ports = re.findall(r"^port[ \t]*=[ \t]*(\d+)[ \t]*\r?$", sections[0], re.M)
                keys = re.findall(r'^auth_key[ \t]*=[ \t]*"([0-9a-fA-F]{64})"[ \t]*\r?$', sections[0], re.M)
                fields = re.findall(r"^(port|auth_key)[ \t]*=", sections[0], re.M)
                if fields.count("port") == fields.count("auth_key") == 1 and len(ports) == len(keys) == 1 and 0 < int(ports[0]) <= 65535:
                    self.value = (int(ports[0]), keys[0])
            except (OSError, UnicodeError, ValueError):
                self.stamp, self.value = None, None
            return self.value


def reply(connection, value):
    connection.sendall((json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8"))


def failure(error):
    return {"ok": False, "error": error}


def pump(host, upstream):
    peers = (host, upstream)
    pending = [bytearray(), bytearray()]
    reading = [True, True]
    writing = [True, True]
    for peer in peers:
        peer.setblocking(False)
    # Bounded queues plus writable readiness avoid duplex sendall deadlocks.
    while any(reading) or any(pending):
        readers = [peers[i] for i in range(2) if reading[i] and len(pending[1 - i]) < BUFFER_SIZE]
        writers = [peers[i] for i in range(2) if pending[i]]
        ready_read, ready_write, _ = select.select(readers, writers, [])
        for peer in ready_write:
            i = peers.index(peer)
            try:
                count = peer.send(pending[i])
            except BlockingIOError:
                continue
            if count == 0:
                raise ConnectionError("zero-length write")
            del pending[i][:count]
        for peer in ready_read:
            i = peers.index(peer)
            try:
                data = peer.recv(BUFFER_SIZE - len(pending[1 - i]))
            except BlockingIOError:
                continue
            if data:
                pending[1 - i].extend(data)
            else:
                reading[i] = False
        for i in range(2):
            if writing[i] and not reading[1 - i] and not pending[i]:
                # Delayed replies remain readable after the request direction ends.
                peers[i].shutdown(socket.SHUT_WR)
                writing[i] = False


def windows_session():
    import ctypes as c
    from ctypes import wintypes as w

    kernel = c.WinDLL("kernel32", use_last_error=True)
    wts = c.WinDLL("wtsapi32", use_last_error=True)
    advapi = c.WinDLL("advapi32", use_last_error=True)

    class ProcessInfo(c.Structure):
        _fields_ = [("SessionId", w.DWORD), ("ProcessId", w.DWORD), ("pProcessName", w.LPWSTR), ("pUserSid", c.c_void_p)]

    def bind(library, name, args, result):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result
        return function

    def checked(result, name):
        if not result:
            raise RuntimeError("%s (Windows error %d)" % (name, c.get_last_error()))
        return result

    current_pid = bind(kernel, "GetCurrentProcessId", [], w.DWORD)
    process_session = bind(kernel, "ProcessIdToSessionId", [w.DWORD, c.POINTER(w.DWORD)], w.BOOL)
    console_session = bind(kernel, "WTSGetActiveConsoleSessionId", [], w.DWORD)
    query = bind(wts, "WTSQuerySessionInformationW", [w.HANDLE, w.DWORD, c.c_int, c.POINTER(c.c_void_p), c.POINTER(w.DWORD)], w.BOOL)
    free = bind(wts, "WTSFreeMemory", [c.c_void_p], None)
    processes = bind(wts, "WTSEnumerateProcessesW", [w.HANDLE, w.DWORD, w.DWORD, c.POINTER(c.POINTER(ProcessInfo)), c.POINTER(w.DWORD)], w.BOOL)
    create_sid = bind(advapi, "CreateWellKnownSid", [c.c_int, c.c_void_p, c.c_void_p, c.POINTER(w.DWORD)], w.BOOL)
    membership = bind(advapi, "CheckTokenMembership", [w.HANDLE, c.c_void_p, c.POINTER(w.BOOL)], w.BOOL)

    def session_id(pid):
        result = w.DWORD()
        checked(process_session(pid, c.byref(result)), "ProcessIdToSessionId")
        return result.value

    def state(session):
        buffer, size = c.c_void_p(), w.DWORD()
        try:
            checked(query(None, session, WTS_CONNECT_STATE, c.byref(buffer), c.byref(size)), "WTSQuerySessionInformationW")
            if not buffer.value or size.value < 4:
                raise RuntimeError("WTSConnectState buffer missing")
            return c.cast(buffer, c.POINTER(c.c_int32)).contents.value
        finally:
            if buffer.value:
                free(buffer)

    def locked(session):
        # WTS reports each process's session without opening it. ProcessIdToSessionId
        # needs PROCESS_QUERY_INFORMATION, which a standard user lacks on SYSTEM's
        # LogonUI: live, it failed with error 5 on winlogon, lsass and csrss.
        info, count = c.POINTER(ProcessInfo)(), w.DWORD()
        checked(processes(None, 0, 1, c.byref(info), c.byref(count)), "WTSEnumerateProcessesW")
        try:
            return any(info[i].SessionId == session and (info[i].pProcessName or "").casefold() == "logonui.exe"
                       for i in range(count.value))
        finally:
            free(info)

    sid, sid_size, elevated = c.create_string_buffer(SECURITY_MAX_SID_SIZE), w.DWORD(SECURITY_MAX_SID_SIZE), w.BOOL()
    # A NULL token checks the current effective token, including UAC filtering.
    checked(create_sid(WIN_BUILTIN_ADMINISTRATORS_SID, None, sid, c.byref(sid_size)), "CreateWellKnownSid")
    checked(membership(None, sid, c.byref(elevated)), "CheckTokenMembership")
    own = session_id(current_pid())
    return {"id": own, "console": console_session(), "state": state(own),
            "locked": locked(own), "elevated": bool(elevated.value)}


def restart(args):
    if args.tcp_test:
        if not args.test_restart_log:
            return failure("restart unavailable")
        with open(args.test_restart_log, "a", encoding="utf-8") as stream:
            stream.write("restart\n")
        return {"ok": True, "steps": []}
    if os.name != "nt":
        return failure("restart unavailable")
    commands = [("end", ["schtasks", "/end", "/tn", "windows-mcp-server"]),
                ("kill", ["taskkill", "/f", "/t", "/im", "windows-mcp.exe"]),
                ("run", ["schtasks", "/run", "/tn", "windows-mcp-server"])]
    steps = []
    for step, command in commands:
        if step == "run":
            time.sleep(3)
        result = subprocess.run(command, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        steps.append({"step": step, "code": result.returncode})
    return {"ok": True, "steps": steps}


def request(connection):
    deadline = time.monotonic() + 10
    data = bytearray()
    while b"\n" not in data and len(data) < MAX_LINE:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("request deadline exceeded")
        connection.settimeout(remaining)
        chunk = connection.recv(MAX_LINE - len(data))
        if not chunk:
            break
        data.extend(chunk)
    line, separator, _ = bytes(data).partition(b"\n")
    if not separator:
        raise ValueError("missing or oversized line")
    value = json.loads(line.decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("op"), str):
        raise ValueError("bad request shape")
    return value


class Relay:
    def __init__(self, args, log):
        self.args, self.log = args, log
        self.config = Config(args.config)
        self.started = time.monotonic()
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def data(self, connection):
        config = self.config.get()
        if config is None:
            connection.sendall(b"\x00relay config unreadable")
            return
        port, _ = config
        try:
            upstream = socket.create_connection(("127.0.0.1", port), timeout=5)
        except OSError as error:
            reason = "%s, connection error %s" % (type(error).__name__, error.errno)
            message = "Windows-MCP is not listening on 127.0.0.1:%d (%s)" % (port, reason)
            self.log(message)
            connection.sendall(b"\x00" + message.encode("utf-8"))
            return
        with upstream:
            upstream.settimeout(None)
            # This is the retry boundary: no host read occurs until success is sent.
            connection.sendall(b"\x01")
            pump(connection, upstream)

    def control(self, connection):
        config = self.config.get()
        if config is None:
            reply(connection, failure("relay config unreadable"))
            return
        try:
            value = request(connection)
        except (ValueError, UnicodeError, OSError, RecursionError):
            reply(connection, failure("bad request"))
            return
        key = value.get("key")
        try:
            authorized = isinstance(key, str) and hmac.compare_digest(key.encode("utf-8"), config[1].encode("ascii"))
        except UnicodeError:
            authorized = False
        if not authorized:
            reply(connection, failure("unauthorized"))
            return
        op = value["op"]
        if op == "ping":
            listening = False
            try:
                # A busy server can take over a second to accept; don't report it down.
                with socket.create_connection(("127.0.0.1", config[0]), timeout=3):
                    listening = True
            except OSError:
                pass
            result = {"ok": True, "relay": RELAY_VERSION, "pid": os.getpid(),
                      "listening": listening, "uptime": time.monotonic() - self.started, "script": SCRIPT}
        elif op == "session":
            result = self.session()
        elif op == "restart":
            try:
                result = restart(self.args)
            except Exception as error:
                self.log("restart failed: " + type(error).__name__)
                result = failure("restart failed: " + type(error).__name__)
        else:
            result = failure("unknown op")
        reply(connection, result)

    def session(self):
        if os.name != "nt":
            return failure("session query needs Windows")
        try:
            return {"ok": True, "session": windows_session()}
        except Exception as error:
            self.log("session query failed: " + type(error).__name__)
            detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            return failure("session query failed: " + detail)

    def serve(self, connection, control):
        try:
            with connection:
                if control:
                    self.control(connection)
                else:
                    self.data(connection)
        except OSError as error:
            self.log("connection closed: %s (error %s)" % (type(error).__name__, error.errno))
        except Exception as error:
            # Exception messages can contain input. Types are safe diagnostic context.
            self.log("unexpected connection exception: " + type(error).__name__)
        finally:
            self.slots.release()

    def accept(self, listener, control):
        errors = 0
        while True:
            try:
                connection, _ = listener.accept()
                errors = 0
            except OSError as error:
                errors += 1
                self.log("accept failed: error %s (%d consecutive)" % (error.errno, errors))
                if errors >= 50:
                    os._exit(4)
                time.sleep(0.5)
                continue
            if not self.slots.acquire(blocking=False):
                try:
                    with connection:
                        connection.settimeout(1)
                        if control:
                            reply(connection, failure("relay busy"))
                        else:
                            connection.sendall(b"\x00relay busy")
                except OSError:
                    pass
                continue
            try:
                threading.Thread(target=self.serve, args=(connection, control), daemon=True).start()
            except Exception as error:
                connection.close()
                self.slots.release()
                self.log("worker start failed: " + type(error).__name__)


def listeners(tcp, log):
    result = []
    if not tcp and not hasattr(socket, "AF_HYPERV"):
        log("AF_HYPERV unavailable; run this relay inside a Windows guest")
        return None, 2
    try:
        for service in (DATA_SERVICE, CONTROL_SERVICE):
            if tcp:
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                address = ("127.0.0.1", 0)
            else:
                listener = socket.socket(socket.AF_HYPERV, socket.SOCK_STREAM, socket.HV_PROTOCOL_RAW)
                address = (getattr(socket, "HV_GUID_WILDCARD", WILDCARD), service)
            result.append(listener)
            listener.bind(address)
            listener.listen(MAX_CONNECTIONS)
        return result, 0
    except Exception as error:
        log("bind failed: %s (error %s)" % (type(error).__name__, getattr(error, "errno", None)))
        for listener in result:
            listener.close()
        return None, 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--log")
    parser.add_argument("--tcp-test", action="store_true")
    parser.add_argument("--test-restart-log")
    args = parser.parse_args()
    log = Log(args.log or os.path.join(os.path.dirname(os.path.abspath(args.config)), "relay.log"))
    bound, code = listeners(args.tcp_test, log)
    if bound is None:
        return code
    log("relay version %d started, pid %d" % (RELAY_VERSION, os.getpid()))
    relay = Relay(args, log)
    if args.tcp_test:
        print(json.dumps({"data": bound[0].getsockname()[1], "control": bound[1].getsockname()[1]}), flush=True)
    threads = [threading.Thread(target=relay.accept, args=(listener, bool(i)), daemon=True)
               for i, listener in enumerate(bound)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())

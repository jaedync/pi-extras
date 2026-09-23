"""Pi voice daemon: one per user, shared by every Pi session.

Pi sessions stream 16 kHz mono PCM over a private Unix socket. Silero VAD
splits speech at pauses and each finished segment is transcribed on a worker
thread while the user keeps talking. The model loads on first use and stays
resident while any Pi session holds a lease; the daemon exits once none remain.

Protocol: one JSON object per line. See lib/voice/protocol.ts.
"""

from __future__ import annotations

import argparse
import base64
import errno
import fcntl
import glob
import importlib
import json
import math
import os
import queue
import selectors
import signal
import socket
import sys
import threading
import time
from array import array

SAMPLE_RATE = 16000
VAD_WINDOW = 512
MAX_SEGMENT_S = 12.0  # keep in sync with MAX_CHUNK_MS in indicator.ts
MIN_SILENCE_S = 0.4
# Pause kept before detected speech, so a soft first word the VAD scored as silence still reaches the model.
MAX_LEAD_S = 1.0
# How far Silero may place a segment's start before it reports speech (min speech 0.25s plus two windows), with margin.
VAD_LOOKBACK_S = 0.5
# Step when looking for the quietest point of a pause to cut at.
CUT_WINDOW = 256
MAX_LINE_BYTES = 1024 * 1024
LEASE_POLL_S = 2.0
IDLE_EXIT_S = 10.0
# A forgotten Pi session must not pin the model in memory; the next dictation restarts the daemon and buffers meanwhile.
UNUSED_EXIT_S = 15 * 60.0
TIER_ORDER = ["mlx", "cpu-large", "cpu-small"]
# What to show for each tier: the compute backend and the model it loads.
TIER_LABELS = {
    "mlx": ("mlx", "parakeet 0.6b-v3"),
    "cpu-large": ("cpu", "parakeet 0.6b-v3"),
    "cpu-small": ("cpu", "parakeet 110m"),
}
# After a tier fails to load, wait this long before trying it again, so a broken
# tier cannot hot-loop while a working one is serving dictation.
TIER_RETRY_S = 60.0


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}", file=sys.stderr, flush=True)


def pcm_to_float(data: bytes):
    samples = array("h")
    samples.frombytes(data[: len(data) - len(data) % 2])
    if sys.byteorder != "little":
        samples.byteswap()
    try:
        import numpy as np

        return np.frombuffer(samples.tobytes(), dtype=np.int16).astype(np.float32) / 32768.0
    except ImportError:
        return array("f", (s / 32768.0 for s in samples))


def concat(a, b):
    if hasattr(a, "dtype"):
        import numpy as np

        return np.concatenate([a, b])
    return a + b


def rms(window) -> float:
    if not len(window):
        return 0.0
    if hasattr(window, "dtype"):
        import numpy as np

        return float(np.sqrt(np.mean(np.square(window))))
    return math.sqrt(sum(x * x for x in window) / len(window))


# ---------------------------------------------------------------- VAD


class EnergyVad:
    """Stdlib stand-in for Silero, used by --fake so tests need no models."""

    def __init__(self) -> None:
        self.segments: list[tuple[int, int]] = []
        self.pos = 0
        self.start: int | None = None
        self.end = 0
        self.silence = 0

    def accept_waveform(self, window) -> None:
        at = self.pos
        self.pos += len(window)
        if rms(window) > 0.02:
            if self.start is None:
                self.start = at
            self.end = self.pos
            self.silence = 0
            if self.end - self.start >= MAX_SEGMENT_S * SAMPLE_RATE:
                self._close()
        elif self.start is not None:
            self.silence += len(window)
            if self.silence >= MIN_SILENCE_S * SAMPLE_RATE:
                self._close()

    def _close(self) -> None:
        self.segments.append((self.start, self.end))
        self.start = None
        self.silence = 0

    def is_speech_detected(self) -> bool:
        return self.start is not None

    def empty(self) -> bool:
        return not self.segments

    def pop_span(self) -> tuple[int, int]:
        return self.segments.pop(0)

    def flush(self) -> None:
        if self.start is not None:
            self._close()


class SileroVad:
    def __init__(self, model_path: str) -> None:
        import sherpa_onnx as so

        config = so.VadModelConfig()
        config.silero_vad.model = model_path
        config.silero_vad.min_silence_duration = MIN_SILENCE_S
        config.silero_vad.max_speech_duration = MAX_SEGMENT_S
        config.silero_vad.window_size = VAD_WINDOW
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        self.vad = so.VoiceActivityDetector(config, buffer_size_in_seconds=120)

    def accept_waveform(self, window) -> None:
        self.vad.accept_waveform(window)

    def is_speech_detected(self) -> bool:
        return self.vad.is_speech_detected()

    def empty(self) -> bool:
        return self.vad.empty()

    def pop_span(self) -> tuple[int, int]:
        front = self.vad.front
        span = (front.start, front.start + len(front.samples))
        self.vad.pop()
        return span

    def flush(self) -> None:
        self.vad.flush()


class Chunker:
    """Cuts a recording into chunks at pauses without dropping any audio.

    The VAD only says where speech is. Decoding just its speech spans loses
    words it scores as silence, like a soft "the" after a pause, so each chunk
    runs from the previous cut to the quietest point of the next pause. Only
    long pauses are shortened, to MAX_LEAD_S before the next speech.
    """

    def __init__(self, vad) -> None:
        self.vad = vad
        self.audio = None  # samples since the last cut
        self.cut = 0  # sample index of audio[0] in the recording
        self.fed = 0

    @property
    def speaking(self) -> bool:
        return bool(self.vad.is_speech_detected())

    def accept(self, samples) -> None:
        """Feed whole VAD windows."""
        self.audio = concat(self.audio, samples) if self.audio is not None else samples
        self.fed += len(samples)
        for start in range(0, len(samples), VAD_WINDOW):
            self.vad.accept_waveform(samples[start : start + VAD_WINDOW])
        if not self.speaking and self.vad.empty():
            # No later chunk can start this far back, so long pauses are not held in memory.
            self._drop_before(self.fed - int((MAX_LEAD_S + VAD_LOOKBACK_S) * SAMPLE_RATE))

    def take(self, final: bool) -> list:
        """Chunks ready to decode. With final, the last one runs to the end and a speechless rest is dropped."""
        spans = []
        while not self.vad.empty():
            spans.append(self.vad.pop_span())
        chunks = []
        for i, (start, end) in enumerate(spans):
            if final and i == len(spans) - 1:
                cut = self.fed
            else:
                limit = spans[i + 1][0] if i + 1 < len(spans) else self.fed
                cut = self._quietest(end, limit)
            self._drop_before(start - int(MAX_LEAD_S * SAMPLE_RATE))
            if cut > self.cut:
                chunks.append(self.audio[: cut - self.cut])
                self._drop_before(cut)
        if final:
            self._drop_before(self.fed)
            self.audio = None
        return chunks

    def _quietest(self, lo: int, hi: int) -> int:
        lo = max(lo, self.cut)
        hi = min(hi, self.fed)
        best, best_rms = lo, None
        # Earliest of equally quiet points, so a soft word late in the pause goes with the speech after it.
        for at in range(lo, hi - CUT_WINDOW + 1, CUT_WINDOW):
            level = rms(self.audio[at - self.cut : at - self.cut + CUT_WINDOW])
            if best_rms is None or level < best_rms:
                best, best_rms = at + CUT_WINDOW // 2, level
        return best

    def _drop_before(self, index: int) -> None:
        if index <= self.cut or self.audio is None:
            return
        index = min(index, self.fed)
        self.audio = self.audio[index - self.cut :]
        self.cut = index


# ---------------------------------------------------------------- ASR backends


class FakeAsr:
    label = "fake"

    def decode(self, samples) -> str:
        return f"<{len(samples) / SAMPLE_RATE:.1f}s>"


class SherpaAsr:
    def __init__(self, model_dir: str, threads: int, label: str) -> None:
        import numpy as np
        import sherpa_onnx as so

        self.np = np
        pick = lambda prefix: sorted(glob.glob(os.path.join(model_dir, f"{prefix}*.onnx")))[0]
        self.recognizer = so.OfflineRecognizer.from_transducer(
            encoder=pick("encoder"),
            decoder=pick("decoder"),
            joiner=pick("joiner"),
            tokens=os.path.join(model_dir, "tokens.txt"),
            num_threads=threads,
            provider="cpu",
            model_type="nemo_transducer",
        )
        self.label = label

    def decode(self, samples) -> str:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, self.np.asarray(samples, dtype=self.np.float32))
        self.recognizer.decode_stream(stream)
        return stream.result.text.strip()


class MlxAsr:
    label = "mlx"

    def __init__(self, model_dir: str) -> None:
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        self.mx = mx
        self.get_logmel = get_logmel
        self.model = from_pretrained(model_dir, dtype=mx.bfloat16)
        # The first decode compiles Metal kernels (~1s); pay that now, not on the user's first chunk.
        self.decode([0.0] * SAMPLE_RATE)

    def decode(self, samples) -> str:
        # get_logmel reinterprets the STFT output with the input dtype, so it must be float32.
        audio = self.mx.array(samples, dtype=self.mx.float32)
        mel = self.get_logmel(audio, self.model.preprocessor_config)
        return self.model.generate(mel)[0].text.strip()


# ---------------------------------------------------------------- tiers


def read_tiers(home: str) -> dict:
    try:
        with open(os.path.join(home, "tiers.json"), encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def ready_tiers(tiers: dict) -> list[str]:
    """Usable tiers, best first. A user-chosen tier wins while it stays ready."""
    ready = [name for name in TIER_ORDER if isinstance(tiers.get(name), dict) and tiers[name].get("ready")]
    preferred = tiers.get("preferred")
    if preferred in ready:
        return [preferred] + [name for name in ready if name != preferred]
    return ready


def load_tier(name: str, tiers: dict):
    spec = tiers[name]
    threads = int(tiers.get("threads", 4))
    if name == "mlx":
        return MlxAsr(spec["dir"])
    return SherpaAsr(spec["dir"], threads, name)


# ---------------------------------------------------------------- utterances


class Utterance:
    def __init__(self, conn: "Connection", uid: int, vad) -> None:
        self.conn = conn
        self.uid = uid
        self.chunker = Chunker(vad)
        self.carry = None
        self.next_index = 0
        self.pending = 0
        self.texts: dict[int, str] = {}
        self.speaking = False
        self.stopped = False
        self.cancelled = False


class Connection:
    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.inbuf = b""
        self.outbuf = b""
        self.discarding = False
        self.utterances: dict[int, Utterance] = {}

    def send(self, event: dict) -> None:
        self.outbuf += (json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8")


# ---------------------------------------------------------------- daemon


class Daemon:
    def __init__(self, home: str, fake: bool, idle_exit_s: float = IDLE_EXIT_S, unused_exit_s: float = UNUSED_EXIT_S, load_delay_s: float = 0.0) -> None:
        self.home = home
        self.fake = fake
        self.load_delay_s = load_delay_s
        self.idle_exit_s = idle_exit_s
        self.unused_exit_s = unused_exit_s
        self.selector = selectors.DefaultSelector()
        self.connections: dict[int, Connection] = {}
        self.jobs: "queue.Queue[tuple]" = queue.Queue()
        self.results: "queue.Queue[tuple]" = queue.Queue()
        self.asr = None
        self.asr_tier: str | None = None
        self.loading = False
        self.running = True
        self.last_alive = time.monotonic()
        self.last_used = self.last_alive
        self.failed_at: dict[str, float] = {}
        self.next_lease_check = 0.0
        self.vad_model = None if fake else read_tiers(home).get("vad")
        threading.Thread(target=self.worker, daemon=True).start()

    # ---- worker thread: model loading and decoding never block socket I/O

    def worker(self) -> None:
        # Decodes queued behind a load run the moment it finishes, before the main
        # thread has seen the result, so they must use the model loaded here.
        model = None
        while True:
            job = self.jobs.get()
            if job[0] == "load":
                asr, tier, error = self.load_best(job[1])
                if asr is not None:
                    model = asr
                self.results.put(("loaded", asr, tier, error))
            elif job[0] == "decode":
                _, utt, index, samples = job
                self.results.put(("decoding", utt, index, None))
                try:
                    text = model.decode(samples) if model else ""
                except Exception as exc:  # a bad segment must not kill the daemon
                    log(f"decode failed: {exc!r}")
                    text = ""
                self.results.put(("done", utt, index, text))

    def load_best(self, exclude_current: bool):
        time.sleep(self.load_delay_s)
        if self.fake:
            return FakeAsr(), "fake", None
        # Provisioning may have installed packages into this environment after we started.
        importlib.invalidate_caches()
        tiers = read_tiers(self.home)
        ready = ready_tiers(tiers)
        for name in ready:
            if exclude_current and name == self.asr_tier:
                return None, None, None
            if time.monotonic() - self.failed_at.get(name, 0.0) < TIER_RETRY_S:
                continue
            try:
                started = time.monotonic()
                asr = load_tier(name, tiers)
                log(f"loaded {name} in {time.monotonic() - started:.2f}s")
                return asr, name, None
            except Exception as exc:
                self.failed_at[name] = time.monotonic()
                log(f"tier {name} failed to load: {exc!r}")
        if ready:
            return None, None, f"could not load {', '.join(ready)}; see daemon.log"
        return None, None, "no speech model is ready yet"

    # ---- main thread

    def broadcast(self, event: dict) -> None:
        for conn in self.connections.values():
            conn.send(event)

    def status(self) -> dict:
        tier = self.asr_tier if self.asr is not None else (ready_tiers(read_tiers(self.home)) or [None])[0]
        backend, model = TIER_LABELS.get(tier, (tier or "", ""))
        # A model swap holds up decoding too, so the old model does not count as ready.
        ready = self.asr is not None and not self.loading
        return {"t": "status", "state": "ready" if ready else "loading", "backend": backend, "model": model}

    def ensure_loaded(self) -> None:
        if self.asr is None and not self.loading:
            self.loading = True
            self.jobs.put(("load", False))

    def maybe_upgrade(self) -> None:
        """Follow tiers.json: swap to the preferred (or best) tier while nothing is recording."""
        if self.loading or self.fake or any(c.utterances for c in self.connections.values()):
            return
        ready = ready_tiers(read_tiers(self.home))
        if ready and ready[0] != self.asr_tier:
            self.loading = True
            self.jobs.put(("load", True))

    def new_vad(self):
        return EnergyVad() if self.fake else SileroVad(self.vad_model)

    def handle(self, conn: Connection, msg: dict) -> None:
        kind = msg.get("t")
        uid = msg.get("id")
        if kind == "hello":
            conn.send(self.status())
        elif kind == "start" and isinstance(uid, int):
            conn.utterances[uid] = Utterance(conn, uid, self.new_vad())
            self.ensure_loaded()
            conn.send(self.status())
        elif kind == "audio" and isinstance(uid, int) and isinstance(msg.get("pcm"), str):
            utt = conn.utterances.get(uid)
            if utt and not utt.stopped:
                self.feed(utt, pcm_to_float(base64.b64decode(msg["pcm"], validate=False)))
        elif kind == "stop" and isinstance(uid, int):
            utt = conn.utterances.get(uid)
            if utt and not utt.stopped:
                utt.stopped = True
                if utt.carry is not None and len(utt.carry):
                    utt.chunker.accept(concat(utt.carry, pcm_to_float(bytes(2 * (VAD_WINDOW - len(utt.carry))))))
                utt.chunker.vad.flush()
                self.drain(utt, final=True)
                self.maybe_finish(utt)
        elif kind == "cancel" and isinstance(uid, int):
            utt = conn.utterances.pop(uid, None)
            if utt:
                utt.cancelled = True
        elif kind == "unload":
            log("unload requested")
            self.running = False

    def feed(self, utt: Utterance, samples) -> None:
        if utt.carry is not None:
            samples = concat(utt.carry, samples)
        usable = len(samples) - len(samples) % VAD_WINDOW
        if usable:
            utt.chunker.accept(samples[:usable])
        utt.carry = samples[usable:]
        self.drain(utt)
        speaking = utt.chunker.speaking
        if speaking != utt.speaking:
            utt.speaking = speaking
            utt.conn.send({"t": "vad", "id": utt.uid, "speaking": speaking})

    def drain(self, utt: Utterance, final: bool = False) -> None:
        for samples in utt.chunker.take(final):
            index = utt.next_index
            utt.next_index += 1
            utt.pending += 1
            # Audio length lets the client predict how long the remaining decodes take.
            ms = round(len(samples) * 1000 / SAMPLE_RATE)
            utt.conn.send({"t": "chunk", "id": utt.uid, "index": index, "state": "queued", "ms": ms})
            self.jobs.put(("decode", utt, index, samples))

    def maybe_finish(self, utt: Utterance) -> None:
        if utt.stopped and utt.pending == 0 and not utt.cancelled:
            text = " ".join(t for _, t in sorted(utt.texts.items()) if t)
            utt.conn.send({"t": "final", "id": utt.uid, "text": text})
            utt.conn.utterances.pop(utt.uid, None)
            self.maybe_upgrade()

    def process_results(self) -> None:
        while True:
            try:
                kind, *rest = self.results.get_nowait()
            except queue.Empty:
                return
            if kind == "loaded":
                asr, tier, error = rest
                self.loading = False
                if asr is not None:
                    self.asr, self.asr_tier = asr, tier
                if self.asr is not None:
                    # Also after a swap that kept or failed back to the current model.
                    self.broadcast(self.status())
                elif error:
                    self.broadcast({"t": "error", "message": error})
                continue
            utt, index, text = rest
            if utt.cancelled:
                continue
            if kind == "decoding":
                utt.conn.send({"t": "chunk", "id": utt.uid, "index": index, "state": "decoding"})
            else:
                utt.pending -= 1
                utt.texts[index] = text
                utt.conn.send({"t": "chunk", "id": utt.uid, "index": index, "state": "done", "text": text})
                self.maybe_finish(utt)

    # ---- sockets

    def accept(self, server: socket.socket) -> None:
        sock, _ = server.accept()
        sock.setblocking(False)
        conn = Connection(sock)
        self.connections[sock.fileno()] = conn
        self.selector.register(sock, selectors.EVENT_READ, conn)

    def close(self, conn: Connection) -> None:
        for utt in conn.utterances.values():
            utt.cancelled = True
        self.connections.pop(conn.sock.fileno(), None)
        try:
            self.selector.unregister(conn.sock)
        except (KeyError, ValueError):
            pass
        conn.sock.close()

    def read(self, conn: Connection) -> None:
        try:
            data = conn.sock.recv(65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.close(conn)
            return
        conn.inbuf += data
        while b"\n" in conn.inbuf:
            line, conn.inbuf = conn.inbuf.split(b"\n", 1)
            if conn.discarding:
                conn.discarding = False
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict):
                self.handle(conn, msg)
        if len(conn.inbuf) > MAX_LINE_BYTES:
            conn.inbuf, conn.discarding = b"", True

    def flush_writes(self) -> None:
        for conn in list(self.connections.values()):
            if not conn.outbuf:
                continue
            try:
                sent = conn.sock.send(conn.outbuf)
                conn.outbuf = conn.outbuf[sent:]
            except BlockingIOError:
                pass
            except OSError:
                self.close(conn)

    # ---- lifecycle

    def sessions_alive(self) -> bool:
        alive = False
        for path in glob.glob(os.path.join(self.home, "sessions", "*")):
            name = os.path.basename(path)
            if not name.isdigit():
                continue
            try:
                os.kill(int(name), 0)
                alive = True
            except ProcessLookupError:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            except PermissionError:
                alive = True
        return alive

    def check_idle(self) -> None:
        now = time.monotonic()
        if now < self.next_lease_check:
            return
        self.next_lease_check = now + LEASE_POLL_S
        if self.asr is not None:
            self.maybe_upgrade()
        if any(conn.utterances for conn in self.connections.values()):
            self.last_used = now
        if self.connections or self.sessions_alive():
            self.last_alive = now
        elif now - self.last_alive > self.idle_exit_s:
            log("no Pi sessions remain; exiting")
            self.running = False
            return
        if now - self.last_used > self.unused_exit_s:
            log(f"no dictation for {self.unused_exit_s:.0f}s; exiting")
            self.running = False

    def serve(self, socket_path: str) -> None:
        try:
            os.unlink(socket_path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old_umask = os.umask(0o177)
        try:
            server.bind(socket_path)
        finally:
            os.umask(old_umask)
        server.listen(16)
        server.setblocking(False)
        self.selector.register(server, selectors.EVENT_READ, None)
        log(f"listening on {socket_path} (fake={self.fake})")
        try:
            while self.running:
                for key, _ in self.selector.select(timeout=0.02):
                    if key.data is None:
                        self.accept(server)
                    else:
                        self.read(key.data)
                self.process_results()
                self.flush_writes()
                self.check_idle()
            self.flush_writes()
        finally:
            server.close()
            try:
                os.unlink(socket_path)
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Pi voice daemon")
    parser.add_argument("--home", required=True)
    parser.add_argument("--fake", action="store_true", help="energy VAD and stub ASR, for tests")
    parser.add_argument("--idle-exit", type=float, default=IDLE_EXIT_S, help="seconds without sessions before exiting")
    parser.add_argument("--unused-exit", type=float, default=UNUSED_EXIT_S, help="seconds without a dictation before exiting")
    parser.add_argument("--load-delay", type=float, default=0.0, help="extra seconds per model load, for tests")
    args = parser.parse_args()
    home = os.path.abspath(args.home)
    os.makedirs(home, mode=0o700, exist_ok=True)
    lock = open(os.path.join(home, "daemon.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        if exc.errno in (errno.EAGAIN, errno.EACCES):
            log("another daemon holds the lock; exiting")
            return 0
        raise
    lock.write(str(os.getpid()))
    lock.flush()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    Daemon(home, args.fake, args.idle_exit, args.unused_exit, args.load_delay).serve(os.path.join(home, "daemon.sock"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

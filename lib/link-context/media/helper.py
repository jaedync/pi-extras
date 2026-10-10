"""Media helper for Pi's pull_link tool, run in the tool's own virtualenv.

One command per call: `python -I helper.py <command>`, a JSON request on
stdin, a JSON reply on stdout. Errors are a JSON reply with an "error" key and
exit code 1, so the caller never has to parse a traceback.

Commands: info, captions, download, asr, compose, ffmpeg.
"""
import json
import os
import re
import shutil
import sys

PREFERRED_LANGS = ["en", "en-US", "en-GB", "en-orig"]


def emit(value, code=0):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def ffmpeg_path():
    """The system ffmpeg first, the bundled static build when there is none.

    The static build crashes on network input on some glibc hosts (its DNS
    lookup), and yt-dlp gives ffmpeg URLs when it cuts clips. Frame stamps are
    drawn with Pillow, so no ffmpeg filter that a system build may lack is used.
    """
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


class QuietLogger:
    """yt-dlp writes progress to stdout otherwise, which would corrupt the reply."""

    def __init__(self):
        self.warnings = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.warnings.append(str(msg))

    def error(self, msg):
        self.warnings.append(str(msg))


COOKIE_COPIES = []


def private_cookies(req):
    """A copy of the cookies file: yt-dlp writes its jar back on exit.

    Made owner-only from the start, and removed when the call ends (main()).
    """
    source = os.path.expanduser(req["cookies"])
    target = os.path.join(req.get("dir") or os.getcwd(), f".cookies-{os.getpid()}.txt")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out, open(source, "rb") as src:
        shutil.copyfileobj(src, out)
    COOKIE_COPIES.append(target)
    return target


def ydl_options(req, logger, extra=None):
    opts = {
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": logger,
        "socket_timeout": 30,
        # A shared watch link often carries &list=; read the one video, never the playlist.
        "noplaylist": True,
        "playlist_items": "1",
        "ffmpeg_location": ffmpeg_path(),
        "js_runtimes": {"node": {"path": req["node"]}} if req.get("node") else {"deno": {}},
    }
    if req.get("serverHome"):
        opts["extractor_args"] = {"youtubepot-bgutilscript": {"server_home": [req["serverHome"]]}}
    if req.get("proxy"):
        opts["proxy"] = req["proxy"]
    if req.get("cookies"):
        opts["cookiefile"] = private_cookies(req)
    if extra:
        opts.update(extra)
    return opts


def comment_list(info, limit):
    out = []
    for c in (info.get("comments") or [])[:limit]:
        out.append({
            "id": c.get("id"),
            "parent": c.get("parent"),
            "author": c.get("author"),
            "text": c.get("text"),
            "likes": c.get("like_count"),
            "timestamp": c.get("timestamp"),
            "pinned": c.get("is_pinned"),
        })
    return out


def cmd_info(req):
    import yt_dlp

    logger = QuietLogger()
    limit = int(req.get("comments") or 0)
    extra = {"skip_download": True}
    if limit > 0:
        extra["getcomments"] = True
        args = extra.setdefault("extractor_args", {})
        args["youtube"] = {"max_comments": [str(limit), "", "", "3"], "comment_sort": ["top"]}
    opts = ydl_options(req, logger)
    if "extractor_args" in extra:
        opts.setdefault("extractor_args", {}).update(extra.pop("extractor_args"))
    opts.update(extra)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(req["url"], download=False)
    if info.get("_type") == "playlist" and info.get("entries"):
        entries = [e for e in info["entries"] if e]
        info = entries[0] if entries else info
    keep = ["id", "title", "uploader", "channel", "uploader_id", "upload_date", "timestamp", "duration",
            "view_count", "like_count", "comment_count", "description", "webpage_url", "extractor_key",
            "chapters", "live_status", "thumbnail", "width", "height"]
    reply = {key: info.get(key) for key in keep if info.get(key) is not None}
    reply["subtitles"] = sorted((info.get("subtitles") or {}).keys())
    reply["automatic_captions"] = sorted((info.get("automatic_captions") or {}).keys())[:200]
    reply["has_video"] = any((f.get("vcodec") or "none") != "none" for f in info.get("formats") or [])
    if limit > 0:
        reply["comments"] = comment_list(info, limit)
    reply["warnings"] = logger.warnings[-5:]
    return reply


def pick_transcript(listing):
    """Manual English, generated English, then the video's own language."""
    for finder in ("find_manually_created_transcript", "find_generated_transcript"):
        try:
            return getattr(listing, finder)(PREFERRED_LANGS)
        except Exception:
            pass
    items = list(listing)
    manual = [t for t in items if not t.is_generated]
    return (manual or items or [None])[0]


def transcript_api(req):
    from youtube_transcript_api import YouTubeTranscriptApi

    kwargs = {}
    if req.get("proxy"):
        from youtube_transcript_api.proxies import GenericProxyConfig

        kwargs["proxy_config"] = GenericProxyConfig(http_url=req["proxy"], https_url=req["proxy"])
    api = YouTubeTranscriptApi(**kwargs)
    chosen = pick_transcript(api.list(req["videoId"]))
    if chosen is None:
        return None
    fetched = chosen.fetch()
    segments = [{"start": s.start, "end": s.start + s.duration, "text": s.text} for s in fetched.snippets]
    kind = "generated" if chosen.is_generated else "manual"
    return {"source": f"youtube captions ({kind})", "language": chosen.language_code, "segments": segments}


def parse_json3(text):
    data = json.loads(text)
    out = []
    for event in data.get("events") or []:
        segs = event.get("segs")
        if not segs:
            continue
        line = "".join(s.get("utf8", "") for s in segs).strip()
        if not line or line == "\n":
            continue
        start = (event.get("tStartMs") or 0) / 1000
        out.append({"start": start, "end": start + (event.get("dDurationMs") or 0) / 1000, "text": line})
    return out


TIME = re.compile(r"(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s+-->\s+(?:(\d+):)?(\d+):(\d+)[.,](\d+)")


RECENT_LINES = 3


def parse_vtt(text):
    """WebVTT and SRT, with the rolling repeats of auto-captions removed.

    Auto-captions repeat each line in the next cue or two; a line said again
    later in the video is kept, so only the last few lines are compared.
    """
    out = []
    lines = text.splitlines()
    i = 0
    recent = []
    while i < len(lines):
        m = TIME.search(lines[i])
        if not m:
            i += 1
            continue
        g = m.groups()
        start = int(g[0] or 0) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3]) / 1000
        end = int(g[4] or 0) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7]) / 1000
        i += 1
        body = []
        while i < len(lines) and lines[i].strip():
            body.append(re.sub(r"<[^>]+>", "", lines[i]).strip())
            i += 1
        for line in body:
            if line and line not in recent:
                recent = (recent + [line])[-RECENT_LINES:]
                out.append({"start": start, "end": end, "text": line})
    return out


def ytdlp_captions(req):
    import yt_dlp

    logger = QuietLogger()
    work = req["dir"]
    langs = req.get("langs") or PREFERRED_LANGS
    opts = ydl_options(req, logger, {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": langs,
        "subtitlesformat": "json3/vtt/srt/best",
        "outtmpl": os.path.join(work, "captions.%(ext)s"),
    })
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(req["url"], download=True)
    for name in sorted(os.listdir(work)):
        if not name.startswith("captions."):
            continue
        path = os.path.join(work, name)
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        segments = parse_json3(text) if name.endswith(".json3") else parse_vtt(text)
        if segments:
            language = name.split(".")[-2] if name.count(".") >= 2 else None
            return {"source": "captions via yt-dlp", "language": language, "segments": segments}
    raise RuntimeError("; ".join(logger.warnings[-2:]) or "no captions were written")


def cmd_captions(req):
    errors = []
    if req.get("videoId"):
        try:
            found = transcript_api(req)
            if found:
                return found
        except Exception as error:
            errors.append(f"youtube-transcript-api: {type(error).__name__}: {str(error).splitlines()[0][:300] if str(error) else ''}")
    try:
        return ytdlp_captions(req)
    except Exception as error:
        errors.append(f"yt-dlp: {str(error)[:300]}")
    return {"segments": [], "errors": errors}


def cmd_download(req):
    """The whole file, or clips for `sections` ([[start, end], ...], end may be null).

    Clips are cut at exact times (re-encoded at the cuts), so a frame at a
    clip's offset is the frame at that time in the video.
    """
    import yt_dlp
    from yt_dlp.utils import download_range_func

    logger = QuietLogger()
    kind = req.get("kind", "video")
    height = int(req.get("maxHeight") or 480)
    if kind == "audio":
        fmt = "bestaudio[ext=m4a]/bestaudio/best"
    else:
        # Video only: frames need no sound, and a single stream needs no merge.
        fmt = f"bv*[height<={height}][ext=mp4]/bv*[height<={height}]/b[height<={height}]/bv*/b"
    sections = [(float(a or 0), float(b) if b is not None else float("inf")) for a, b in req.get("sections") or []]
    name = f"{kind}-%(section_start)s.%(ext)s" if sections else f"{kind}.%(ext)s"
    extra = {"format": fmt, "outtmpl": os.path.join(req["dir"], name), "overwrites": True}
    if sections:
        extra["download_ranges"] = download_range_func(None, sections)
        extra["force_keyframes_at_cuts"] = True
    with yt_dlp.YoutubeDL(ydl_options(req, logger, extra)) as ydl:
        info = ydl.extract_info(req["url"], download=True)
        downloads = info.get("requested_downloads") or [{"filepath": ydl.prepare_filename(info)}]
    files = [{"path": d.get("filepath"), "start": float(d.get("section_start") or 0)} for d in downloads]
    files = [f for f in files if f["path"] and os.path.exists(f["path"])]
    if not files:
        raise RuntimeError("; ".join(logger.warnings[-2:]) or "download produced no file")
    return {"files": files}


def decode_audio(path):
    """16 kHz mono float32 through the bundled ffmpeg.

    Both backends accept an array; decoding here avoids faster-whisper's PyAV
    path, which breaks across PyAV releases, and mlx-whisper's need for an
    ffmpeg on PATH.
    """
    import subprocess

    import numpy

    raw = subprocess.run(
        [ffmpeg_path(), "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return numpy.frombuffer(raw, dtype=numpy.float32).copy()


def cmd_asr(req):
    backend = req["backend"]
    model = req["model"]
    audio = decode_audio(req["path"])
    if backend == "mlx-whisper":
        import mlx_whisper

        result = mlx_whisper.transcribe(audio, path_or_hf_repo=model, condition_on_previous_text=False)
        language = result.get("language")
        segments = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in result.get("segments", [])]
    else:
        from faster_whisper import WhisperModel

        engine = WhisperModel(model, device="cpu", compute_type="int8")
        parts, meta = engine.transcribe(audio, vad_filter=True, condition_on_previous_text=False)
        language = meta.language
        segments = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in parts]
    return {"source": f"speech-to-text ({backend}, {model.split('/')[-1]})", "language": language, "segments": segments}


def stamped(path, label, width):
    """A frame scaled to `width` with its time drawn in the corner.

    Pillow's built-in font needs no system fonts, unlike ffmpeg's drawtext,
    which minimal Linux hosts cannot use.
    """
    from PIL import Image, ImageDraw, ImageFont

    image = Image.open(path).convert("RGB")
    height = max(1, round(image.height * width / image.width))
    image = image.resize((width, height), Image.LANCZOS)
    size = max(14, width // 17)
    font = ImageFont.load_default(size=size)
    draw = ImageDraw.Draw(image)
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    pad = max(3, size // 5)
    draw.rectangle((0, 0, right - left + 2 * pad, bottom - top + 2 * pad), fill=(0, 0, 0))
    draw.text((pad - left, pad - top), label, font=font, fill=(255, 255, 255))
    return image


def cmd_compose(req):
    """Stamped single frames (`singles`) or one contact sheet (`sheet`)."""
    from PIL import Image

    frames = req["frames"]
    width = int(req["width"])
    if req["mode"] == "singles":
        for frame in frames:
            stamped(frame["path"], frame["label"], width).save(frame["out"], quality=85)
        return {"files": [frame["out"] for frame in frames]}
    tiles = [stamped(frame["path"], frame["label"], width) for frame in frames]
    columns = max(1, min(int(req["columns"]), len(tiles)))
    rows = (len(tiles) + columns - 1) // columns
    gap = 4
    tile_height = max(tile.height for tile in tiles)
    sheet = Image.new("RGB", (columns * width + (columns - 1) * gap, rows * tile_height + (rows - 1) * gap), (0, 0, 0))
    for index, tile in enumerate(tiles):
        sheet.paste(tile, ((index % columns) * (width + gap), (index // columns) * (tile_height + gap)))
    sheet.save(req["out"], quality=85)
    return {"files": [req["out"]]}


COMMANDS = {
    "info": cmd_info,
    "captions": cmd_captions,
    "download": cmd_download,
    "asr": cmd_asr,
    "compose": cmd_compose,
    "ffmpeg": lambda req: {"path": ffmpeg_path()},
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        emit({"error": f"usage: helper.py {'|'.join(COMMANDS)}"}, 2)
    try:
        req = json.loads(sys.stdin.read() or "{}")
        reply, code = COMMANDS[sys.argv[1]](req), 0
    except Exception as error:
        message = str(error).strip().splitlines()
        reply, code = {"error": f"{type(error).__name__}: {message[0][:500] if message else ''}"}, 1
    finally:
        for path in COOKIE_COPIES:
            try:
                os.remove(path)
            except OSError:
                pass
    emit(reply, code)


if __name__ == "__main__":
    main()

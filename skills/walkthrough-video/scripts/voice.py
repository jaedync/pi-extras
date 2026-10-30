#!/usr/bin/env python3
"""Kokoro synthesis for walkthrough narration. Runs in the wv setup venv.

Reads a script ([{"id": "l1", "text": "..."}]) and writes <out>/<id>.wav at the
model sample rate plus <out>/voice.json with the measured length of each line.
Only the local model is used; no service is contacted.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def fail(message):
    print(f"voice: {message}", file=sys.stderr)
    return 2


def main(argv):
    parser = argparse.ArgumentParser(description="Synthesize a walkthrough narration script with Kokoro.")
    parser.add_argument("--script", required=True, help="JSON file: [{id, text}]")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--voice", default="am_michael")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args(argv)

    try:
        script = json.loads(Path(args.script).read_text(encoding="utf-8"))
    except OSError as err:
        return fail(f"cannot read {args.script}: {err}")
    except json.JSONDecodeError as err:
        return fail(f"{args.script} is not JSON: {err}")
    if not isinstance(script, list) or not script:
        return fail(f"{args.script} must be a non-empty array of {{id, text}}")

    seen = set()
    for index, item in enumerate(script):
        if not isinstance(item, dict):
            return fail(f"line {index}: must be an object with id and text")
        line_id = item.get("id")
        text = item.get("text")
        if not isinstance(line_id, str) or not ID.match(line_id):
            return fail(f"line {index}: id must match {ID.pattern} (got {line_id!r})")
        if line_id in seen:
            return fail(f"line {index}: duplicate id {line_id}")
        seen.add(line_id)
        if not isinstance(text, str) or not text.strip():
            return fail(f"line {index} ({line_id}): text must be a non-empty string")

    model_dir = Path(args.model_dir)
    for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        if not (model_dir / name).is_file():
            return fail(f"model file missing: {model_dir / name}. Run 'wv setup'.")

    try:
        import numpy as np  # noqa: F401  (kokoro-onnx uses it; fail early with a clear message)
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except ImportError as err:
        return fail(f"the voice venv is incomplete ({err}). Run 'wv setup'.")

    threads = args.threads or max(1, (os.cpu_count() or 2) // 2)
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_dir / "kokoro-v1.0.onnx"), options, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, str(model_dir / "voices-v1.0.bin"))

    voices = set(kokoro.get_voices())
    if args.voice not in voices:
        known = sorted(name for name in voices if name[:3] in ("am_", "af_", "bm_", "bf_"))
        return fail(f"unknown voice {args.voice!r}; choose one of: {', '.join(known)}")
    lang = "en-gb" if args.voice.startswith("b") else "en-us"

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    result = []
    for item in script:
        text = item["text"].strip()
        samples, sample_rate = kokoro.create(text, voice=args.voice, speed=args.speed, lang=lang)
        target = out / f"{item['id']}.wav"
        temporary = out / f".{item['id']}.wav.part"
        sf.write(str(temporary), samples, sample_rate, format="WAV", subtype="PCM_16")
        os.replace(temporary, target)
        seconds = round(len(samples) / sample_rate, 3)
        result.append({"id": item["id"], "text": text, "file": target.name, "seconds": seconds})
        print(f"voice: {target.name} {seconds:.2f} s", file=sys.stderr)

    payload = json.dumps(result, indent=1)
    index = out / "voice.json"
    with tempfile.NamedTemporaryFile("w", dir=out, delete=False, encoding="utf-8") as handle:
        handle.write(payload + "\n")
        temporary = handle.name
    os.replace(temporary, index)
    print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机批量生成单词发音 mp3，用于 word-desk 离线音频包。

依赖：pip install piper-tts lameenc
声库：en_US-ljspeech-medium，MODEL_CARD 标注数据集为 public domain，
      美式女声、单说话人、22,050 Hz。声库文件本身来自 rhasspy/piper-voices。
引擎：OHF-Voice/piper1-gpl（GPL-3.0）作为构建期工具，只在本机运行，不随站点分发；
      随站点分发的只有生成的 mp3。

用法：
  python3 generate.py --words words.txt --out ./audio
  python3 generate.py --from-dist ../dist --out ./audio
"""
import argparse
import glob
import os
import re
import subprocess
import sys
import time
import urllib.request
import wave

import lameenc

VOICES = {
    # key: (voices.json 目录, 许可, 说明)  许可均为可再分发
    "ljspeech-medium": ("en/en_US/ljspeech/medium", "public domain", "美式女声，当前基准"),
    "ljspeech-high":   ("en/en_US/ljspeech/high",   "public domain", "同一说话人，高质量版"),
    "libritts-high":   ("en/en_US/libritts/high",   "CC BY 4.0",     "904 人混合，多说话人"),
    "john-medium":     ("en/en_US/john/medium",     "public domain", "美式男声"),
    "kristin-medium":  ("en/en_US/kristin/medium",  "public domain", "美式女声"),
    "sam-medium":      ("en/en_US/sam/medium",      "Apache-2.0",    "美式中性声"),
    "cori-high":       ("en/en_GB/cori/high",       "public domain", "英式女声"),
}
MIRROR = "https://hf-mirror.com/rhasspy/piper-voices/resolve/main/"
BIT_RATE = 48  # kbps


def ensure_model(model_dir, voice):
    if voice not in VOICES:
        raise SystemExit("未知声库 %s，可选：%s" % (voice, ", ".join(VOICES)))
    voice_dir = VOICES[voice][0]
    parts = voice_dir.split("/")          # en/en_US/john/medium
    lang, speaker, quality = parts[1], parts[2], parts[3]
    name = "%s-%s-%s" % (lang, speaker, quality)
    os.makedirs(model_dir, exist_ok=True)
    for suffix in (".onnx", ".onnx.json"):
        dest = os.path.join(model_dir, name + suffix)
        if os.path.isfile(dest) and os.path.getsize(dest) > 1000:
            continue
        url = MIRROR + voice_dir + "/" + name + suffix
        print("下载", url, flush=True)
        urllib.request.urlretrieve(url, dest)
        print("  ", os.path.getsize(dest), "bytes", flush=True)
    return os.path.join(model_dir, name + ".onnx"), os.path.join(model_dir, name + ".onnx.json")


def words_from_file(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def words_from_dist(dist_dir):
    found = []
    pattern = re.compile(r'^\s*"([a-z][a-z\' -]*)\|')
    for name in ("words.js", "words-core.js"):
        path = os.path.join(dist_dir, name)
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = pattern.match(line)
                if m:
                    found.append(m.group(1))
    seen, out = set(), []
    for w in found:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out


def synthesize(words, piper, model, config, work_dir):
    os.makedirs(work_dir, exist_ok=True)
    list_path = os.path.join(work_dir, "_words.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        f.write("\n".join(words) + "\n")
    t0 = time.time()
    subprocess.run(
        [piper, "-m", model, "-c", config, "-i", list_path,
         "-d", work_dir, "--output-dir-naming", "text"],
        check=True,
    )
    print("合成 %d 词耗时 %.2fs" % (len(words), time.time() - t0), flush=True)
    return glob.glob(os.path.join(work_dir, "*.wav"))


def to_mp3(wav_path, out_dir):
    with wave.open(wav_path, "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        pcm = w.readframes(w.getnframes())
    enc = lameenc.Encoder()
    enc.set_bit_rate(BIT_RATE)
    enc.set_in_sample_rate(sr)
    enc.set_channels(ch)
    enc.set_quality(2)
    data = enc.encode(pcm) + enc.flush()
    name = os.path.basename(wav_path).replace(".wav", ".mp3")
    with open(os.path.join(out_dir, name), "wb") as f:
        f.write(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", help="词表文件，每行一个单词")
    ap.add_argument("--from-dist", help="直接从 dist/ 的 words.js 与 words-core.js 提取全量词表")
    ap.add_argument("--out", required=True, help="mp3 输出目录")
    ap.add_argument("--model-dir", default="./.piper-model", help="声库缓存目录")
    ap.add_argument("--voice", default="ljspeech-medium", help="声库，可选：%s" % ", ".join(VOICES))
    ap.add_argument("--piper", default="piper", help="piper 可执行文件路径")
    ap.add_argument("--limit", type=int, default=0, help="只生成前 N 个词，用于试跑")
    args = ap.parse_args()

    if args.from_dist:
        words = words_from_dist(args.from_dist)
    elif args.words:
        words = words_from_file(args.words)
    else:
        ap.error("需要 --words 或 --from-dist")
    if args.limit:
        words = words[:args.limit]
    if not words:
        ap.error("词表为空")

    model, config = ensure_model(args.model_dir, args.voice)
    os.makedirs(args.out, exist_ok=True)
    work_dir = os.path.join(args.model_dir, "_wav")
    wavs = synthesize(words, args.piper, model, config, work_dir)
    if len(wavs) < len(words):
        print("警告：词表 %d 个，只生成 %d 个音频，可能有词被跳过" % (len(words), len(wavs)), flush=True)
    sizes = [to_mp3(p, args.out) for p in wavs]
    total = sum(sizes)
    print("输出 %d 个 mp3，合计 %.1f MB，平均 %d B" % (len(sizes), total / 1024 / 1024, total // len(sizes)))
    print("按 3400 词估算约 %.1f MB" % (total / len(sizes) * 3400 / 1024 / 1024))


if __name__ == "__main__":
    sys.exit(main())

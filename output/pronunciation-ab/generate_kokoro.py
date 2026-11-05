#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 Kokoro-82M 批量生成单词发音 mp3，用于 word-desk 离线音频包。

依赖：pip install kokoro-onnx soundfile lameenc
模型：onnx-community/Kokoro-82M-v1.0-ONNX 的 onnx/model.onnx（Apache-2.0）
声纹：同仓库 voices/<name>.bin，每个 522,240 字节 = 510×256 float32
引擎：kokoro-onnx（MIT），espeak-ng 只做音素化，均为构建期本机工具，不随站点分发

两个实测踩到的坑：
1. 单词必须补句号。不带标点时模型会提前收尾，"hello" 只出 0.22 秒且被截断，
   加句号后 0.90 秒、内容完整。
2. 官方 voices-v1.0.bin 与逐音色 .bin 格式不同。这里不走官方文件，
   直接把 510×256 的 float32 数组传给 create，绕开格式差异。

用法：
  python3 generate_kokoro.py --words words.txt --out ./audio --voice af_heart
  python3 generate_kokoro.py --from-dist ../dist --out ./audio --voice am_michael
"""
import argparse
import glob
import os
import re
import wave

import lameenc
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.environ.get("KOKORO_DIR", "./.kokoro")
SAMPLE_RATE = 24000
BIT_RATE = 48  # kbps


def load_voice(name):
    path = os.path.join(MODEL_DIR, name + ".bin")
    if not os.path.isfile(path):
        raise SystemExit("找不到声纹 %s，请先下载到 %s" % (path, MODEL_DIR))
    return np.fromfile(path, dtype=np.float32).reshape(510, 256)


def words_from_file(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]


def words_from_dist(dist_dir):
    found, pattern = [], re.compile(r'^\s*"([a-z][a-z\' -]*)\|')
    for name in ("words.js", "words-core.js"):
        with open(os.path.join(dist_dir, name), encoding="utf-8") as f:
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


def synth(kokoro, voice, text, speed):
    """单词补句号，否则模型会提前收尾；返回裁掉首尾静音的单声道 float32。"""
    prompt = text if text.endswith((".", "?", "!")) else text + "."
    phonemes = kokoro.tokenizer.phonemize(prompt, "en-us")
    ids = kokoro.tokenizer.tokenize(phonemes)
    if not ids:
        return None, phonemes
    style = kokoro._style_for(voice, len(ids)).reshape(1, 256)
    out = kokoro.sess.run(None, {
        "input_ids": np.array([ids], dtype=np.int64),
        "style": style,
        "speed": np.array([speed], dtype=np.float32),
    })
    audio = out[0].reshape(-1)
    peak = float(np.abs(audio).max())
    if peak < 1e-4:
        return None, phonemes
    # 阈值放到峰值的 0.5%，并两侧各留 20ms，避免把 h/l 这类弱起音削掉
    pad = int(0.02 * SAMPLE_RATE)
    idx = np.where(np.abs(audio) > peak * 0.005)[0]
    if len(idx):
        start = max(0, idx[0] - pad)
        end = min(len(audio), idx[-1] + pad)
        audio = audio[start:end]
    return audio.astype(np.float32), phonemes


def to_mp3(audio, out_path):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    enc = lameenc.Encoder()
    enc.set_bit_rate(BIT_RATE)
    enc.set_in_sample_rate(SAMPLE_RATE)
    enc.set_channels(1)
    enc.set_quality(2)
    data = enc.encode(pcm) + enc.flush()
    with open(out_path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", help="词表文件，每行一个单词")
    ap.add_argument("--from-dist", help="从 dist/ 的 words.js 与 words-core.js 提取全量词表")
    ap.add_argument("--out", required=True, help="mp3 输出目录")
    ap.add_argument("--voice", default="af_heart", help="音色名，对应 .kokoro/<name>.bin")
    ap.add_argument("--speed", type=float, default=1.0, help="语速，0.5–2.0")
    ap.add_argument("--limit", type=int, default=0, help="只生成前 N 个词，用于试跑")
    ap.add_argument("--prefix", default="", help="输出文件名前缀，便于多音色并存")
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

    model = os.path.join(MODEL_DIR, "model.onnx")
    if not os.path.isfile(model):
        raise SystemExit("找不到模型 %s" % model)
    placeholder = os.path.join(MODEL_DIR, "voices_placeholder.npy")
    if not os.path.isfile(placeholder):
        np.save(placeholder, np.zeros((1, 510, 256), dtype=np.float32))
    kokoro = Kokoro(model, placeholder)
    voice = load_voice(args.voice)

    os.makedirs(args.out, exist_ok=True)
    sizes, skipped = [], []
    for w in words:
        audio, phonemes = synth(kokoro, voice, w, args.speed)
        if audio is None or len(audio) / SAMPLE_RATE < 0.15:
            skipped.append((w, phonemes))
            continue
        sizes.append(to_mp3(audio, os.path.join(args.out, "%s%s.mp3" % (args.prefix, w))))

    print("输出 %d 个 mp3，跳过 %d 个" % (len(sizes), len(skipped)))
    if sizes:
        print("合计 %.1f MB，平均 %d B，按 3400 词估算约 %.1f MB" % (
            sum(sizes) / 1024 / 1024, sum(sizes) // len(sizes),
            sum(sizes) / len(sizes) * 3400 / 1024 / 1024))
    if skipped:
        print("跳过明细：", ", ".join("%s(%s)" % (w, p) for w, p in skipped[:10]))


if __name__ == "__main__":
    main()

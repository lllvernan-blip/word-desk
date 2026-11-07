#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""merge-audio-packs.py —— 向既有音频包追加新词（Play B 扩展包音频）

tools/build-audio-bundles.py 是全量重建：要求所有散装 mp3 在场，而内置词的
mp3 打包后已删，无法重跑。本工具把新词 mp3 追加成新的 pack-*.bin，并重写
index.json：旧词条偏移原样保留，v 递增（AGENTS.md：index.json 的 v 必须与
分片同批更新，老客户端缓存名跟着 v 走，旧缓存自动清掉）。

用法：
    python3 tools/merge-audio-packs.py --src tools/audio-candidates
    python3 tools/merge-audio-packs.py --src DIR --per-pack 200 --dry-run
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, "dist", "audio")
INDEX_NAME = "index.json"


def scan_sources(src_dir):
    rows = []
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".mp3"):
            continue
        word = name[:-4]
        # 与前端 audioKey() / build-audio-bundles.py 同一命名规则
        if not word.isalpha() or not word.islower():
            print("  跳过不符合命名规则的音频:", name)
            continue
        rows.append((word, os.path.join(src_dir, name)))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="新词 mp3 目录（word.mp3）")
    ap.add_argument("--per-pack", type=int, default=200)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    index_path = os.path.join(AUDIO_DIR, INDEX_NAME)
    if not os.path.isfile(index_path):
        sys.exit("找不到 %s；请先用 build-audio-bundles.py 建立基线" % index_path)
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)

    old_v = int(index.get("v") or 0)
    packs = list(index.get("packs") or [])
    words = dict(index.get("words") or {})

    sources = scan_sources(args.src)
    fresh = [(w, p) for w, p in sources if w not in words]
    skipped = len(sources) - len(fresh)
    print("现有：v=%d，%d 词，%d 分片；新 mp3 %d 个（跳过已在索引 %d 个）"
          % (old_v, len(words), len(packs), len(fresh), skipped))
    if not fresh:
        print("没有要追加的词。")
        return

    new_words = {}
    new_packs = []
    total = 0
    for start in range(0, len(fresh), args.per_pack):
        chunk = fresh[start:start + args.per_pack]
        pack_name = "pack-%02d.bin" % len(packs)
        offset = 0
        if not args.dry_run:
            with open(os.path.join(AUDIO_DIR, pack_name), "wb") as out:
                for word, path in chunk:
                    with open(path, "rb") as f:
                        data = f.read()
                    out.write(data)
                    new_words[word] = [len(packs), offset, len(data)]
                    offset += len(data)
                    total += len(data)
        else:
            for word, path in chunk:
                size = os.path.getsize(path)
                new_words[word] = [len(packs), 0, size]
                total += size
        if not args.dry_run:
            packs.append(pack_name)
        else:
            new_packs.append(pack_name)
        print("  %s %4d 词" % (pack_name, len(chunk)))

    new_v = old_v + 1
    index["v"] = new_v
    index["packs"] = packs
    index["words"] = words
    index["words"].update(new_words)

    if args.dry_run:
        print("dry-run：v %d -> %d，将新增 %d 词 / %s 个分片，音频 %.1f MB"
              % (old_v, new_v, len(new_words), len(new_packs), total / 1024 / 1024))
        return

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print("已写入：v %d -> %d，%d 词，%d 分片；新增音频 %.1f MB，索引 %.0f KB"
          % (old_v, new_v, len(index["words"]), len(packs), total / 1024 / 1024,
             os.path.getsize(index_path) / 1024))


if __name__ == "__main__":
    main()

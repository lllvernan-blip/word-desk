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
import shutil
import sys
import tempfile

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
    if args.per_pack <= 0:
        sys.exit("--per-pack 必须是正整数")

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
    next_pack = len(packs)
    tmp_dir = None if args.dry_run else tempfile.mkdtemp(prefix=".merge-", dir=AUDIO_DIR)
    try:
        for start in range(0, len(fresh), args.per_pack):
            chunk = fresh[start:start + args.per_pack]
            pack_name = "pack-%02d.bin" % next_pack
            offset = 0
            if not args.dry_run:
                with open(os.path.join(tmp_dir, pack_name), "wb") as out:
                    for word, path in chunk:
                        with open(path, "rb") as f:
                            data = f.read()
                        if not data:
                            raise ValueError("音频为空: %s" % path)
                        out.write(data)
                        new_words[word] = [next_pack, offset, len(data)]
                        offset += len(data)
                        total += len(data)
            else:
                for word, path in chunk:
                    size = os.path.getsize(path)
                    new_words[word] = [next_pack, offset, size]
                    offset += size
                    total += size
            new_packs.append(pack_name)
            next_pack += 1
            print("  %s %4d 词" % (pack_name, len(chunk)))

        new_index = dict(index)
        new_index["v"] = old_v + 1
        new_index["packs"] = packs + new_packs
        new_index["words"] = dict(words)
        new_index["words"].update(new_words)

        if args.dry_run:
            print("dry-run：v %d -> %d，将新增 %d 词 / %s 个分片，音频 %.1f MB"
                  % (old_v, new_index["v"], len(new_words), len(new_packs), total / 1024 / 1024))
            return

        # 新分片用未被旧索引引用的新编号，先落地再原子替换索引；中途失败旧索引仍可用。
        for name in new_packs:
            os.replace(os.path.join(tmp_dir, name), os.path.join(AUDIO_DIR, name))
        tmp_index = os.path.join(tmp_dir, INDEX_NAME)
        with open(tmp_index, "w", encoding="utf-8") as f:
            json.dump(new_index, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp_index, index_path)
        print("已写入：v %d -> %d，%d 词，%d 分片；新增音频 %.1f MB，索引 %.0f KB"
              % (old_v, new_index["v"], len(new_index["words"]), len(new_index["packs"]),
                 total / 1024 / 1024, os.path.getsize(index_path) / 1024))
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()

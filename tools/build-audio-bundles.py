#!/usr/bin/env python3
"""把 dist/audio 下的零散 mp3 打包成少量分片文件 + 索引。

为什么需要：3400 个独立 mp3 一起发布，文件数太多，静态托管同步慢、易失败。
打包后只剩十几个文件，浏览器用 HTTP Range 只取某个词那几 KB，首次播放依旧快。

用法：
    python3 tools/build-audio-bundles.py                 # 默认每包 200 词
    python3 tools/build-audio-bundles.py --per-pack 150
    python3 tools/build-audio-bundles.py --keep-source   # 保留散装 mp3（默认删掉）

产物（都在 dist/audio/）：
    pack-00.bin ... pack-NN.bin   纯字节拼接的 mp3 流
    index.json                    {"v":1,"packs":[...],"words":{"word":[pack,offset,length]}}
"""
import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, "dist", "audio")
INDEX_NAME = "index.json"


def scan_sources(audio_dir):
    """返回 [(word, path)]，跳过 index.json 与已经生成的 pack-*.bin。"""
    rows = []
    for name in sorted(os.listdir(audio_dir)):
        if not name.endswith(".mp3"):
            continue
        word = name[:-4]
        # 词表里只允许小写字母，和前端 audioKey() 的归一化规则保持一致
        if not word.isalpha() or not word.islower():
            print("  跳过不符合命名规则的音频:", name)
            continue
        rows.append((word, os.path.join(audio_dir, name)))
    return rows


def build(per_pack, keep_source):
    if not os.path.isdir(AUDIO_DIR):
        sys.exit("找不到目录: %s" % AUDIO_DIR)

    sources = scan_sources(AUDIO_DIR)
    if not sources:
        sys.exit("dist/audio 下没有可打包的 mp3。若是重复执行，请先确认 index.json 已生成。")

    words = {}
    packs = []
    total_bytes = 0

    for start in range(0, len(sources), per_pack):
        chunk = sources[start:start + per_pack]
        pack_name = "pack-%02d.bin" % len(packs)
        pack_path = os.path.join(AUDIO_DIR, pack_name)
        offset = 0
        with open(pack_path, "wb") as out:
            for word, path in chunk:
                with open(path, "rb") as f:
                    data = f.read()
                out.write(data)
                words[word] = [len(packs), offset, len(data)]
                offset += len(data)
                total_bytes += len(data)
        packs.append(pack_name)
        print("  %-12s %4d 词  %7.1f KB" % (pack_name, len(chunk), offset / 1024))

    index = {"v": 1, "packs": packs, "words": words}
    index_path = os.path.join(AUDIO_DIR, INDEX_NAME)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print("\n词条 %d，分片 %d，音频合计 %.1f MB，索引 %.0f KB"
          % (len(words), len(packs), total_bytes / 1024 / 1024,
             os.path.getsize(index_path) / 1024))

    if not keep_source:
        removed = 0
        for _, path in sources:
            os.remove(path)
            removed += 1
        print("已删除 %d 个散装 mp3" % removed)

    left = [n for n in os.listdir(AUDIO_DIR) if n.endswith(".mp3")]
    if left:
        print("注意：仍有 %d 个 mp3 留在目录里" % len(left))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-pack", type=int, default=200)
    ap.add_argument("--keep-source", action="store_true")
    args = ap.parse_args()

    if os.path.exists(os.path.join(AUDIO_DIR, INDEX_NAME)) and \
            not [n for n in os.listdir(AUDIO_DIR) if n.endswith(".mp3")]:
        print("dist/audio 已经是打包状态；重新打包请先恢复散装 mp3（见 AGENTS.md）")
        return

    build(args.per_pack, args.keep_source)


if __name__ == "__main__":
    main()

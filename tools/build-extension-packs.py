#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build-extension-packs.py —— ECDICT 分层扩展词包（docs/play-剩余工程.md · Play B）

数据源：钉死的 ecdict.csv 原表（sha256/md5 前缀 d1ecbdf9ee2b920a）。
只读 CSV 原字段（word/phonetic/translation/pos/tag/bnc/frq），**绝不**
拿 words-core.js 里已翻成中文的 examTags 当筛选源。

分层（与 Play B.2 一一对应）：
  四六级   cet4 ∪ cet6                官方
  考研     ky                         官方
  留学     ielts ∪ toefl              官方（钉死留学=雅思∪托福）
  GRE      gre                        官方
  专八     ky ∪ ielts ∪ toefl         **非官方大纲**：ECDICT 无专八 tag，仅近似
  考博     ky ∪ ielts ∪ toefl ∪ gre   **非官方大纲**：ECDICT 无考博 tag，仅近似

所有层都会剔除内置词（dist/words.js + words-core.js，同名单词以内置为准）
与 sensitive.json 的 removed 高危词。加词只改筛选条件再跑本脚本，不手贴。

用法：
  python3 tools/build-extension-packs.py --csv _vendor/ecdict.csv

产物：
  dist/content/extension/<id>.json   每层一个词包
  dist/content/extension/manifest.json  层清单（供 UI 展示词数 / 版本）
"""
import argparse
import csv
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED_PREFIX = "d1ecbdf9ee2b920a"

# id: (显示名, tag 码集合, 是否官方大纲)
LAYERS = [
    ("cet46",  "四六级",            {"cet4", "cet6"},               True),
    ("kaoyan", "考研",              {"ky"},                         True),
    ("abroad", "留学（雅思·托福）",  {"ielts", "toefl"},             True),
    ("gre",    "GRE",               {"gre"},                        True),
    ("tem8",   "专八（近似）",       {"ky", "ielts", "toefl"},       False),
    ("phd",    "考博（近似）",       {"ky", "ielts", "toefl", "gre"}, False),
]
TAG_ZH = {
    "zk": "中考", "gk": "高考", "cet4": "CET4", "cet6": "CET6",
    "ky": "考研", "ielts": "IELTS", "toefl": "TOEFL", "gre": "GRE",
}
PACK_VERSION = "2026.11.07.1"

WORD_OK = re.compile(r"^[a-z][a-z'-]*$")
POS_ABBR = re.compile(r"^[a-z]{1,7}\.\s*")


def normalize_key(s):
    # 与前端 app.js normalizeEnglish 一致
    s = str(s or "").lower()
    s = re.sub(r"[^a-z' \-]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def load_builtin_keys(dist_dir):
    seen = set()
    for name in ("words.js", "words-core.js"):
        path = os.path.join(dist_dir, name)
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r'^\s*"([^"\n]*)"\s*,?\s*$', line)
                if not m:
                    continue
                parts = m.group(1).split("|")
                if parts and parts[0].strip():
                    seen.add(normalize_key(parts[0]))
    return seen


def clean_translation(t):
    # ECDICT translation 里是字面 "\n" 两字符而非真换行，先还原再清洗
    t = str(t or "").replace("\\n", "\n")
    lines = [l.strip() for l in t.splitlines() if l.strip()]
    out = []
    for l in lines:
        l = POS_ABBR.sub("", l).strip()
        # 中文释义里的半角逗号统一成全角，与内置词库风格一致
        l = l.replace(", ", "，").replace(",", "，")
        if l and l not in out:
            out.append(l)
        if len(out) >= 2:
            break
    s = "；".join(out)
    if len(s) > 48:
        s = s[:48]
        for cut in ("；", "，", "、"):
            if cut in s:
                s = s[: s.rindex(cut)]
                break
    return s


def clean_pos(p):
    tags = []
    for seg in str(p or "").split("/"):
        name = seg.split(":")[0].strip()
        if name and name not in tags:
            tags.append(name)
    return ",".join(tags[:4])


def verify_csv(path):
    sha = hashlib.sha256()
    md5 = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            sha.update(chunk)
            md5.update(chunk)
    sha_hex, md5_hex = sha.hexdigest(), md5.hexdigest()
    ok = sha_hex.startswith(EXPECTED_PREFIX) or md5_hex.startswith(EXPECTED_PREFIX)
    print("CSV 哈希校验：")
    print("  sha256 = %s" % sha_hex)
    print("  md5    = %s" % md5_hex)
    print("  期望前缀 %s -> %s" % (EXPECTED_PREFIX, "MATCH" if ok else "MISMATCH"))
    if not ok:
        sys.exit("钉死版校验失败：这份 ecdict.csv 不是预期快照，拒绝生成。")
    with open(path, encoding="utf-8", errors="replace") as f:
        rows = sum(1 for _ in f)
    print("  行数 = %d（words-core.js 头注释记录为 770,611 行）" % (rows - 1))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="钉死版 ecdict.csv 路径")
    ap.add_argument("--dist", default=os.path.join(ROOT, "dist"))
    args = ap.parse_args()

    verify_csv(args.csv)

    out_dir = os.path.join(args.dist, "content", "extension")
    builtin = load_builtin_keys(args.dist)
    removed = set()
    spath = os.path.join(args.dist, "content", "sensitive.json")
    if os.path.isfile(spath):
        with open(spath, encoding="utf-8") as f:
            removed = {normalize_key(w) for w in json.load(f).get("removed", [])}

    layers = {lid: [] for lid, _, _, _ in LAYERS}
    n_rows = 0
    with open(args.csv, encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            n_rows += 1
            raw = (row.get("word") or "").strip()
            if not WORD_OK.match(raw.lower()):
                continue
            key = normalize_key(raw)
            if not key or key in builtin or key in removed:
                continue
            tags = {t.lower() for t in (row.get("tag") or "").split() if t}
            if not tags:
                continue
            try:
                frq = int(row.get("frq") or 0)
            except ValueError:
                frq = 0
            try:
                bnc = int(row.get("bnc") or 0)
            except ValueError:
                bnc = 0
            rank = frq if frq > 0 else (bnc + 100000 if bnc > 0 else 999999)
            entry = {
                "word": raw.lower(),
                "meaning": clean_translation(row.get("translation")),
                "pos": clean_pos(row.get("pos")),
                "phonetic": (row.get("phonetic") or "").strip(),
                "freqRank": frq or None,
                "examTags": [TAG_ZH[t] for t in sorted(tags) if t in TAG_ZH],
            }
            if not entry["meaning"]:
                continue
            for lid, _, need, _off in LAYERS:
                if tags & need:
                    layers[lid].append((rank, key, entry))

    os.makedirs(out_dir, exist_ok=True)
    packs = []
    for lid, name, _, official in LAYERS:
        entries = {}
        for rank, key, entry in sorted(layers[lid], key=lambda t: (t[0], t[1])):
            entries.setdefault(key, entry)  # 同词去重，保留词频最高的一条
        words = list(entries.values())
        data = {
            "v": PACK_VERSION,
            "id": lid,
            "name": name,
            "official": official,
            "note": "" if official else "非官方大纲：ECDICT 无此考试官方 tag，按近似层筛选",
            "source": "ECDICT tag=" + "+".join(sorted(LAYERS[[l[0] for l in LAYERS].index(lid)][2])),
            "count": len(words),
            "words": words,
        }
        path = os.path.join(out_dir, "%s.json" % lid)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        flag = "官方" if official else "非官方大纲"
        print("%-8s %-12s %5d 词  %7.1f KB  [%s]" % (lid, name, len(words), os.path.getsize(path) / 1024, flag))
        packs.append({"id": lid, "name": name, "official": official,
                      "count": len(words), "url": "./content/extension/%s.json" % lid})

    manifest = {"v": PACK_VERSION, "updatedAt": "2026-11-07T00:00:00Z", "packs": packs}
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("已生成 manifest.json；共读 CSV %d 行" % n_rows)


if __name__ == "__main__":
    main()

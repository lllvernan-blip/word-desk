#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build-examples.py —— 情景例句包构建（docs/play-剩余工程.md · Play A）

流程：解析 dist/words.js + dist/words-core.js 得到内置词表 → 读取候选句
（外部 jsonl / stdin / 生成器命令，不绑定任何厂商）→ 硬过滤 → 整 key 合并
写入 dist/content/examples.json。

候选输入（可插拔）：
  --input PATH      jsonl 文件或目录（目录合并其中全部 *.jsonl）；每行
                    {"word": "...", "sentence": "..."}（也认 w / s 别名）
  --input -         从 stdin 读同样格式的 jsonl
  --gen-cmd CMD     生成器命令：{words} 占位符替换为词表 TSV 路径
                    （word<TAB>meaning<TAB>freqRank），命令向 stdout 打印
                    同样格式的 jsonl。任何厂商 API 都可以包成这样的命令。
  --emit-words PATH 只导出待生成词表 TSV（给生成器当输入），不做合并

硬过滤（不过滤的候选不写入该 key，绝不留空数组占位）：
  1. 句中必须出现目标词本身（原词字面，大小写不敏感，词边界匹配；
     running 不算 run）
  2. 英文词数 8–20
  3. 单行；无中英混排、无明显乱码（只放行 ASCII 可见字符与少量
     常用弯引号 / 破折号 / 省略号）

合并规则（Play A.3，钉死）：
  - 白名单 tools/examples-keep.json（存在则生效）里的词条永不被脚本覆盖
    （人工精品）；文件格式与 examples.json 相同
  - 其余词：质检通过的新句整 key 替换（不追加堆多句）
  - 质检失败：保留旧值（若有），否则该 key 不出现

常用命令：
  python3 tools/build-examples.py --emit-words words.tsv --limit 100   # 试点词表
  python3 tools/build-examples.py --input tools/examples-candidates    # 全量合并
"""
import argparse
import json
import os
import re
import sys

WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
# 弯引号/破折号等少量放行，其余非 ASCII（含全部 CJK/全角）一律拒收
ALLOWED_NON_ASCII = set("\u2018\u2019\u201c\u201d\u2013\u2014\u2026")
LINE_RE = re.compile(r'^\s*"([^"\n]*)"\s*,?\s*$')


def normalize_key(s):
    # 与前端 app.js normalizeEnglish 一致：小写、只留字母/撇号/空格/连字符
    s = str(s or "").lower()
    s = re.sub(r"[^a-z' \-]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def load_builtin_words(dist_dir):
    """返回 [(word, meaning, freq_rank_or_None)]，与前端 BUILTIN 一致的去重顺序。"""
    found = []
    seen = set()
    for name in ("words.js", "words-core.js"):
        path = os.path.join(dist_dir, name)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = LINE_RE.match(line)
                if not m:
                    continue
                parts = m.group(1).split("|")
                if len(parts) < 2 or not parts[0].strip():
                    continue
                key = normalize_key(parts[0])
                if not key or key in seen:
                    continue
                seen.add(key)
                freq = parts[6].strip() if len(parts) > 6 else ""
                rank = int(freq) if freq.isdigit() else None
                found.append((key, parts[1].strip(), rank))
    return found


def select_words(words, select, limit):
    if select == "freq":
        words = sorted(words, key=lambda t: (t[2] is None, t[2] if t[2] is not None else 0))
    return words[:limit] if limit else words


def word_in_sentence(word, sentence):
    esc = re.escape(word)
    if " " in word or "-" in word or "'" in word:
        return re.search(r"(?<![a-z])" + esc + r"(?![a-z])", sentence.lower()) is not None
    return re.search(r"(?<![a-zA-Z])" + esc + r"(?![a-zA-Z])", sentence, re.IGNORECASE) is not None


def check_sentence(word, sentence):
    """返回 None 表示通过，否则返回失败原因。"""
    s = str(sentence or "").strip()
    if not s:
        return "empty"
    if "\n" in s or "\r" in s:
        return "multiline"
    for ch in s:
        if ord(ch) < 128:
            if not (ch.isprintable() and not ch.isspace() or ch == " "):
                return "control-chars"
        elif ch not in ALLOWED_NON_ASCII:
            return "non-ascii"  # 含中英混排 / 全角符号 / 乱码
    n = len(WORD_RE.findall(s))
    if n < 8 or n > 20:
        return "word-count-%d" % n
    if not word_in_sentence(word, s):
        return "word-missing"
    return None


def iter_candidates(args):
    """产出 (word, sentence)；来源由 --input / --gen-cmd 决定。"""
    if args.gen_cmd:
        tsv = args._words_tsv
        cmd = args.gen_cmd.replace("{words}", tsv)
        proc = subprocess_tsv(cmd)
        yield from proc
        return
    src = args.input
    if src == "-":
        yield from read_jsonl(sys.stdin)
        return
    if os.path.isdir(src):
        for name in sorted(os.listdir(src)):
            if name.endswith(".jsonl"):
                with open(os.path.join(src, name), encoding="utf-8") as f:
                    yield from read_jsonl(f)
    else:
        with open(src, encoding="utf-8") as f:
            yield from read_jsonl(f)


def subprocess_tsv(cmd):
    import subprocess
    out = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if out.returncode != 0:
        raise RuntimeError("例句生成器退出码 %d：%s" % (out.returncode, out.stderr.decode("utf-8", "replace")[:300]))
    yield from read_jsonl(out.stdout.decode("utf-8", "replace").splitlines())


def read_jsonl(lines):
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            yield ("", "unparseable: %s" % line[:80])
            continue
        w = obj.get("word", obj.get("w", "")) if isinstance(obj, dict) else ""
        s = obj.get("sentence", obj.get("s", "")) if isinstance(obj, dict) else ""
        yield (normalize_key(w), s)


def main():
    ap = argparse.ArgumentParser(description="构建 dist/content/examples.json（Play A）")
    ap.add_argument("--dist", default="dist", help="dist 目录（默认 dist）")
    ap.add_argument("--out", default="", help="输出 json（默认 dist/content/examples.json）")
    ap.add_argument("--keep", default="tools/examples-keep.json", help="白名单文件，不存在则忽略")
    ap.add_argument("--input", default="", help="候选 jsonl 文件 / 目录 / - （stdin）")
    ap.add_argument("--gen-cmd", default="", help="生成器命令，{words} 为词表 TSV 占位符")
    ap.add_argument("--emit-words", default="", help="只导出词表 TSV 到此路径")
    ap.add_argument("--select", choices=["freq", "order"], default="freq",
                    help="词表顺序：freq=按词频升序（默认），order=文件原序")
    ap.add_argument("--limit", type=int, default=0, help="只取前 N 个词（0=全部）")
    ap.add_argument("--dry-run", action="store_true", help="只输出报告，不写文件")
    args = ap.parse_args()

    words = select_words(load_builtin_words(args.dist), args.select, args.limit)
    allowed = {w for w, _, _ in words}

    if args.emit_words:
        with open(args.emit_words, "w", encoding="utf-8") as f:
            for w, m, rank in words:
                f.write("%s\t%s\t%s\n" % (w, m.replace("\t", " "), rank if rank is not None else ""))
        print("词表已导出：%s（%d 词）" % (args.emit_words, len(words)))
        return

    if not args.input and not args.gen_cmd:
        ap.error("需要 --input 或 --gen-cmd（或 --emit-words）")

    # 仅 --gen-cmd 需要把词表落到盘上；从 jsonl 合并时不要覆盖候选目录里的词表
    args._words_tsv = os.path.join("tools", "examples-candidates", "_words-for-gen-%d.tsv" % os.getpid())
    if args.gen_cmd:
        os.makedirs(os.path.dirname(args._words_tsv), exist_ok=True)
        with open(args._words_tsv, "w", encoding="utf-8") as f:
            for w, m, rank in words:
                f.write("%s\t%s\t%s\n" % (w, m.replace("\t", " "), rank if rank is not None else ""))

    out_path = args.out or os.path.join(args.dist, "content", "examples.json")
    old = {}
    if os.path.isfile(out_path):
        with open(out_path, encoding="utf-8") as f:
            old = json.load(f)

    keep = {}
    if args.keep and os.path.isfile(args.keep):
        with open(args.keep, encoding="utf-8") as f:
            keep = json.load(f)
    # 白名单是人工精品，但仍要符合同一套硬过滤，避免坏值绕过
    valid_keep = {}
    for w, vals in (keep.items() if isinstance(keep, dict) else []):
        if not isinstance(w, str) or not isinstance(vals, list):
            continue
        good = [s for s in vals if isinstance(s, str) and check_sentence(w, s) is None]
        if good:
            valid_keep[w] = good
        else:
            print("  白名单条目无效，已忽略:", w)
    keep = valid_keep

    passed = {}       # word -> sentence
    fail_reasons = {}
    seen_words = set()
    unknown_words = 0
    dup_words = 0
    for w, s in iter_candidates(args):
        if not w:
            fail_reasons["unparseable"] = fail_reasons.get("unparseable", 0) + 1
            continue
        if w not in allowed:
            unknown_words += 1
            continue
        if w in seen_words:
            dup_words += 1
            continue  # 首见优先，保证幂等
        seen_words.add(w)
        reason = check_sentence(w, s)
        if reason is None:
            passed[w] = s.strip()
        else:
            fail_reasons[reason.split("-")[0]] = fail_reasons.get(reason.split("-")[0], 0) + 1

    result = {}
    replaced = kept_old = whitelist_kept = dropped_old = 0
    for w, _, _rank in words:
        in_keep = w in keep and keep.get(w)
        if in_keep:
            result[w] = keep[w]
            whitelist_kept += 1
            continue
        if w in passed:
            result[w] = [passed[w]]
            replaced += 1
        elif w in old and isinstance(old[w], list) and old[w]:
            result[w] = old[w]
            kept_old += 1
        else:
            dropped_old += 1
    # 不在本次选择范围（如 --limit 试点）的旧词条：一律保留旧值，避免误删
    out_of_scope = 0
    for w, v in old.items():
        if w not in result and isinstance(v, list) and v:
            result[w] = v
            out_of_scope += 1

    print("---- build-examples 报告 ----")
    print("词表：%d（select=%s limit=%s）" % (len(words), args.select, args.limit or "all"))
    print("候选：通过 %d；未知词 %d；重复 %d" % (len(passed), unknown_words, dup_words))
    print("过滤失败分布：%s" % json.dumps(fail_reasons, ensure_ascii=False, sort_keys=True))
    print("合并：%d 整 key 替换 | %d 保留旧值 | %d 白名单保留 | %d 无句（不写 key）| %d 范围外旧值保留"
          % (replaced, kept_old, whitelist_kept, dropped_old, out_of_scope))
    bad = [k for k, v in result.items() if not isinstance(v, list) or not v]
    if bad:
        sys.exit("发现空值/坏值 key，拒绝写入：%s" % ", ".join(bad[:10]))
    if args.dry_run:
        print("dry-run：未写入 %s" % out_path)
        return
    import tempfile
    fd, tmp_path = tempfile.mkstemp(prefix=".examples-", suffix=".json", dir=os.path.dirname(out_path) or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        os.replace(tmp_path, out_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    print("已写入 %s（%d 词，%d 字节）" % (out_path, len(result), os.path.getsize(out_path)))


if __name__ == "__main__":
    main()

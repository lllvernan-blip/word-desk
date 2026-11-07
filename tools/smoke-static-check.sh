#!/usr/bin/env bash
# word-desk 静态冒烟：可脚本化的发布前检查（不启动浏览器、不改文件）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PASS=0
FAIL=0
note() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS+1)); note "PASS  $*"; }
bad() { FAIL=$((FAIL+1)); note "FAIL  $*"; }

note "== word-desk smoke-static-check =="
note "cwd: $ROOT"
note "time: $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')"

# 1) syntax
if node --check dist/app.js >/dev/null 2>&1; then ok "node --check dist/app.js"; else bad "node --check dist/app.js"; fi
if node --check dist/sw.js >/dev/null 2>&1; then ok "node --check dist/sw.js"; else bad "node --check dist/sw.js"; fi

# 2) stale copy (§2.4 #5) — grep 零命中 exit 1，必须吞掉
STALE1=$(grep -R -n "系统朗读" dist --include='*.js' --include='*.html' --include='*.css' --include='*.json' 2>/dev/null | wc -l | tr -d ' ' || true)
STALE2=$(grep -R -n "选项会相应减少" dist --include='*.js' --include='*.html' --include='*.css' --include='*.json' 2>/dev/null | wc -l | tr -d ' ' || true)
STALE1=${STALE1:-0}
STALE2=${STALE2:-0}
if [ "$STALE1" = "0" ] && [ "$STALE2" = "0" ]; then ok "过期文案「系统朗读」「选项会相应减少」= 0"; else bad "过期文案仍存在（系统朗读=$STALE1 选项会相应减少=$STALE2）"; fi

# 3) broken-audio guard uses namespaced key (§2.4 #4 静态)
if grep -q 'AUDIO_BROKEN.has(audioBrokenKey' dist/app.js; then ok "坏音频判断使用 audioBrokenKey(...)"; else bad "未找到 AUDIO_BROKEN.has(audioBrokenKey(...))"; fi

# 4) listen / recall input refill (§2.4 #3 静态)
if grep -q 'card.recallTyped' dist/app.js && grep -q 'value="${esc(card.recallTyped' dist/app.js; then
  ok "听音/拼写输入回填 recallTyped"
else
  bad "未找到 recallTyped 回填模板"
fi

# 5) backup payload field names (§2.4 #8 静态存在性)
for needle in "schemaVersion" "userWords" "wrongBook" "blocked" "app: 'word-desk'" "BACKUP_SCHEMA"; do
  if grep -qF "$needle" dist/app.js; then ok "备份相关源码含: $needle"; else bad "备份相关源码缺: $needle"; fi
done

# 6) shell cache name
CACHE_LINE=$(grep -E "const CACHE = 'wtp-shell-v[0-9]+'" dist/sw.js || true)
if [ -n "$CACHE_LINE" ]; then ok "SW CACHE 行: $CACHE_LINE"; else bad "未找到 wtp-shell-vNN CACHE 声明"; fi

# 7) sensitive.json
if [ -f dist/content/sensitive.json ]; then
  if python3 -c 'import json; json.load(open("dist/content/sensitive.json"))' 2>/dev/null; then
    ok "dist/content/sensitive.json 存在且可解析"
  else
    bad "sensitive.json 无法 JSON 解析"
  fi
else
  bad "缺少 dist/content/sensitive.json"
fi

# 8) audio index vs packs（不写死分片数，只查一致性：v 存在、meta 与实际 bin 数一致、词条偏移不越界）
if [ -f dist/audio/index.json ]; then
  EVAL=$(python3 - <<'PY'
import json, glob
idx=json.load(open("dist/audio/index.json"))
v=idx.get("v")
packs=idx.get("packs") or []
bins=sorted(glob.glob("dist/audio/pack-*.bin"))
words=idx.get("words") or {}
overflow=sum(1 for e in words.values() if not isinstance(e, list) or len(e)!=3 or not (0 <= e[0] < len(packs)))
ok = (v is not None) and (len(packs)==len(bins)) and overflow==0 and len(words)>0
print(f"v={v}; packs_meta={len(packs)}; bins={len(bins)}; words={len(words)}; overflow={overflow}; ok={ok}")
PY
)
  if echo "$EVAL" | grep -q 'ok=True'; then ok "audio index 与分片: $EVAL"; else bad "audio index 与分片不一致: $EVAL"; fi
else
  bad "缺少 dist/audio/index.json"
fi

# 9) CSS token sanity
if grep -n 'var(--text)' dist/styles.css >/dev/null 2>&1; then
  bad "styles.css 仍含 var(--text)（应为 --ink）"
else
  ok "styles.css 无 var(--text)"
fi

# 10) examples.json 与扩展词包 manifest
EVAL=$(python3 - <<'PY'
import json, os
ok=True; msg=[]
try:
    ex=json.load(open("dist/content/examples.json"))
    msg.append(f"examples={len(ex)}")
    ok = ok and len(ex)>0 and all(isinstance(v,list) and v for v in ex.values())
except Exception as e:
    ok=False; msg.append("examples-bad")
try:
    man=json.load(open("dist/content/extension/manifest.json"))
    msg.append(f"extpacks={len(man.get('packs') or [])}")
    for p in man.get("packs") or []:
        d=json.load(open(os.path.join("dist/content/extension", p["id"]+".json")))
        if d.get("count")!=len(d.get("words") or []): ok=False; msg.append(p["id"]+"-count-mismatch")
except Exception:
    ok=False; msg.append("extpacks-bad")
print("; ".join(msg)+f"; ok={ok}")
PY
)
  if echo "$EVAL" | grep -q 'ok=True'; then ok "内容包: $EVAL"; else bad "内容包异常: $EVAL"; fi

note "--"
note "合计 PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0

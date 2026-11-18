#!/usr/bin/env bash
# word-desk 一条命令验证：静态冒烟 + 版本一致性 + 重复 id + 对比度 + 起服务实跑
# 用法: bash tools/verify.sh
# 退出码 0 = 全绿；非 0 = 有失败项（末尾一行会指出）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PASS=0
FAIL=0
FAILED_LIST=""
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); FAILED_LIST="$FAILED_LIST|$*"; printf 'FAIL  %s\n' "$*"; }
note() { printf '%s\n' "$*"; }

note "== word-desk verify =="
note "cwd:  $ROOT"
note "time: $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')"
note "head: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'no-git')$(git -C "$ROOT" diff --quiet 2>/dev/null || echo ' (工作区未提交)')"

# 1) 既有静态冒烟
note "-- 静态冒烟"
if bash tools/smoke-static-check.sh >/tmp/word-desk-smoke.out 2>&1; then
  ok "smoke-static-check.sh 全部通过 ($(grep -c '^PASS' /tmp/word-desk-smoke.out) 项)"
else
  bad "smoke-static-check.sh 有失败项"
  grep '^FAIL' /tmp/word-desk-smoke.out | sed 's/^/      /'
fi

# 2) sw 版本与 AGENTS.md 一致
note "-- 版本一致性"
SW_V=$(grep -oE "wtp-shell-v[0-9]+" dist/sw.js | head -1)
DOC_V=$(grep -oE "wtp-shell-v[0-9]+" AGENTS.md | head -1)
if [ -n "$SW_V" ] && [ "$SW_V" = "$DOC_V" ]; then
  ok "sw 缓存版本与 AGENTS.md 一致: $SW_V"
else
  bad "版本不一致: dist/sw.js=${SW_V:-无} AGENTS.md=${DOC_V:-无}"
fi

# 3) 重复 id
note "-- DOM 检查"
DUP=$(grep -oE 'id="[^"]+"' dist/index.html | sort | uniq -d)
if [ -z "$DUP" ]; then
  ok "index.html 无重复 id"
else
  DUP_ONE=$(printf '%s' "$DUP" | tr '\n' ' ')
  bad "index.html 有重复 id: $DUP_ONE"
fi

# 4) 对比度（--muted 在 --paper 上，亮/暗各一次，目标 >= 4.5）
note "-- 对比度"
# 4b) 对比度计算（写成临时文件，避免 bash 3.2 对 $() 里 heredoc 的解析问题）
PYPY=$(mktemp /tmp/wd-contrast.XXXXXX.py)
cat > "$PYPY" <<'PY'
import re
css = open('dist/styles.css', encoding='utf-8').read()

def block_after(marker):
    i = css.find(marker)
    if i < 0:
        return ''
    depth = 0
    for j in range(i, len(css)):
        if css[j] == '{':
            depth += 1
        elif css[j] == '}':
            depth -= 1
            if depth == 0:
                return css[i:j + 1]
    return ''

def token(block, name):
    m = re.search(r'--' + name + r':\s*(#[0-9a-fA-F]{3,8})', block)
    return m.group(1) if m else None

def rgb(hexv):
    h = hexv.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def lum(hexv):
    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb(hexv)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

light = block_after(':root')
dark_marker = re.search(r'\[data-theme=["\']dark["\']\]\s*\{', css)
dark = block_after(dark_marker.group(0)) if dark_marker else ''

rows = []
for label, blk in (('亮色', light), ('暗色', dark)):
    muted, paper = token(blk, 'muted'), token(blk, 'paper')
    if not muted or not paper:
        rows.append((label, None, muted, paper))
    else:
        rows.append((label, ratio(muted, paper), muted, paper))

parts, worst = [], 99.0
for label, r, muted, paper in rows:
    if r is None:
        parts.append(label + ':missing')
    else:
        parts.append('%s=%.2f(%s on %s)' % (label, r, muted, paper))
        worst = min(worst, r)
print('; '.join(parts) + '; worst=%.2f' % worst)
print('OK' if worst >= 4.5 else 'LOW')
PY
CONTRAST=$(python3 "$PYPY")
rm -f "$PYPY"
if echo "$CONTRAST" | tail -1 | grep -q OK; then
  ok "对比度达标: $(echo "$CONTRAST" | head -1)"
else
  bad "对比度不足: $(echo "$CONTRAST" | head -1)"
fi

# 5) 起服务实跑
note "-- 本地服务"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory dist >/tmp/word-desk-http.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT
ready=0
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then ready=1; break; fi
  sleep 0.1
done
if [ "$ready" = "1" ]; then
  ok "服务已起: http://127.0.0.1:$PORT/"
  for path in index.html sw.js content/sensitive.json audio/index.json; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$path")
    if [ "$code" = "200" ]; then ok "GET /$path 200"; else bad "GET /$path $code"; fi
  done
  HTML=$(curl -fsS "http://127.0.0.1:$PORT/")
  for id in appVersion answerSeg audioCacheStat bootFallback; do
    if printf '%s' "$HTML" | grep -q "id=\"$id\""; then ok "页面含 #$id"; else bad "页面缺 #$id"; fi
  done
else
  bad "本地服务 10 秒内没起来（见 /tmp/word-desk-http.log）"
fi
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
trap - EXIT

note "--"
if [ "$FAIL" -eq 0 ]; then
  printf 'VERDICT: PASS  (%d 项全过)\n' "$PASS"
  exit 0
fi
printf 'VERDICT: FAIL  (%d 项失败 / %d 项通过)\n' "$FAIL" "$PASS"
printf '失败项:%s\n' "${FAILED_LIST#|}" | tr '|' '\n' | grep -v '^失败项:$'
exit 1

#!/usr/bin/env bash
# word-desk 唯一部署入口：把 dist/ 推到 GitHub Pages（gh-pages 分支）。
#
# dist/ 就是源码，没有构建步骤，也没有额外的源码目录需要同步。
# 本脚本不改文件、不提交、不 amend，只做前置校验，全部通过后才推送。
#
# 用法：
#   bash deploy.sh              # 校验并发布
#   DRY_RUN=1 bash deploy.sh    # 只校验，不推送（上线前自检）
#
# 注意：脚本要求工作区干净。上线前先提交：
#   git add dist && git commit -m "上线：改了 xxx"
set -euo pipefail
cd "$(dirname "$0")"

REMOTE="origin"
BRANCH="gh-pages"
SITE="https://lllvernan-blip.github.io/word-desk/"

fail() {
  echo "✗ $1" >&2
  exit 1
}

ver_gt() {
  # $1 严格大于 $2（点分数字）
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1)" = "$1" ]
}

# ---------- 0. 基础环境 ----------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "当前目录不是 git 仓库，无法发布。"
git remote get-url "$REMOTE" >/dev/null 2>&1 || fail "找不到远端 ${REMOTE}，无法发布。"
subtree_usage=$(git subtree 2>&1 || true)
printf '%s' "$subtree_usage" | grep -q "^usage: git subtree" || fail "本机 git 没有 subtree 子命令，无法推送到 ${BRANCH}（请先安装 git-subtree）。"

# ---------- 1. 工作区必须干净：发布内容要能对应到一个 commit ----------
current_branch=$(git rev-parse --abbrev-ref HEAD)
[ "$current_branch" = "main" ] || fail "当前在 ${current_branch} 分支，发布只从 main 出发；先切回 main。"

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动，发布内容无法对应一个 commit。先提交再发布：" >&2
  echo "    git add dist && git commit -m \"上线：...\"" >&2
  echo "  当前改动：" >&2
  git status --short | sed 's/^/    /' | head -8 >&2
  exit 1
fi

# ---------- 2. 读取线上版本（只读，不推送） ----------
echo "→ 读取 $REMOTE/$BRANCH 线上版本"
remote_refs=$(git ls-remote --heads "$REMOTE" "$BRANCH") || fail "访问远端失败，无法确认线上版本（检查网络与仓库权限）。"
remote_sw=""
remote_app=""
if [ -n "$remote_refs" ]; then
  git fetch -q "$REMOTE" "$BRANCH" || fail "拉取 $REMOTE/$BRANCH 失败，无法确认线上版本。"
  remote_sw=$(git show "$REMOTE/$BRANCH:sw.js" 2>/dev/null \
    | sed -n "s/.*wtp-shell-v\([0-9][0-9]*\).*/\1/p" | head -1 || true)
  remote_app=$(git show "$REMOTE/$BRANCH:app.js" 2>/dev/null \
    | sed -n "s/.*version: '\([0-9][0-9.]*\)'.*/\1/p" | head -1 || true)
  remote_audio_v=$(git show "$REMOTE/$BRANCH:audio/index.json" 2>/dev/null \
    | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("v") or 0))' 2>/dev/null || true)
else
  echo "→ 线上还没有 $BRANCH 分支，按首次发布处理"
fi

local_sw=$(sed -n "s/.*wtp-shell-v\([0-9][0-9]*\).*/\1/p" dist/sw.js | head -1)
local_app=$(sed -n "s/.*version: '\([0-9][0-9.]*\)'.*/\1/p" dist/app.js | head -1)
local_audio_v=$(python3 -c 'import json; print(int(json.load(open("dist/audio/index.json")).get("v") or 0))' 2>/dev/null || true)
[ -n "$local_sw" ] || fail "dist/sw.js 里找不到 wtp-shell-vNN 缓存版本号。"
[ -n "$local_app" ] || fail "dist/app.js 里找不到 CONFIG.version。"

remote_sw_label="v${remote_sw}"
[ -n "$remote_sw" ] || remote_sw_label="（无）"
echo "  本地：app ${local_app} / sw v${local_sw}"
echo "  线上：app ${remote_app:-（无）} / sw ${remote_sw_label}"

if [ -n "$remote_sw" ]; then
  if [ "$local_sw" -lt "$remote_sw" ]; then
    fail "本地缓存版本 v$local_sw 低于线上 v${remote_sw}，可能基于旧代码，请先同步再发布。"
  fi
  if cmp -s <(git show "$REMOTE/$BRANCH:sw.js") dist/sw.js; then
    sw_changed=0
  else
    sw_changed=1
  fi
  if [ "$local_sw" -eq "$remote_sw" ] && [ "$sw_changed" -eq 1 ]; then
    fail "dist/sw.js 改了，但缓存版本仍是 v${local_sw}（不高于线上 v${remote_sw}）；先递增 wtp-shell-vNN。"
  fi

  if [ "$local_app" = "$remote_app" ] && ! cmp -s <(git show "$REMOTE/$BRANCH:app.js") dist/app.js; then
    fail "dist/app.js 内容变了，但 CONFIG.version 仍是 ${local_app}，没有成为本次新版本。"
  fi
  if [ "$local_app" != "$remote_app" ] && ! ver_gt "$local_app" "$remote_app"; then
    fail "dist/app.js 版本 $local_app 低于线上 ${remote_app}，可能基于旧代码。"
  fi

  # 外壳资源改了却没升 SW 缓存：老用户会一直吃旧缓存
  if [ "$local_sw" -eq "$remote_sw" ]; then
    stale=""
    for f in index.html styles.css app.js words.js words-core.js roots-data.js \
             manifest.webmanifest content/manifest.json content/words-extra.json \
             content/roots.json content/sensitive.json; do
      [ -f "dist/$f" ] || continue
      remote_hash=$(git rev-parse "$REMOTE/$BRANCH:$f" 2>/dev/null || true)
      local_hash=$(git hash-object "dist/$f")
      if [ -n "$remote_hash" ] && [ "$remote_hash" != "$local_hash" ]; then
        stale="$stale $f"
      fi
    done
    [ -z "$stale" ] || fail "这些外壳资源改了但 SW 缓存版本仍是 v${local_sw}：${stale# }；先递增 wtp-shell-vNN。"
  fi
fi

# 音频包变了但 index.v 没递增：老客户端会拿旧索引按旧偏移切新分片
if [ -n "${remote_audio_v:-}" ] && [ -n "${local_audio_v:-}" ]; then
  if [ "$local_audio_v" -lt "$remote_audio_v" ]; then
    fail "本地音频版本 v${local_audio_v} 低于线上 v${remote_audio_v}，请先同步。"
  fi
  remote_audio_tree=$(git rev-parse "$REMOTE/$BRANCH:audio" 2>/dev/null || true)
  local_audio_tree=$(git rev-parse "HEAD:dist/audio" 2>/dev/null || true)
  if [ "$local_audio_v" -eq "$remote_audio_v" ] && [ -n "$remote_audio_tree" ] && [ "$remote_audio_tree" != "$local_audio_tree" ]; then
    fail "audio/ 内容变了，但 index.json 的 v 仍是 ${local_audio_v}；先重建音频包并递增 v。"
  fi
fi

# ---------- 3. dist 完整性：引用、预缓存、音频索引都要对得上 ----------
for f in index.html app.js styles.css sw.js manifest.webmanifest \
         words.js words-core.js roots-data.js audio/index.json; do
  [ -f "dist/$f" ] || fail "dist/$f 缺失，发布包不完整。"
done

missing_html=$(grep -o '\(href\|src\)="\./[^"]*"' dist/index.html \
  | sed 's/.*="\.\///; s/"$//' \
  | while IFS= read -r p; do [ -e "dist/$p" ] || echo "$p"; done)
[ -z "$missing_html" ] || fail "dist/index.html 引用了不存在的资源：$(echo "$missing_html" | tr '\n' ' ')"

missing_core=$(sed -n '/const CORE = \[/,/\];/p' dist/sw.js \
  | grep -o "'\./[^']*'" | tr -d "'" | sed 's|^\./||' \
  | while IFS= read -r p; do [ -z "$p" ] || [ -e "dist/$p" ] || echo "$p"; done)
[ -z "$missing_core" ] || fail "dist/sw.js 的 CORE 里有不存在的文件：$(echo "$missing_core" | tr '\n' ' ')"

missing_packs=$(grep -o '"pack-[0-9][0-9]*\.bin"' dist/audio/index.json | tr -d '"' | sort -u \
  | while IFS= read -r p; do [ -f "dist/audio/$p" ] || echo "$p"; done)
[ -z "$missing_packs" ] || fail "audio/index.json 引用了不存在的分片：$(echo "$missing_packs" | tr '\n' ' ')"

idx_packs=$(grep -o '"pack-[0-9][0-9]*\.bin"' dist/audio/index.json | sort -u | wc -l | tr -d ' ')
bin_count=$(find dist/audio -maxdepth 1 -type f -name 'pack-*.bin' | wc -l | tr -d ' ')
[ "$idx_packs" = "$bin_count" ] || fail "音频索引列了 $idx_packs 个分片，实际有 $bin_count 个 bin，索引与分片不一致。"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo
  echo "✓ 自检全部通过（DRY_RUN=1，未推送）"
  echo "  正式发布：bash deploy.sh"
  exit 0
fi

# ---------- 4. 静态冒烟：语法、内容包、音频偏移 ----------
[ -f tools/smoke-static-check.sh ] || fail "缺少 tools/smoke-static-check.sh，无法完成发布前静态检查。"
bash tools/smoke-static-check.sh >/tmp/word-desk-smoke.log 2>&1 || { cat /tmp/word-desk-smoke.log >&2; fail "静态冒烟未通过，禁止发布。"; }
echo "✓ 静态冒烟通过"

# ---------- 5. 推送 ----------
echo "→ 推送 main"
git push -q "$REMOTE" main || fail "推送 main 失败，线上未更新（检查网络/权限/是否领先远端）。"

echo "→ 更新 ${BRANCH}（GitHub Pages 从这里取站点）"
# 先接住退出码再判断输出：grep 不到字样不等于成功，网络/鉴权失败必须报错退出
if OUT=$(git subtree push --prefix dist "$REMOTE" "$BRANCH" 2>&1); then
  if printf '%s' "$OUT" | grep -q "Everything up-to-date"; then
    echo "✓ dist 没有变化，$BRANCH 无需更新"
  else
    echo "✓ $BRANCH 已更新"
  fi
else
  printf '%s\n' "$OUT"
  fail "$BRANCH 推送失败，线上站点未更新（main 已推送）。"
fi

echo
echo "站点：$SITE"
echo "（构建约需 30-60 秒，之后强刷浏览器才看得到）"

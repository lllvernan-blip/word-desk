#!/usr/bin/env bash
# 改完 dist 之后跑一条，把改动推上去并更新线上站点。
# 不改东西就不用跑；站点是静态的，不推也会一直开着。
#
# 用法：
#   ./deploy.sh            # 提交信息默认「更新站点」
#   ./deploy.sh "加了个词"  # 自定义提交信息
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-更新站点}"

if [ -z "$(git status --porcelain)" ]; then
  echo "工作区是干净的，没有要提交的改动。"
else
  git add -A
  git commit -q -m "$MSG"
  echo "✓ 已提交：$MSG"
fi

echo "→ 推送 main"
git push -q origin main && echo "✓ main 已推送"

echo "→ 更新 gh-pages（Pages 从这里取站点）"
if git subtree push --prefix dist origin gh-pages 2>&1 | grep -q "Everything up-to-date"; then
  echo "✓ dist 没有变化，gh-pages 无需更新"
else
  echo "✓ gh-pages 已更新"
fi

echo
echo "站点：https://lllvernan-blip.github.io/word-desk/"
echo "（构建约需 30-60 秒，之后强刷浏览器才看得到）"

# 单词翻译练习台（word-desk）

纯静态 PWA 单词学习应用，无构建步骤：`dist/` 里的文件就是全部源码，改完即生效。

- 线上地址：https://lllvernan-blip.github.io/word-desk/
- 托管：GitHub Pages，站点源分支为 `gh-pages`（内容等于 `dist/`），远端 `origin`
- 部署只走一个入口：`bash deploy.sh`（先提交、后发布；只校验 + 推送，不改文件）
- 本目录是唯一工作副本，没有备份，改动前想清楚；需要临时备份时复制到本目录以外并自行命名

## 文件结构（都在 dist/ 下）

| 文件 | 作用 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 主应用界面与逻辑 |
| `words.js` / `words-core.js` | 词库数据（`words-core.js` 由脚本生成，**勿手改**） |
| `roots-data.js` | 词根数据离线兜底（脚本生成，**勿手改**） |
| `content/` | 词库与词根的可热更新 JSON（manifest.json / roots.json / words-extra.json） |
| `audio/` | 发音包：`pack-00.bin`～`pack-72.bin` 共 73 个分片 + `index.json` 索引，约 66 MB。前端按词查索引、用 HTTP Range 只取该词那几 KB，不下载整包；**播过的词会按词存进 Cache Storage（`wtp-audio-v{index.v}`），断网重载后仍可播放** |
| `sw.js` | Service Worker，当前缓存版本 `wtp-shell-v66` |
| `manifest.webmanifest` / `icons/` | PWA 清单与图标 |
| `../tools/build-audio-bundles.py` | 把零散 mp3 打成 `audio/` 分片 + 索引（仓库根目录，不属于站点资源） |

## 数据与路径约定

- 词条主键一律用小写词形（`lower`）：`userWords` 的 `lower`、`srs` 的 `word` 都是小写，自建词/内置词/远端词库同口径，不要新引入保留原样大小写的主键。
- 备份只含学习进度（设置、复习记录、错题本、每日统计、自建词条），**不含**扩展词包内容与短期埋点事件；`BACKUP_SCHEMA` 与库名 `wtp.db.v3` 一并钉死，不要改。
- 站点路径固定 `/word-desk/`：仓库名不改、不改成根路径部署，`manifest.webmanifest`、`sw.js` 的 CORE 与全站相对路径都按这个前缀。

## 发音包构建流程

音频不进版本库的散装形态，发布前必须是「73 个分片 + index.json」。改词库或换声库后按顺序执行：

1. `python3 tools/build-audio-pronunciation.py --from-dist dist --out _archive/output-20261105/pronunciation-ab/audio-ljspeech --voice ljspeech-medium`（`--out` 只是本地中间产物目录，已被 `.gitignore` 覆盖，不必入库）
2. 把生成的 mp3 复制进 `dist/audio/`
3. `python3 tools/build-audio-bundles.py`（默认每 200 词一片，自动删掉散装 mp3）

> 注意：全量重建只读取内置词表，会把扩展词音频从索引中移除；扩展词音频请用 `tools/merge-audio-packs.py` 追加，不要直接全量重建。

为什么不分 3400 个文件：文件数太多时静态托管同步慢、容易发布失败。分片后前端用 Range 取单词字节，首次播放仍是一个几 KB 的请求。站点若不支持 Range（本地 `python3 -m http.server` 就是），前端会自动退回「下载整包再切片」，结果一致但慢，只用于本地调试。

## 修改规则

1. 只在本目录的 `dist/` 里改，不要新建平行副本
2. 改了任何静态资源（html/css/js/json）后，必须把 `sw.js` 里的 `CACHE = 'wtp-shell-vNN'` 版本号递增（当前 v66），否则用户端会一直拿旧缓存；`audio/` 的分片走 Range 请求、不经 Service Worker 缓存，但**重建音频包时必须让 `index.json` 的 `v` 递增**（词缓存名跟着 `v` 走，旧缓存会自动清掉），否则老客户端会拿旧索引按旧偏移切新分片
3. 改完先本地验证：`python3 -m http.server 8000 --directory dist`，浏览器打开 http://localhost:8000 检查主流程
4. 改动完成后：`git add <具体路径>`（不要 `git add -A`）→ `git commit -m "上线：..."` → `bash deploy.sh`；脚本只校验并推送，不做提交。只想自检用 `DRY_RUN=1 bash deploy.sh`
5. 发布前确认没有其他 agent 正在同时改这个目录，且工作区已提交干净（deploy.sh 会拦截脏工作区）

## 仓库内容边界

只提交项目文件本身；过程文件与 AI 工具沉淀留在本地。判据一句话：**换台机器、换个人接手，这文件还是项目的一部分吗？** 不是就别进仓库。

**该进**：`dist/`（发布源）、`docs/`、`tools/`、`deploy.sh`、`README.md`、`AGENTS.md`、`NOTICE.md`、`.gitignore`。

**不该进**：`.workbuddy/`、`.trae/`、`.qoder*` 及其他 IDE/助手的工作记忆与配置、`_archive/`（review 快照、导出的 docx/html、实验页面）、`_vendor/`、临时脚本、日志、`.DS_Store`、本地数据。

**操作**：
1. 提交前先看 `git status`；
2. 用 `git add <具体路径>`，**不要用 `git add -A`**（它会把工作区里冒出来的过程文件一起带上）；
3. 发现已跟踪的无关文件：`git rm --cached <路径>`（本地文件保留），再确认 `.gitignore` 有对应规则。

**坑**：`.gitignore` 只对**未跟踪**文件生效。文件一旦进过索引，后补的规则对它无效；而 `git check-ignore` 对被跟踪文件返回空，看起来像"规则已经生效"，实际没有——必须先 `git rm --cached`，`check-ignore` 才会命中。

**风险**：本仓库是 public。误提交的内容会留在历史 commit 里，取消跟踪只保证"以后不再带"，抹不掉历史（彻底清除要重写全部 commit hash 并 force push）。

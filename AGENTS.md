# 单词翻译练习台（word-desk）

纯静态 PWA 单词学习应用，无构建步骤：`dist/` 里的文件就是全部源码，改完即生效。

- 线上地址：https://word-desk-wj5xjfitwy0.qoder.website（站点 slug：`word-desk`，访问范围：公开）
  - 2026-11-04 因原站点绑定丢失、原账号下查不到任何站点，已在当前账号新建站点；旧地址 `https://word-desk-zrapaqv5fxl.qoder.zone` 已 404，不要再引用
- 本目录通过隐藏文件 `.单词翻译练习台.qoder.site` 绑定线上站点，**不要改动或删除这个文件**；该文件由 `prepare_site` 生成，丢失后需用同一 action 重新准备草稿恢复，不要手写
- 本目录是唯一工作副本，没有备份，改动前想清楚；需要临时备份时复制到本目录以外并自行命名

## 文件结构（都在 dist/ 下）

| 文件 | 作用 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 主应用界面与逻辑 |
| `words.js` / `words-core.js` | 词库数据（`words-core.js` 由脚本生成，**勿手改**） |
| `roots-data.js` | 词根数据离线兜底（脚本生成，**勿手改**） |
| `content/` | 词库与词根的可热更新 JSON（manifest.json / roots.json / words-extra.json） |
| `audio/` | 发音包：`pack-00.bin`～`pack-16.bin` 共 17 个分片 + `index.json` 索引，约 14.6 MB。前端按词查索引、用 HTTP Range 只取该词那几 KB，不下载整包；**播过的词会按词存进 Cache Storage（`wtp-audio-v{index.v}`），断网重载后仍可播放** |
| `sw.js` | Service Worker，当前缓存版本 `wtp-shell-v54` |
| `manifest.webmanifest` / `icons/` | PWA 清单与图标 |
| `../tools/build-audio-bundles.py` | 把零散 mp3 打成 `audio/` 分片 + 索引（仓库根目录，不属于站点资源） |

## 发音包构建流程

音频不进版本库的散装形态，发布前必须是「17 个分片 + index.json」。改词库或换声库后按顺序执行：

1. `python3 _archive/output-20261105/pronunciation-ab/generate.py --from-dist dist --out _archive/output-20261105/pronunciation-ab/audio-ljspeech --voice ljspeech-medium`
2. 把生成的 mp3 复制进 `dist/audio/`
3. `python3 tools/build-audio-bundles.py`（默认每 200 词一片，自动删掉散装 mp3）

为什么不分 3400 个文件：文件数太多时静态托管同步慢、容易发布失败。分片后前端用 Range 取单词字节，首次播放仍是一个几 KB 的请求。站点若不支持 Range（本地 `python3 -m http.server` 就是），前端会自动退回「下载整包再切片」，结果一致但慢，只用于本地调试。

## 修改规则

1. 只在本目录的 `dist/` 里改，不要新建平行副本
2. 改了任何静态资源（html/css/js/json）后，必须把 `sw.js` 里的 `CACHE = 'wtp-shell-vNN'` 版本号递增（当前 v54），否则用户端会一直拿旧缓存；`audio/` 的分片走 Range 请求、不经 Service Worker 缓存，但**重建音频包时必须让 `index.json` 的 `v` 递增**（词缓存名跟着 `v` 走，旧缓存会自动清掉），否则老客户端会拿旧索引按旧偏移切新分片
3. 改完先本地验证：`python3 -m http.server 8000 --directory dist`，浏览器打开 http://localhost:8000 检查主流程
4. 改动完成后：Qoder 里的 agent 使用 sites-hosting 流程直接发布；非 Qoder 工具的 agent 只改文件，由用户回到 Qoder 说「发布」完成同步
5. 发布前确认本次会话没有其他 agent 正在同时改这个目录，避免互相覆盖

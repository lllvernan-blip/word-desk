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
| `sw.js` | Service Worker，当前缓存版本 `wtp-shell-v25` |
| `manifest.webmanifest` / `icons/` | PWA 清单与图标 |

## 修改规则

1. 只在本目录的 `dist/` 里改，不要新建平行副本
2. 改了任何静态资源（html/css/js/json）后，必须把 `sw.js` 里的 `CACHE = 'wtp-shell-vNN'` 版本号递增（当前 v25，下次改完写 v26…），否则用户端会一直拿旧缓存
3. 改完先本地验证：`python3 -m http.server 8000 --directory dist`，浏览器打开 http://localhost:8000 检查主流程
4. 改动完成后：Qoder 里的 agent 使用 sites-hosting 流程直接发布；非 Qoder 工具的 agent 只改文件，由用户回到 Qoder 说「发布」完成同步
5. 发布前确认本次会话没有其他 agent 正在同时改这个目录，避免互相覆盖

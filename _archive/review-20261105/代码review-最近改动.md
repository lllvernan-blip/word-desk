# 代码 review · 最近一批改动（2026-11-05）

审查范围：`dist/app.js`（+640 行）、`dist/index.html`、`dist/styles.css`、`dist/sw.js`、新增 `dist/content/sensitive.json`；另含 `output/` 归档删除。
方式：只读静态审查 + 音频索引数据校验（未运行应用、未写入任何数据）。

## 结论先行

**没有阻断级问题，可以发布；但不建议「直接发布」——建议先修 2 条高危，再发。**

发布前建议必须修：

1. **听音 0.8× 语速失效**（`playListenAudio` 没传 rate）
2. **被屏蔽/被下架的词能从「错题本」复活**（`buildQueue('wrong')` 与单题重练绕过了黑名单）

可选一并修（体验类，不阻塞发布）：3、4、5。

---

## 问题清单（按严重度）

### 高

**H1. 听音拼写 0.8× 语速完全失效【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L2610-L2615)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L4210-L4222)
- 问题：`playListenAudio` 改成直接调用 `playAudioFile(card.word.word)`，丢掉了原来 `{ rate: settings.listenRate }` 参数；`playAudioFile(word, rate)` 里 rate 为 `undefined`，`startAudioEl` 一律回落 1.0×。语速按钮只改了 `settings.listenRate` 并重新播一遍，实际仍是 1.0×。
- 触发：听音卡点「0.8×」再播放。
- 建议：`playAudioFile(card.word.word, settings.listenRate)`；`playViaWebAudio` 的 rate 同源透传。

**H2. 屏蔽词/高危剔除词可从错题本复活【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L2051)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L4292-L4293)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L1658-L1668)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L3089-L3116)
- 问题：`buildQueue('wrong')` 用 `findWord(...) || makeWord(x, 'user')`，`startSessionForWord` 同样有 `makeWord` 兜底；这两条路径都不检查 `isHiddenWord`。`blockCurrentWord` 也没把词从 `wrongBook` 移除，`renderWrong` 不做过滤。结果：用户点「别出现」后，词从词库消失，但错题本列表仍显示它，点「重练」还能完整练一遍；适配 sensitive.json 的 removed 词同理。
- 触发：屏蔽任意一个此前答错过的词 → 进「错题本」查看/重练。
- 建议：`renderWrong`、`buildQueue('wrong')`、`startSessionForWord` 三处都先过 `isHiddenWord`；屏蔽时同步 `wrongBook` 剔除并 `saveWrong()`。

### 中

**M1. 渲染函数里把「方向回退」写进持久化设置【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L1382-L1400)（由 [renderPickerState](file:///Users/nan/Documents/word-desk/dist/app.js#L1421) 调用）
- 问题：`syncListenAvailability` 在 `canListen` 为假时直接 `settings.direction = 'en2zh'` 并 `saveSettings()`。它挂在 `renderPickerState` 上，几乎每次渲染都会跑；因此音频索引加载失败、或「面板当前队列」无音频（但正在跑的 session 有音频）时，用户已选的听音偏好会被静默永久改掉。
- 触发：断网/索引加载失败后进设置页；或会话中途切筛选条件到无音频词集。
- 建议：渲染函数只更新 UI 可用态，不改持久化偏好；方向回退放在 `startSession` 里一次性决定，并只在用户真正开始时提示。

**M2. 5 秒预取超时会重渲染，清空用户已输入的答案【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L2567-L2579)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L2592-L2608)、[listenHTML 输入框](file:///Users/nan/Documents/word-desk/dist/app.js#L2418)
- 问题：进入听音卡 5 秒拿不到音频就 `handleListenFailure` → `renderSession()` 整块重绘。`#recallInput` 没有 `value` 回填，输入内容只在提交时写进 `card.recallTyped`，所以用户边听边打的字会被清空，焦点也跳到新输入框。
- 触发：弱网/首次未缓存，进入卡片 5 秒后开始打字。
- 建议：降级时只改 `card.listenFailed` 并局部插入音标/字母提示，不整页重绘；或重绘前保存并回填输入值。

**M3. 首屏在绑定事件前 `await` 89KB 音频索引，且无超时【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L4382-L4386)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L433-L450)
- 问题：`await loadAudioIndex()` 完成后才 `bindEvents()`，`loadAudioIndex` 的 fetch 没有超时/兜底竞速。索引慢或挂住时，页面看得见但所有按钮都没反应，也没有任何 loading 提示。
- 触发：首次访问（SW 未接管）且网络慢/被 CDN 卡住。
- 建议：先 `bindEvents` 再后台拉索引（缺索引时听音入口按不可用展示），或 `Promise.race` 2~3 秒超时。

**M4. `AUDIO_BROKEN` 只按词记忆、不跟音频包版本、清理缓存也不重置【已确认】**
- 位置：[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L295-L307)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L2628)、[app.js](file:///Users/nan/Documents/word-desk/dist/app.js#L390-L405)
- 问题：一次 `decode` 失败就把词永久写进 localStorage（最多 200 条），键不含 `index.v`；`clearAudioCache` 清了 Cache Storage 却不清这份名单，音频包重建后这些词依旧永远拿不到听音卡。另外 `clearAudioCache` 撤销 blob URL 时若正好在播，随后的 `onerror` 也会被记成 decode。
- 触发：一次瞬时解码失败/坏缓存，之后即使修好音频也不恢复。
- 建议：键改成 `${idx.v}:${key}`，或索引版本变化时清空；`clearAudioCache` 同时清空该名单；`decode` 只在多次失败后记账。

**M5. 选项池不足时可能只剩 1~3 个选项，答案直接暴露【逻辑已确认，触发需实测】**
- 位置：[buildChoices](file:///Users/nan/Documents/word-desk/dist/app.js#L2714-L2739)、[choiceHTML](file:///Users/nan/Documents/word-desk/dist/app.js#L2280-L2286)
- 问题：新增的「排除近义 + 编辑距离≤2」会进一步压缩候选；`best` 最多 3 个，没有「凑不满再放宽」的二次兜底。`libMode=user` 且自建词库只有 1~4 个词时（或用户批量屏蔽后），`options` 会退化成 1~2 个，其中唯一选项就是正确答案。`renderPickerState` 的「命中词少于 4 个」提示说的是筛选命中数，与实际选项池无关，会误导。
- 触发：自建词库很小 / 大量屏蔽 / 近义词集中的词表。
- 建议：第一轮严格筛选后若 `best.length < 3`，第二轮只保留安全池（`isDistractorSafe`），放宽近义与拼写限制；`options.length === 1` 时改为纯拼写题，不展示选项。

### 低

**L1. CSS 变量 `--text` 不存在【已确认】**
- [styles.css L1845](file:///Users/nan/Documents/word-desk/dist/styles.css#L1845)：`.block-word-btn:hover { color: var(--text) }`，整站用的是 `--ink`。该声明被浏览器判无效，hover 文字色不变。改成 `var(--ink)` 即可。

**L2. 桌面端输入框也被放大到 16px，与提交说明矛盾【已确认】**
- [styles.css L344-L349](file:///Users/nan/Documents/word-desk/dist/styles.css#L344-L349) 基础规则由 14px 改为 16px（全局生效），而 [L2261-L2263](file:///Users/nan/Documents/word-desk/dist/styles.css#L2261-L2263) 的注释与上个提交写的是「只有 `pointer: coarse` 才 16px，窄桌面不跟」。实际桌面输入框整体变大 2px。
- 建议：二选一——基础规则回到 14px 只保留触屏覆盖，或删掉那条触屏重复规则并改注释统一认知。

**L3. 文案仍说「其余用系统朗读」，与「没有音频就走文字练习」自相矛盾【已确认】**
- [index.html L330](file:///Users/nan/Documents/word-desk/dist/index.html#L330)、[app.js L3397](file:///Users/nan/Documents/word-desk/dist/app.js#L3397)。用户导入后会被告知「将使用系统朗读」，但新逻辑已经彻底不走 TTS（听音卡直接降级为看音标/字母拼写）。建议改成「其余将改为文字练习」。

**L4. `content/sensitive.json` 未纳入 git【已确认】**
- `git status` 显示 `?? dist/content/sensitive.json`（还有 `?? _archive/`）。它已写进 SW 的 CORE，若按 git 内容部署/回滚，会整条缺失（install 时 `cache.add` 静默失败，线上首启降级到内置 5 词）。发布前 `git add`。

**L5. AGENTS.md 已过时【已确认】**
- [AGENTS.md L19](file:///Users/nan/Documents/word-desk/AGENTS.md#L19)、[L36](file:///Users/nan/Documents/word-desk/AGENTS.md#L36) 仍写缓存版本 v37（实际 v41）；L27 的音频重建步骤指向 `output/pronunciation-ab/generate.py`，该目录已整体归档到 `_archive/output-20261105/pronunciation-ab/`。后续换声库会照着文档找不到脚本。

**L6. 新增提示用了未定义的 class**
- [app.js L2553](file:///Users/nan/Documents/word-desk/dist/app.js#L2553) 的 `audio-gate-note` 在 styles.css 里没有规则，只借了 `hint-line`。不影响功能，样式想单独调时再加。

**L7. 受屏蔽词影响的统计口径**
- 汇总页「到期 N 个词」直接数 `srsMap`，已屏蔽词仍计入（[app.js L2645](file:///Users/nan/Documents/word-desk/dist/app.js#L2645)）。数字与「实际会出现的词」不一致，属于口径问题，不影响练习。

**L8. 每次面板渲染都重复构建整队【已确认，性能】**
- `renderPickerState` 内 `pickerPlan()` 与 `planHasOfflineAudio()` 各调一次 `buildQueue('review','all',false)`，而 `buildQueue` 里每个到期词都要线性 `findWord`；搜索框逐字触发渲染时会有可感知的卡顿风险。可缓存一份「今日队列」供面板与听音判断共用。

---

## 已验证没问题的点（避免重复排查）

- **分片切片边界**：对全部 3400 个词校验过 `offset + length ≤ pack 大小`、同包内无重叠无空洞（0 异常）；`from/to` 计算与 `Blob.slice` 一致。`206 + 缺 Content-Range + 长度刚好` 的兜底成立；`200 整包`、`206 带 Content-Range`、`数据不够切` 三种分支都返回 null 而不是静默空音频，不会把坏字节喂给解码器。
- **缓存键与版本**：词缓存名 `wtp-audio-v{index.v}`，`pruneAudioCaches` 会删其它版本；`audio/index.json` 在 SW 里是网络优先（不是缓存优先），重建音频不会立刻被旧索引锁死。SW activate 只清 `wtp-shell-*`，与音频缓存不冲突。
- **SW 预缓存**：新增的 `sensitive.json`、`audio/index.json` 已加入 CORE，未发现漏缓存的新文件；旧 shell 缓存会被正确删除。
- **播放态**：`.is-playing` 在 `renderSession`、`showView`、`blur`、`pagehide`、`visibilitychange`、`pointercancel`、以及每个播放 promise 的 `finally` 上都有清理；8 秒兜底只移除 class、不停止播放，**不会切断长词**。剩余缺口仅限「同一词快速连点两次」：`startAudioEl` 复用同一个 Audio 元素并重绑 `onended`，第一次的 promise 永远不 settle（属于既有实现，非本批引入），表现只是绿色最多亮 8 秒后消失，可用真机确认。
- **移动端 16px 覆盖**：`text/search/number/url/无 type/textarea/select/.answer-input` 均已覆盖；`overflow-x: clip` 在 Safari 16+ 生效，更老版本忽略该声明、不产生副作用。
- **敏感词数据结构**：`sensitive.json` 的 `removed`（5 个）与 `words` 里的 `removed:true` 一致，字段可人工增删；`isDistractorSafe` 同时看词头清单与中文释义正则，`buildChoices` 确实只从安全池取选项。

## 发布建议

- 若只求「能发」：先修 H1、H2 即可发；M1/M2/M3/M4 建议随下一批一起修（都是可复现的用户可感知问题）。
- 发版流程注意：`sw.js` 已是 v41，如果修完上述问题再改静态资源，记得继续递增；`audio/index.json` 未重建（`v` 仍为 1），本批无需处理；发布前把 `dist/content/sensitive.json` 加入版本库。

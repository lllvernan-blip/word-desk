# word-desk · 剩余工程 Play（交别处执行）

> 基线：本文所有路径均相对仓库根目录；HEAD 以落盘时 `git rev-parse --short HEAD` 为准（撰写时约 `132992d`），SW `wtp-shell-v56`。  
> 约束：只改约定范围；动 `dist/` 静态资源按 `AGENTS.md` 升 `CACHE`；**不提交 / 不发布**，除非负责人明确要求。  
> ECDICT 唯一来源：钉死 **`ecdict.csv` 原表**（不是 `words-core.js` 里已翻译成中文的 examTags），sha256 前缀 `d1ecbdf9ee2b920a`；加词只改筛选再生成，不手贴。  
> 本文件是工程切片，不替代 `docs/版本规划.md` 的路线优先级。  
> Chief 不跑大工程；本文件给人/他处执行。

---

## 0. 已完成（勿重做）

| 项 | 说明 |
|---|---|
| P0 缺陷 / 备份恢复 / 引导 / 隐私 / 空态 | 已在更早提交 |
| 冒烟+发布清单 | `docs/发布与冒烟清单.md` + `tools/smoke-static-check.sh` |
| 反馈震动 | 默认开、设置可关；**iOS Safari/PWA 无 Vibration API，无感不算缺陷** |
| 设置齿轮 | 顶栏日夜旁；`includeSpell` 默认开；`showExamples` 默认开（后台加载） |
| 导入弹窗 | `#importModal`；页内 `#importPanel` 已移除 |
| 例句占位渲染 | 仅 `showExamples && examples.length` 显示；`dist/content/examples.json` 现有 3,400 条，已与内置词量对齐；`showExamples` 默认开、后台加载不挡首屏 |

---

## 踩坑短列表（执行前先读）

1. **听音拼写依赖拼写开关**：`includeSpell === false` 时听音方向回落英译中（见 `dist/app.js` 中 `includeSpell` / `makeCard`）。关拼写测听音会「没了」，属预期。  
2. **iOS 震动**：网页/装机 PWA 通常无震；不要当成回归。  
3. **`examples.json` 现有 3,400 条**：与内置词量对齐，够 A.2 抽检；重生成时按词条 key 覆盖，勿删已覆盖的词。  
4. **扩展包音频**：改分片必须与 `dist/audio/index.json` 的 `v` **同批**发布；只升壳 CACHE 不够。  
5. **ECDICT 再分发**：对外发布扩展词表/音频前自行确认许可；本 play 不替代法务结论。  
6. **筛包数据源**：分层必须读钉死 CSV 的 **`tag` 英文字段**（`zk`/`gk`/`cet4`/`cet6`/`ky`/`ielts`/`toefl`/`gre` 等空格分隔）。`words-core.js` 里已是「考研」「高考」等中文展示标签，**不能**拿去当筛选用 tag。

---

## Play A · 本地预生成例句包（建议先做）

### A.1 目标

为约 3400 内置词生成情景例句，写入 `dist/content/examples.json`：

```json
{ "apple": ["I ate an apple after lunch."], "book": ["She opened the book on the desk."] }
```

前端已接：设置打开且有句才显示（核对页 / 结果页 / 词库卡）；无句不占位。`sw.js` CORE 已含 `./content/examples.json`。

### A.2 硬过滤（脚本必须拦）

- 句中须出现目标词（首版要求 **原词字面**，大小写不敏感；不做复杂词干还原）
- 英文词数约 **8–20**
- 单行、无中英混排、无明显乱码
- 不过滤则 **不写该 key**（不要留空数组占位）

人工/模型侧额外目标（脚本难全拦，试点时人眼看）：场景具体、用法正确、不堆超纲难词。

### A.3 Merge（钉死）

- 维护可选白名单文件（如 `tools/examples-keep.json`）：其中的词条 **永不被脚本覆盖**（人工精品）。  
- 其余词：质检通过的新句 **整 key 替换**（不追加堆多句，除非产品日后改需求）。  
- 质检失败：保留旧值（若有）或删除该 key，禁止写入空数组。

### A.4 步骤

1. 解析 `dist/words.js` + `dist/words-core.js` 得到 `(word, meaning, …)` 列表。  
2. 新增 `tools/build-examples.py`：词表输入；生成器可插拔（API / 外部 jsonl / stdin），**不绑定**厂商；实现 A.2 + A.3。  
3. **试点**：先 100 个高频词 → 人工抽 ≥20 条（须满足 A.2）→ 再全量。  
4. 改 `examples.json` 后按 `AGENTS.md` 递增 `wtp-shell-vNN`（已在 CORE）。  
5. 自测：开「显示情景例句」→ 有句词在核对页/结果页/词库卡可见；无句无空壳；关开关全无。

### A.5 明确不做

- 运行时云端生成  
- 指望 ECDICT `detail`（官方「待添加」，抽样为空）  
- 未质检大批句子直接当成品  
- 把旧样例当 A.2 验收通过证据  

### A.6 验收

- [ ] `examples.json` 合法 JSON；key 均为小写词形  
- [ ] 抽检 20 条满足 A.2（不要拿既有句子充数）  
- [ ] 白名单词未被覆盖  
- [ ] 开关开/关行为符合 A.4.5  
- [ ] CACHE 已递增；未擅自 commit / 发布  

---

## Play B · ECDICT 分层扩展包

### B.1 目标

- **默认小包**：维持现状约 3.4k（精选 400 + 核心约 3000）**带音频**。若要扩到更大默认包，须另附「选词口径」文档（词频阈值 / tag 并集），本 play **不**把「约 5k」当作已定口径。  
- **递进扩展包**（按需懒加载词表 + 音频）：四六级 / 考研 / 留学 / GRE。  
- **专八 / 考博**：ECDICT **无**专八、考博官方 tag → 仅作近似层，**UI 与生成脚本注释均须写「非官方大纲」**。

### B.2 层与 ECDICT `tag` 码（筛 CSV，勿筛 words-core）

| 产品层 | 筛 `ecdict.csv` 的 `tag` 字段（大小写不敏感，空格分词） | 备注 |
|---|---|---|
| 四六级 | `cet4` ∪ `cet6` | |
| 考研 | `ky` | 不是 words-core 里的中文「考研」 |
| 留学 | `ielts` ∪ `toefl` | 本 play **钉死**留学=雅思∪托福；若要加 `gre` 须另改需求 |
| GRE | `gre` | |
| 专八（近似） | `ky` ∪ `ielts` ∪ `toefl` | **非官方大纲** |
| 考博（近似） | 专八近似 ∪ `gre` | **非官方大纲** |

默认小包是否再并入部分高频无 tag 词：保持现状生成逻辑，本 play 不重定义，除非另附口径。

### B.3 步骤

1. 取得钉死版 `ecdict.csv`，校验 sha256 前缀 `d1ecbdf9ee2b920a`（记录命令输出）。  
2. `tools/` 增加筛选脚本：**只读 CSV `tag`/`frq`/`bnc` 等原字段** → 按 B.2 切层 → 输出扩展词表（`|` 行或 json **二选一贯彻**）。脚本头注释重复「专八/考博非官方」。  
3. 前端：可选加载扩展包；未下载不影响默认包与离线主路径。  
4. 音频：**懒加载**；打包可复用 `tools/build-audio-bundles.py`；**`index.json` 的 `v` 与分片同批**。  
5. UI：层名；专八/考博入口旁固定「非官方大纲」文案。加词只改筛选条件再跑脚本。

### B.4 明确不做

- 一次导入全量约 77 万词  
- 用手改大段 `words-core.js` 代替脚本  
- 用 words-core 中文 examTags 当筛选源  
- 无音频却宣称该层「离线听音」  

### B.5 验收

- [ ] 分层用的是 CSV tag 码，抽查一层与 B.2 一致（例如考研层含 `ky`、不含误用中文标签源）  
- [ ] 默认包可独立使用；扩展包可开关/加载  
- [ ] 专八/考博 UI + 脚本均含非官方说明  
- [ ] 音频同批；失败降级不白屏  
- [ ] 未擅自 commit / 发布  

---

## Play C · 真机冒烟（人点）

照 `docs/发布与冒烟清单.md` 勾「真机/手工」项。静态可先：

```bash
bash tools/smoke-static-check.sh
node --check dist/app.js && node --check dist/sw.js
```

---

## 建议顺序

**C（随时）→ A 试点 → A 全量 → B。**

---

## 给执行者的最低回报模板

1. 改了哪些路径  
2. CACHE 是否从几升到几；音频若动了，`index.json` 的 `v` 是否同批  
3. 怎么验、哪几条没验  
4. `git status`（确认未提交，除非负责人已下令）  

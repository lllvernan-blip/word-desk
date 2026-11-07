# 第三方来源与许可

本站点随附的词库、音频和构建流程中使用了以下第三方成果。逐项列明来源、许可证和用途；凡不属于本站自有的部分，版权归原作者。

## 一、随站点分发的第三方数据

### ECDICT

- 项目：ECDICT — Free English to Chinese Dictionary Database
- 地址：https://github.com/skywind3000/ECDICT
- 许可证：MIT License，Copyright (c) 2025 Linwei（已核对仓库 LICENSE 原文）
- 本站用到的部分：
  - `dist/words-core.js` — 内置核心词库，取自 ECDICT 快照 `d1ecbdf9ee2b920afb6f430ca6b6bb9f`（770,611 行），选词口径为 frq/bnc 最小非零排名
  - `dist/content/extension/*.json` — 六个扩展词库，按 ECDICT 的 `tag` 字段切分：
    - `cet46` = tag `cet4+cet6`
    - `kaoyan` = tag `ky`
    - `gre` = tag `gre`
    - `abroad` = tag `ielts+toefl`
    - `tem8` = tag `ielts+ky+toefl`
    - `phd` = tag `gre+ielts+ky+toefl`
  - 单词的中文释义、音标、词性、BNC/当代语料库词频、考试标签，均来自 ECDICT

ECDICT 的 MIT 许可证要求保留版权声明和许可声明。本文件即为该声明，完整许可文本见上述仓库。

## 二、随站点分发的音频

`dist/audio/pack-*.bin` 共 73 个包、约 65 MB，为单词发音音频，由下列工具和声库在构建期离线生成。

### 合成引擎：Piper

- 项目：Piper TTS
- 地址：https://github.com/rhasspy/piper （现行维护仓库为 https://github.com/OHF-Voice/piper1-gpl）
- 许可证：构建期使用的 `piper1-gpl` 分支为 **GPL-3.0**
- 使用方式：**仅在本机作为构建工具运行，不随站点分发，也不作为站点运行时的依赖。** 站点只包含它输出的音频文件，不包含引擎代码。

### 声库：en_US-ljspeech-medium

- 来源：https://huggingface.co/rhasspy/piper-voices （`en_US/en_US-ljspeech/medium`）
- 许可证：与 piper-voices 仓库一致（MIT）
- 参数：en_US、单说话人、medium 音质、22,050 Hz

### 声库训练数据：LJ Speech Dataset

- 地址：https://keithito.com/LJ-Speech-Dataset/
- 许可证：**Public Domain**（依据声库自带的 MODEL_CARD.txt）
- 说明：LJSpeech 的公共领域状态指的是训练数据集本身；声库模型文件的许可由发布方（piper-voices）决定，不因训练数据是公共领域而自动变为公共领域。

## 三、不属于第三方、由本项目自行生成的部分

以下数据由本项目自己的处理管线生成，不引用外部词库的许可义务，但其中词条仍源自 ECDICT（见第一节）：

- `dist/content/roots.json`、`dist/roots-data.js` — 词根释义与切分结果，来源为 `roots_curated.json` + `words_segmented.json` + `rules.json`
- `dist/content/examples.json` — 例句
- `dist/content/sensitive.json` — 屏蔽词表
- `dist/content/words-extra.json` — 补充词条
- `dist/icons/*.png` — 应用图标
- `dist/app.js`、`dist/styles.css`、`dist/index.html` — 应用代码与样式

## 四、未使用的第三方代码

本站前端无任何第三方 JavaScript 或 CSS 依赖，没有 CDN 引用，构建产物中不含 node_modules 或打包器运行时。

## 五、构建期工具（不随站点分发）

`tools/` 下的 Python 脚本使用了以下依赖，仅在本机生成数据时运行：

- `piper-tts`、`lameenc` — 音频合成与编码
- 构建流程详细说明见 `tools/build-audio-bundles.py` 与 `tools/build-examples.py` 的文件头注释

---

如需联系或认为此处标注有遗漏、错误，请提 issue。

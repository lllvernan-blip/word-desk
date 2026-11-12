/* =========================================================
   单词翻译练习台 · 应用逻辑
   纯静态、无依赖；数据存 IndexedDB（不可用时降级 localStorage）
   ========================================================= */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const CONFIG = {
  contentUrl: './content/manifest.json',
  pageSize: 24,
  maxEvents: 1200,
  version: '2026.11.12.2',
  /* 「不需要」上报端点：留空 = 不发任何请求（默认）。
     拿到 webhook 后把地址填在这里即可生效，无需改其它代码。 */
  markReportUrl: ''
};

/* 功能开关：听音拼写已恢复，但只对 audio/index.json 里真实存在的词开放；
   没有离线音频的词一律走文字练习，绝不用语音合成凑发音。 */
const FEATURES = {
  listenDictation: true
};

const LS_PREFIX = 'wtp.ls.';
const DB_NAME = 'wtp.db.v3';

/* ---------- 通用工具 ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalizeEnglish = (s) => String(s || '').toLowerCase().replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').trim();
const normalizeChinese = (s) => String(s || '').replace(/[\s，,。；;、！!？?：:…·"'（）()【】[\]]/g, '');
const percent = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function splitMeanings(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[；;]/).map((x) => x.trim()).filter(Boolean);
}
function splitTokens(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
}
function normAffix(token, type) {
  let t = String(token || '').trim().toLowerCase();
  if (!t) return '';
  if (type === 'prefix') return t.endsWith('-') ? t : t + '-';
  if (type === 'suffix') return t.startsWith('-') ? t : '-' + t;
  return t;
}

/* 情景例句：词条自带 examples / 可选 content/examples.json 旁路；无句不渲染 */
function normalizeExamples(raw) {
  if (raw == null || raw === '') return [];
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? [s] : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  }
  return [];
}

const EXAMPLE_BANK = { loaded: false, map: new Map() };

async function loadExamplesContent() {
  try {
    const res = await fetch('./content/examples.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const map = new Map();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      Object.keys(data).forEach((k) => {
        const key = normalizeEnglish(k);
        const list = normalizeExamples(data[k]);
        if (key && list.length) map.set(key, list);
      });
    }
    EXAMPLE_BANK.map = map;
    EXAMPLE_BANK.loaded = true;
  } catch (e) {
    // 懒加载失败当无句：不阻塞主流程
    EXAMPLE_BANK.map = new Map();
    EXAMPLE_BANK.loaded = false;
  }
}

function wordExamples(w) {
  if (!w) return [];
  const own = normalizeExamples(w.examples);
  if (own.length) return own;
  const k = wordKey(w);
  if (!k) return [];
  const bank = EXAMPLE_BANK.map.get(k);
  return bank && bank.length ? bank.slice() : [];
}

function examplesHTML(w) {
  // 开关关永不显示；开且无数据不占位
  if (!settings.showExamples) return '';
  const list = wordExamples(w);
  if (!list.length) return '';
  return `<div class="examples-block" aria-label="情景例句">${list.map((s) => `<p class="example-line">${esc(s)}</p>`).join('')}</div>`;
}

function makeWord(raw, origin) {
  if (typeof raw === 'string') {
    const parts = raw.split('|');
    const confNum = parts[8] == null || parts[8] === '' ? null : Number(parts[8]);
    return makeWord({
      word: parts[0], meaning: parts[1], pos: parts[2],
      prefixes: parts[3], suffixes: parts[4], phonetic: parts[5],
      freqRank: parts[6], examTags: parts[7],
      confidence: Number.isFinite(confNum) ? confNum : null
    }, origin);
  }
  raw = raw || {};
  const word = String(raw.word || '').trim();
  if (!word) return null;
  // 预留 ECDICT 字段：音标 / 词频 / 考试标签 / 词形变化（缺失时保持空值，不报错）
  const freqRaw = raw.freqRank != null ? raw.freqRank : (raw.frequency != null ? raw.frequency : raw.bnc);
  const freqRank = freqRaw === '' || freqRaw == null || isNaN(Number(freqRaw)) ? null : Number(freqRaw);
  const conf = raw.affixConfidence && typeof raw.affixConfidence === 'object' ? raw.affixConfidence : null;
  return {
    word,
    lower: word.toLowerCase(),
    meanings: splitMeanings(raw.meanings || raw.meaning || raw.zh || raw.cn || raw.translation),
    pos: splitTokens(raw.pos || raw.partOfSpeech || raw.part_of_speech),
    prefixes: splitTokens(raw.prefixes || raw.prefix).map((t) => normAffix(t, 'prefix')).filter(Boolean),
    suffixes: splitTokens(raw.suffixes || raw.suffix).map((t) => normAffix(t, 'suffix')).filter(Boolean),
    phonetic: String(raw.phonetic || raw.ipa || '').trim(),
    freqRank,
    examTags: splitTokens(raw.examTags || raw.exam || raw.tags),
    lemma: String(raw.lemma || '').trim(),
    exchange: raw.exchange == null ? '' : String(raw.exchange).trim(),
    affixConfidence: conf,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    origin: raw.origin || origin || 'user',
    source: raw.source || origin || 'user',
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    examples: normalizeExamples(raw.examples != null ? raw.examples : raw.example)
  };
}

/* 词缀拆解置信度：数据可显式提供，否则按词缀歧义程度估算。
   低置信度（<0.75）只展示拆解，不进入“猜义”提问。 */
const AMBIGUOUS_PREFIXES = new Set(['re-', 'de-', 'ex-', 'in-', 'co-', 'per-', 'pro-', 'sub-', 'bi-', 'se-', 'para-']);
const AMBIGUOUS_SUFFIXES = new Set(['-y', '-al', '-er', '-or', '-en', '-ic', '-ly', '-ant', '-ent', '-ate', '-ish']);
const AFFIX_MIN_CONF = 0.75;

function affixScore(word, token, type) {
  if (word.affixConfidence && typeof word.affixConfidence[token] === 'number') return word.affixConfidence[token];
  if (!AFFIX_INFO[token]) return 0.4;
  if (type === 'prefix') return AMBIGUOUS_PREFIXES.has(token) ? 0.55 : 0.88;
  return AMBIGUOUS_SUFFIXES.has(token) ? 0.6 : 0.85;
}

function wordConfidence(word) {
  if (typeof word.confidence === 'number') return word.confidence;
  const parts = splitAffixes(word);
  if (!parts.prefix.length && !parts.suffix.length) return 0;
  const scores = [];
  parts.prefix.forEach((t) => scores.push(affixScore(word, t, 'prefix')));
  parts.suffix.forEach((t) => scores.push(affixScore(word, t, 'suffix')));
  return scores.length ? Math.min.apply(null, scores) : 0;
}

/* ---------- 本地数据层：IndexedDB，失败时降级 localStorage ---------- */
const DB = (() => {
  const stores = {
    userWords: { keyPath: 'lower' },
    srs: { keyPath: 'word' },
    events: { keyPath: 'id' },
    kv: { keyPath: 'key' }
  };
  let db = null;
  const mode = { current: 'idb' };

  function lsRead(store) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + store);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  /* 返回值必须可信：false = 没写进去（配额满/被隐私模式禁写），上层据此提示，不许静默 */
  function lsWrite(store, val) {
    try {
      localStorage.setItem(LS_PREFIX + store, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }
  function lsWriteOrThrow(store, val) {
    if (!lsWrite(store, val)) throw new Error('localStorage write failed');
  }
  /* IDB 写失败重试一次：首次失败常见于事务排队/连接被回收，第二次多半能过；再失败就抛给上层 */
  async function idbWrite(fn) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fn(); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('idb write failed');
  }
  function keyOf(store, val) {
    return store === 'kv' ? val.key : (store === 'userWords' ? val.lower : val.word);
  }

  function open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('idb timeout')), 2500);
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { clearTimeout(timer); reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        Object.keys(stores).forEach((name) => {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, stores[name]);
        });
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('idb error')); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('idb blocked')); };
    });
  }

  function tx(store, mode2) {
    const t = db.transaction(store, mode2);
    return t.objectStore(store);
  }
  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    mode,
    async init() {
      try {
        db = await open();
        mode.current = 'idb';
      } catch (e) {
        db = null;
        mode.current = 'ls';
      }
      return mode.current;
    },
    async all(store) {
      if (db) {
        try { return (await wrap(tx(store, 'readonly').getAll())) || []; }
        catch (e) { /* 读取失败时退回 LS */ }
      }
      const data = lsRead(store);
      if (!data) return [];
      if (Array.isArray(data)) return data;
      return Object.keys(data).map((k) => data[k]);
    },
    async put(store, val) {
      // db 存在就只写 IDB：失败重试一次，仍失败抛出由上层提示，绝不降级写 LS
      if (db) {
        return idbWrite(() => wrap(tx(store, 'readwrite').put(val)));
      }
      // db == null 已判定为 LS 模式，才写 localStorage
      if (store === 'events') {
        const arr = lsRead(store) || [];
        const i = arr.findIndex((x) => x && x.id === val.id);
        if (i >= 0) arr[i] = val; else arr.push(val);
        lsWriteOrThrow(store, arr.slice(-CONFIG.maxEvents));
        return;
      }
      const obj = lsRead(store) || {};
      obj[keyOf(store, val)] = val;
      lsWriteOrThrow(store, obj);
    },
    async del(store, key) {
      if (db) {
        return idbWrite(() => wrap(tx(store, 'readwrite').delete(key)));
      }
      const data = lsRead(store);
      if (!data) return;
      if (Array.isArray(data)) lsWriteOrThrow(store, data.filter((x) => x.id !== key));
      else { delete data[key]; lsWriteOrThrow(store, data); }
    },
    async clear(store) {
      if (db) {
        return idbWrite(() => wrap(tx(store, 'readwrite').clear()));
      }
      lsWriteOrThrow(store, store === 'events' ? [] : {});
    },
    async putMany(store, list) {
      for (const item of list) await this.put(store, item);
    }
  };
})();

/* ---------- 发音（系统 TTS） ---------- */
const VOICE = {
  status: 'unknown',   // unknown | ok | none | unsupported
  voice: null,
  unlocked: false,     // 是否已有一次由用户手势触发的成功播放
  cachedProbe: null,
  forced: false,
  ttsActive: false,    // 是否真的在播 TTS：避免听音路径无意义地调用 speechSynthesis
  lastError: ''
};

function speechSupported() {
  return typeof window.speechSynthesis !== 'undefined'
    && typeof window.SpeechSynthesisUtterance === 'function'
    && typeof window.speechSynthesis.speak === 'function';
}

/* 发音不可用时的一次性提示：同一类原因只弹一次，说明降级方式 */
const VOICE_HINTS = new Set();
const VOICE_HINT_TEXT = {
  unsupported: '发音不可用：这台浏览器不支持语音朗读，也没有离线音频。已改为先看音标拼写，没有音标就看词形拼写。',
  none: '发音不可用：系统里没有可用的英文语音。已改为先看音标拼写，没有音标就看词形拼写。',
  blocked: '发音被浏览器拦截（首次需先点一下页面）：已改为先看音标拼写，没有音标就看词形拼写。',
  error: '发音播放失败：已改为先看音标拼写，没有音标就看词形拼写。'
};
function reportVoiceFailure(reason) {
  let key = 'error';
  if (reason === 'unsupported') key = 'unsupported';
  else if (reason === 'none' || reason === 'no-voice') key = 'none';
  else if (reason === 'blocked' || reason === 'no-start' || reason === 'stalled') key = 'blocked';
  if (VOICE_HINTS.has(key)) return;
  VOICE_HINTS.add(key);
  toast(VOICE_HINT_TEXT[key]);
}

/* ---------- 离线发音包：分片存储 + 字节区间读取 ----------
   3400 个词全放在 audio/ 会变成 3400 个文件，静态托管同步慢且容易发布失败。
   所以切成多个 pack-XX.bin（每片约 200 词），index.json 记录每个词的 [包序号, 偏移, 长度]。
   播放某个词只发一个几 KB 的 Range 请求，不下载整包。
   音频由 Piper + LJSpeech 声库（public domain）预生成，构建脚本 tools/build-audio-bundles.py。 */
const AUDIO = {
  dir: './audio/',
  indexUrl: './audio/index.json',
  index: null,
  indexLoading: null,
  urls: new Map(),      // word -> objectURL，会话内复用
  loading: new Map(),   // word -> Promise<url|null>，避免同一个词并发重复请求
  els: new Map(),       // word -> Audio 元素
  current: null,
  waSource: null,
  ctx: null,
  seq: 0,               // 播放请求序号：切题/新播放时作废进行中的加载
  cacheName: null       // 当前音频包的 Cache Storage 名字（跟 index.v 走）
};

function audioKey(word) {
  return normalizeEnglish(word).replace(/[^a-z]/g, '');
}

/* 音频解码/取包失败过的词：记住不再重试，也不再生成听音卡 */
const AUDIO_BROKEN_KEY = 'wtp.audio.broken';
/* 失败名单按「音频包版本:词」记，音频包重建后旧记录自然失效 */
function audioBrokenKey(key) {
  const v = (AUDIO.index && AUDIO.index.v) || 1;
  return v + ':' + key;
}
const AUDIO_BROKEN = new Set((() => {
  try {
    const list = JSON.parse(localStorage.getItem(AUDIO_BROKEN_KEY) || '[]');
    return Array.isArray(list) ? list.filter((k) => typeof k === 'string').slice(-200) : [];
  } catch (e) { return []; }
})());
function markAudioBroken(key) {
  if (!key) return;
  const k = audioBrokenKey(key);
  if (AUDIO_BROKEN.has(k)) return;
  AUDIO_BROKEN.add(k);
  try { localStorage.setItem(AUDIO_BROKEN_KEY, JSON.stringify(Array.from(AUDIO_BROKEN).slice(-200))); } catch (e) { /* 隐私模式静默 */ }
}

/* 听音门槛：只有音频索引里真实存在、且没有失败记录的词才允许生成听音卡 */
function hasOfflineAudio(word) {
  const key = audioKey(typeof word === 'string' ? word : (word && word.word));
  return !!(key && AUDIO.index && AUDIO.index.words && AUDIO.index.words[key] && !AUDIO_BROKEN.has(audioBrokenKey(key)));
}

/* 取词音频，超时返回 null；用于进入听音卡时预取，不阻塞答题 */
function loadAudioWithTimeout(key, ms) {
  return Promise.race([
    loadAudioUrl(key),
    new Promise((resolve) => setTimeout(() => resolve(null), ms || 4000))
  ]);
}

/* 离线音频缓存：播过的词按词存进 Cache Storage，断网重载后仍可播放。
   缓存名跟 index.json 的版本号走，音频包重建后旧缓存自然作废。 */
const AUDIO_CACHE_PREFIX = 'wtp-audio-v';
function audioCacheName(v) { return AUDIO_CACHE_PREFIX + (Number(v) || 1); }
function audioCacheUrl(key) { return new URL('./audio/w/' + key, location.href).href; }

function audioCacheRead(name, key) {
  if (!('caches' in window)) return Promise.resolve(null);
  return caches.open(name)
    .then((c) => c.match(audioCacheUrl(key)))
    .then((r) => (r ? r.arrayBuffer() : null))
    .catch(() => null);
}

function audioCacheWrite(name, key, buf) {
  if (!('caches' in window) || !buf || !buf.byteLength) return;
  try {
    caches.open(name)
      .then((c) => c.put(audioCacheUrl(key), new Response(buf, { headers: { 'content-type': 'audio/mpeg' } })))
      .catch(() => {});
  } catch (e) { /* ignore */ }
}

/* 音频包版本变了：删掉旧的词缓存，别拿旧字节配新索引 */
function pruneAudioCaches(keep) {
  if (!('caches' in window)) return;
  caches.keys().then((names) => Promise.all(
    names.filter((n) => n.indexOf(AUDIO_CACHE_PREFIX) === 0 && n !== keep)
      .map((n) => caches.delete(n))
  )).catch(() => {});
}

/* 音频缓存统计：按 Cache Storage 里实际存过的词片段累加数量与字节 */
function formatBytes(n) {
  if (!n) return '0 B';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

async function readAudioCacheStat() {
  if (!('caches' in window)) return { count: 0, bytes: 0 };
  const names = (await caches.keys()).filter((n) => n.indexOf(AUDIO_CACHE_PREFIX) === 0);
  const items = [];
  for (const n of names) {
    const c = await caches.open(n);
    for (const req of await c.keys()) items.push([c, req]);
  }
  let bytes = 0;
  for (const [c, req] of items) {
    const r = await c.match(req);
    if (!r) continue;
    try { const b = await r.blob(); bytes += b.size; } catch (e) { /* ignore */ }
  }
  return { count: items.length, bytes };
}

async function refreshAudioCacheStat() {
  const el = $('audioCacheStat');
  if (!el) return;
  if (!('caches' in window)) { el.textContent = '当前浏览器不支持离线音频缓存'; return; }
  const s = await readAudioCacheStat();
  el.textContent = s.count
    ? '已缓存 ' + s.count + ' 个音频片段 · ' + formatBytes(s.bytes)
    : '暂无缓存，播过的词会自动缓存';
}

async function clearAudioCache() {
  if (!('caches' in window)) return;
  const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
  const msg = offline
    ? '当前处于离线状态：清理后离线将无法播放离线音频，确定清理？'
    : '清理后已缓存的词会重新按需下载，确定清理音频缓存？';
  if (!window.confirm(msg)) return;
  stopAudioFile(); // 先停播：revoke 正在播的 URL 会触发 onerror，被误记成 decode 失败
  const names = (await caches.keys()).filter((n) => n.indexOf(AUDIO_CACHE_PREFIX) === 0);
  await Promise.all(names.map((n) => caches.delete(n)));
  // 失败名单跟缓存同源，一起清掉
  AUDIO_BROKEN.clear();
  try { localStorage.removeItem(AUDIO_BROKEN_KEY); } catch (e) { /* ignore */ }
  // 内存里的 blob URL 也一起作废，下次播放重新取片
  AUDIO.urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
  AUDIO.urls.clear();
  AUDIO.els.clear();
  await refreshAudioCacheStat();
  toast('音频缓存已清理');
}


function stopAudioFile() {
  if (AUDIO.waSource) {
    try { AUDIO.waSource.stop(); } catch (e) { /* ignore */ }
    AUDIO.waSource = null;
  }
  if (!AUDIO.current) return;
  try { AUDIO.current.pause(); AUDIO.current.currentTime = 0; } catch (e) { /* ignore */ }
}

/* 播放态只靠显式 class，任何退出路径都统一清掉，避免按钮永久变绿 */
const PLAYING_CLASS = 'is-playing';
let playingTimer = null;
function clearPlayingState() {
  if (playingTimer) { clearTimeout(playingTimer); playingTimer = null; }
  document.querySelectorAll('.' + PLAYING_CLASS).forEach((b) => b.classList.remove(PLAYING_CLASS));
}
function setPlayingState(btn, ms) {
  clearPlayingState();
  const target = btn && btn.closest ? btn.closest('button') : null;
  if (!target) return;
  target.classList.add(PLAYING_CLASS);
  // 回调丢失时的上限：单词音频通常 < 3s，8s 兜底强拆
  playingTimer = setTimeout(clearPlayingState, ms || 8000);
}

function loadAudioIndex() {
  if (AUDIO.index) return Promise.resolve(AUDIO.index);
  if (!AUDIO.indexLoading) {
    AUDIO.indexLoading = fetch(AUDIO.indexUrl)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
      AUDIO.index = d;
      AUDIO.indexLoading = null;
      if (d) {
        const name = audioCacheName(d.v);
        if (AUDIO.cacheName !== name) { AUDIO.cacheName = name; pruneAudioCaches(name); }
      }
      return d;
    });
  }
  return AUDIO.indexLoading;
}

/* 取某个词的音频，返回 blob URL；失败返回 null。
   顺序：内存 -> Cache Storage（离线也能播播过的词）-> Range 取分片 -> 存 Cache。 */
function loadAudioUrl(key) {
  if (AUDIO_BROKEN.has(audioBrokenKey(key))) return Promise.resolve(null);
  if (AUDIO.urls.has(key)) return Promise.resolve(AUDIO.urls.get(key));
  if (AUDIO.loading.has(key)) return AUDIO.loading.get(key);
  const task = (async () => {
    // 缓存名跟着音频包版本（index.v）走，所以先拿到索引再查缓存；离线时索引走 SW 缓存
    if (!AUDIO.cacheName) await loadAudioIndex();
    const name = AUDIO.cacheName || audioCacheName(1);
    const cachedBuf = await audioCacheRead(name, key);
    if (cachedBuf) return toAudioUrl(key, cachedBuf);
    const idx = await loadAudioIndex();
    const slot = idx && idx.words ? idx.words[key] : null;
    if (!slot) return null;
    const pack = idx.packs[slot[0]];
    if (!pack) return null;
    const from = slot[1];
    const to = from + slot[2] - 1;
    try {
      const res = await fetch(AUDIO.dir + pack, { headers: { Range: 'bytes=' + from + '-' + to } });
      if (!res.ok) return null;
      let buf = await res.arrayBuffer();
      // 不依赖 Range 成功：iOS Safari / 某些 CDN 会忽略 Range 直接给 200 整包，
      // 也可能给 206 却缺失或写错 Content-Range。统一按 index.json 的 slot 定位后再切。
      const cr = res.headers.get('Content-Range');
      const crMatch = cr ? /bytes\s+(\d+)-(\d+)\//i.exec(cr) : null;
      let startsAt = null;
      if (res.status !== 206) startsAt = 0;                    // 200：拿到的是整包
      else if (crMatch) startsAt = Number(crMatch[1]);          // 206：按服务器声明的起点
      else if (buf.byteLength === slot[2]) startsAt = from;     // 206 缺 C-R 但长度刚好是一个词的
      if (startsAt === null) return null;
      const offset = from - startsAt;
      if (offset < 0 || buf.byteLength < offset + slot[2]) return null;
      buf = buf.slice(offset, offset + slot[2]);
      if (!buf || !buf.byteLength) return null;
      audioCacheWrite(audioCacheName(idx.v), key, buf); // 后台写，不阻塞这次播放
      return toAudioUrl(key, buf);
    } catch (e) { return null; }
  })().then((url) => {
    AUDIO.loading.delete(key);
    return url;
  }).catch(() => {
    AUDIO.loading.delete(key);
    return null;
  });
  AUDIO.loading.set(key, task);
  return task;
}

/* 内存里的 blob URL 只留最近 200 个，长时间使用不累积 */
function toAudioUrl(key, buf) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
  AUDIO.urls.set(key, url);
  if (AUDIO.urls.size > 200) {
    const first = AUDIO.urls.keys().next();
    if (!first.done) {
      const oldUrl = AUDIO.urls.get(first.value);
      try { URL.revokeObjectURL(oldUrl); } catch (e) { /* ignore */ }
      AUDIO.urls.delete(first.value);
    }
  }
  return url;
}

/* 渲染卡片时先把音频取到内存：点击时就不用等网络，play() 也不会丢用户手势 */
function prefetchAudio(word) {
  const key = audioKey(word);
  if (!key || AUDIO.urls.has(key) || AUDIO.loading.has(key)) return;
  loadAudioUrl(key);
}

function audioContext() {
  if (AUDIO.ctx) return AUDIO.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { AUDIO.ctx = new AC(); } catch (e) { return null; }
  return AUDIO.ctx;
}

/* 在点击的同步栈里调用，解锁 Web Audio，供等网络后仍能出声 */
function unlockAudio() {
  const ctx = audioContext();
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (e) { /* ignore */ }
  }
}

/* Safari 在 await 之后会拒绝 play()，这时用 Web Audio 播同一段字节 */
function playViaWebAudio(key, rate) {
  const seq = AUDIO.seq;
  const ctx = audioContext();
  if (!ctx) return Promise.resolve({ ok: false, reason: 'unsupported' });
  return loadAudioUrl(key).then((url) => {
    if (!url) return { ok: false, reason: 'no-file' };
    return fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => new Promise((resolve) => {
        const resume = ctx.state === 'suspended' ? ctx.resume().catch(() => null) : Promise.resolve();
        resume.then(() => {
          ctx.decodeAudioData(buf, (decoded) => {
            if (seq !== AUDIO.seq) { resolve({ ok: false, reason: 'stale' }); return; }
            try {
              const src = ctx.createBufferSource();
              src.buffer = decoded;
              src.playbackRate.value = Number(rate) === 0.8 ? 0.8 : 1;
              src.connect(ctx.destination);
              AUDIO.waSource = src;
              src.onended = () => { if (AUDIO.waSource === src) AUDIO.waSource = null; };
              src.start(0);
              resolve({ ok: true, source: 'webaudio' });
            } catch (e) {
              resolve({ ok: false, reason: 'error' });
            }
          }, () => resolve({ ok: false, reason: 'decode' }));
        });
      }));
  }).catch(() => ({ ok: false, reason: 'error' }));
}

function startAudioEl(key, url, rate) {
  return new Promise((resolve) => {
    stopAudioFile();
    let el = AUDIO.els.get(key);
    if (!el) {
      try { el = new Audio(); }
      catch (e) { resolve({ ok: false, reason: 'unsupported' }); return; }
      el.preload = 'auto';
      AUDIO.els.set(key, el);
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    el.onended = () => done({ ok: true, source: 'file' });
    el.onerror = () => done({ ok: false, reason: 'decode' });
    AUDIO.current = el;
    try { el.src = url; el.currentTime = 0; } catch (e) { /* ignore */ }
    try {
      el.defaultPlaybackRate = Number(rate) === 0.8 ? 0.8 : 1;
      el.playbackRate = el.defaultPlaybackRate;
    } catch (e) { /* ignore */ }
    let p;
    try { p = el.play(); }
    catch (e) { done({ ok: false, reason: 'blocked' }); return; }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => done({ ok: false, reason: 'blocked', error: err && err.name }));
    }
  });
}

function playAudioFile(word, rate) {
  const key = audioKey(word);
  if (!key) return Promise.resolve({ ok: false, reason: 'no-file' });
  const seq = ++AUDIO.seq;
  const cached = AUDIO.urls.get(key);
  const playback = cached ? startAudioEl(key, cached, rate) : loadAudioUrl(key).then((url) => {
    if (seq !== AUDIO.seq) return { ok: false, reason: 'stale' };
    if (!url) return { ok: false, reason: 'no-file' };
    return startAudioEl(key, url, rate);
  });
  return playback.then((r) => {
    if (seq !== AUDIO.seq) return { ok: false, reason: 'stale' };
    if (r.ok || r.reason !== 'blocked') return r;
    return playViaWebAudio(key, rate);
  });
}

function pickEnglishVoice(list) {
  const voices = Array.isArray(list) ? list : [];
  const en = voices.filter((v) => /^en([-_]|$)/i.test(String(v.lang || '')));
  return en.find((v) => /en[-_]us/i.test(v.lang)) || en.find((v) => /en[-_]gb/i.test(v.lang)) || en[0] || null;
}

function persistVoiceProbe() {
  saveKV('audioProbe', {
    status: VOICE.status,
    voice: VOICE.voice ? VOICE.voice.name : '',
    lang: VOICE.voice ? VOICE.voice.lang : '',
    at: Date.now()
  });
}

/* 等 voiceschanged：部分浏览器首次 getVoices() 为空，需要一次异步加载 */
function waitVoices(ms) {
  return new Promise((resolve) => {
    if (!speechSupported()) return resolve([]);
    const now = speechSynthesis.getVoices();
    if (now && now.length) return resolve(now);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(speechSynthesis.getVoices() || []);
    };
    try { speechSynthesis.addEventListener('voiceschanged', finish, { once: true }); } catch (e) { /* ignore */ }
    setTimeout(finish, ms || 1500);
  });
}

async function probeVoice() {
  if (!speechSupported()) {
    VOICE.status = 'unsupported';
    VOICE.voice = null;
    persistVoiceProbe();
    return VOICE.status;
  }
  const voices = await waitVoices(1500);
  VOICE.voice = pickEnglishVoice(voices);
  VOICE.status = VOICE.voice ? 'ok' : 'none';
  persistVoiceProbe();
  return VOICE.status;
}

function stopSpeaking() {
  AUDIO.seq += 1;      // 作废进行中的加载：慢网下切题后不该再响
  stopAudioFile();     // 切题/结束时离线音频也要停，不只停 TTS
  if (!speechSupported() || !VOICE.ttsActive) return;
  try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  VOICE.ttsActive = false;
}

/* 播放一个英文词；返回 { ok, reason }。reason: no-file/blocked/unsupported/no-voice/error/no-start/stalled
   有离线音频就用音频，没有才用系统 TTS。用户主动点播失败时给一次性提示，自动播放失败不打扰。 */
async function speakWord(text, opts) {
  const o = opts || {};
  unlockAudio(); // 必须在点击的同步栈里，否则等完网络 Web Audio 也发不了声
  const r = await playAudioFile(text);
  if (r.ok || r.reason === 'stale') return r;
  // 音频被拦或浏览器不支持时不再叠一层 TTS，避免两个声音同时响
  if (r.reason === 'blocked' || r.reason === 'unsupported') {
    if (!o.auto) reportVoiceFailure(r.reason);
    return r;
  }
  const t = await speakWithTTS(text, opts);
  if (!t.ok && !o.auto) reportVoiceFailure(t.reason);
  return t;
}

async function speakWithTTS(text, opts) {
  const o = opts || {};
  if (!speechSupported()) return { ok: false, reason: 'unsupported' };
  // 没有可用英文 voice 时明确失败，不拿中文 voice 糊弄过去
  if (!VOICE.voice) {
    let voices = speechSynthesis.getVoices() || [];
    if (!voices.length) voices = await waitVoices(800);
    VOICE.voice = pickEnglishVoice(voices);
    if (!VOICE.voice) {
      VOICE.status = 'none';
      persistVoiceProbe();
      return { ok: false, reason: 'no-voice' };
    }
  }
  return new Promise((resolve) => {
    stopSpeaking();
    let started = false;
    let settled = false;
    let timer = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      VOICE.ttsActive = false;
      resolve(r);
    };
    let u;
    try {
      u = new SpeechSynthesisUtterance(String(text || ''));
    } catch (e) {
      resolve({ ok: false, reason: 'error' });
      return;
    }
    u.lang = 'en-US';
    u.rate = Number(o.rate) === 0.8 ? 0.8 : 1;
    u.pitch = 1;
    u.volume = 1;
    u.voice = VOICE.voice;
    timer = setTimeout(() => settle({ ok: false, reason: started ? 'stalled' : 'no-start' }), 2500);
    u.onstart = () => {
      started = true;
      VOICE.unlocked = true;
      if (VOICE.status !== 'ok') { VOICE.status = 'ok'; persistVoiceProbe(); }
    };
    u.onend = () => settle({ ok: true });
    u.onerror = (ev) => {
      VOICE.lastError = (ev && ev.error) || 'error';
      settle({ ok: false, reason: 'error', error: VOICE.lastError });
    };
    try { VOICE.ttsActive = true; speechSynthesis.speak(u); }
    catch (e) { VOICE.lastError = 'exception'; settle({ ok: false, reason: 'error' }); }
  });
}

/* ---------- 词库与状态 ---------- */
/* 精选 400 词优先；ECDICT 核心包只补不覆盖（同名单词以 words.js 为准） */
const BUILTIN = (() => {
  const lines = RAW_WORDS.concat(typeof RAW_CORE_WORDS !== 'undefined' ? RAW_CORE_WORDS : []);
  const seen = new Set();
  const list = [];
  lines.forEach((line) => {
    const w = makeWord(line, 'builtin');
    if (!w || seen.has(w.lower)) return;
    seen.add(w.lower);
    list.push(w);
  });
  return list;
})();

let settings = {
  libMode: 'all',
  direction: 'en2zh',
  answerType: 'choice',
  count: '10',
  shuffle: true,
  dailyNew: 10,
  endpoint: '',
  report: false,
  listenRate: 1,
  haptic: true,
  includeSpell: true,
  showExamples: true
};
let userWords = [];
let remoteWords = [];
/* ---------- 扩展词包（Play B：ECDICT 分层，按需懒加载） ----------
   未加载的层不进词库，不影响默认包与离线主路径；加载后与内置词合并，
   同名单词以内置为准。专八/考博为「非官方大纲」近似层（ECDICT 无官方 tag）。 */
const EXT_PACKS = [
  { id: 'cet46', name: '四六级', official: true },
  { id: 'kaoyan', name: '考研', official: true },
  { id: 'abroad', name: '留学（雅思·托福）', official: true },
  { id: 'gre', name: 'GRE', official: true },
  { id: 'tem8', name: '专八（近似）', official: false },
  { id: 'phd', name: '考博（近似）', official: false }
];
const EXT_BASE = './content/extension/';
let extWords = [];      // 已加载层的词条（origin 'extension'）
let extStore = {};      // { id: { v, fetchedAt, words: [raw] } }，持久化于 kv.extPacks
let extBusy = new Set();
let extManifest = null; // extension/manifest.json，仅用于展示各层词数
let pasteList = null; // 粘贴批次 { words: [lower], createdAt }，只读内置词库，不写 userWords
let srsMap = Object.create(null);
let wrongBook = [];
let stats = { answered: 0, correct: 0 };
let daily = {};
let events = [];
let contentInfo = { version: BUILTIN_VERSION, source: 'builtin', updatedAt: '', count: 0 };
let libCache = null;
let libLimit = CONFIG.pageSize;
let filters = { q: '', pos: '', letter: '', prefixes: new Set(), suffixes: new Set(), roots: new Set(), affixQ: '' };
/* 筛选弹窗打开时的条件快照：取消时还原 */
let filterModalSnapshot = null;
let session = null;
let sessionEditing = false;
let lastAudioKey = '';
/* 未加任何筛选时，默认取今日复习计划；用户也可以显式切到全库 */
let pickerScope = 'review';

const DAILY_REVIEW_CAP = 120;
const DAILY_NEW_MAX = 15;

/* ---------- 敏感词与屏蔽 ----------
   content/sensitive.json 由脚本扫描 + 人工复核生成：
   - removed: 高危（脏话/slur/性），直接不进练习库
   - words: 其余敏感词保留可练，但永远不进四选一干扰项
   - blocked: 用户点「别出现」写入本地黑名单，优先于一切来源 */
const SENSITIVE = {
  loaded: false,
  words: new Map(),
  removed: new Set(['ass', 'bloody', 'rape', 'sex', 'sexual'])
};
let blockedWords = new Set();
let blockedOrder = [];
/* 「不需要」标记的本地统计：{ word: { count, firstAt, lastAt } }
   只服务于「导出给作者删词」，与 blocked 共用同一份隐藏状态 */
let markLog = {};
/* 上报限频：{ word: 上次上报毫秒 }，同一词 24 小时内只发一次 */
let markReportAt = {};
const MARK_REPORT_GAP = 24 * 60 * 60 * 1000;

/* 释义文本兜底：即使来源词未被词头清单命中，显式敏感中文也不进选项 */
const UNSAFE_ZH_RE = /性交|性欲|色情|妓女|娼妓|卖淫|阴茎|阴道|精液|裸体|全裸|强奸|乱伦|手淫|猥亵|吸毒|毒品|海洛因|可卡因|古柯碱|大麻(?!哈)|鸦片|吗啡|冰毒|成瘾|自杀|谋杀|凶杀|屠杀|血腥|暴力|恐怖分子|暴行|尸体|斩首|肢解|酷刑|虐待|白痴|蠢货|废物|人渣|贱人|婊子|黑鬼|犹太佬|娘炮|残废/;

function wordKey(w) {
  if (typeof w === 'string') return normalizeEnglish(w);
  return (w && w.lower) || (w ? normalizeEnglish(w.word) : '');
}

function isSubstringUnsafeMeaning(text) {
  return UNSAFE_ZH_RE.test(String(text || ''));
}

function isSensitiveWord(w) {
  return SENSITIVE.words.has(wordKey(w));
}

function isHiddenWord(w) {
  const k = wordKey(w);
  return !k || SENSITIVE.removed.has(k) || blockedWords.has(k);
}

/* 干扰项安全池：排除所有敏感词、高危剔除词与用户屏蔽词 */
function isDistractorSafe(w) {
  const k = wordKey(w);
  if (!k || isHiddenWord(w) || SENSITIVE.words.has(k)) return false;
  const text = w.meanings ? w.meanings.join('；') : '';
  return !isSubstringUnsafeMeaning(text);
}

/* 敏感词表加载：这张表决定「哪些词直接剔除、哪些只不进干扰项」，必须在建库/出题前就绪，
   所以 init 仍然 await 它——等待时间由 Service Worker 兜住：sensitive.json 走缓存优先，
   命中即返回（约 0 往返），后台再悄悄更新缓存。
   取舍：因此本次会话可能用上一版词表。该表极少变，且变动只影响中危词的干扰项资格，
   不影响高危剔除，所以接受「旧一版」而不接受「每次启动多等一个往返」。
   边界（fail-safe，宁少出词不出高危词）：
   - SENSITIVE.removed 初值就内置 5 个高危词，加载失败不会清空，高危词始终被剔除；
   - 释义侧另有 UNSAFE_ZH_RE 正则兜底，不依赖词表是否加载；
   - 状态仍是 loaded=false 时，29 个中危词可能进到四选一干扰项里，但不会成为练习主词。 */
async function loadSensitiveContent() {
  try {
    const res = await fetch('./content/sensitive.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const map = new Map();
    (data.words || []).forEach((e) => {
      const k = e && e.word ? normalizeEnglish(e.word) : '';
      if (k) map.set(k, e);
    });
    SENSITIVE.words = map;
    SENSITIVE.removed = new Set((data.removed || ['ass', 'bloody', 'rape', 'sex', 'sexual'])
      .map((w) => normalizeEnglish(w)).filter(Boolean));
    SENSITIVE.loaded = true;
  } catch (e) {
    // 首次访问离线、或缓存与网络都不可用：保留内置的 5 个高危剔除词，
    // 不把「没加载到」当成「没有敏感词」放行。
    SENSITIVE.loaded = false;
  }
  invalidateLib();
}

function anonId() {
  const key = LS_PREFIX + 'anonId';
  try {
    let v = localStorage.getItem(key);
    if (!v) { v = uid(); localStorage.setItem(key, v); }
    return v;
  } catch (e) {
    return 'temp-' + uid(); // 隐私模式禁止 localStorage 时只影响本次上报
  }
}

/* 每次「不需要」都记一条本地统计，用于导出给作者删词 */
function recordMark(k, source) {
  const now = new Date().toISOString();
  const e = markLog[k] || { count: 0, firstAt: now, lastAt: now };
  e.count = (e.count || 0) + 1;
  e.firstAt = e.firstAt || now;
  e.lastAt = now;
  if (source) e.lastSource = source;
  markLog[k] = e;
  saveKV('markLog', markLog);
}

/* 可配置上报：端点为空时绝不发请求；失败静默、同词 24h 限频 */
function reportMark(k, source) {
  const url = CONFIG.markReportUrl;
  if (!url) return;
  const now = Date.now();
  if (now - Number(markReportAt[k] || 0) < MARK_REPORT_GAP) return;
  markReportAt[k] = now;
  saveKV('markReportAt', Object.assign({}, markReportAt));
  const payload = {
    word: k,
    source: source || '',
    at: new Date(now).toISOString(),
    version: CONFIG.version,
    anonId: anonId()
  };
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload)
    }).catch(() => { /* 静默：不弹错、不留残余请求状态 */ });
  } catch (e) { /* 静默 */ }
}

function buildMarkExport() {
  /* 老数据里可能已有屏蔽词但没有统计：并集导出，次数未知记 0 */
  const keys = new Set(Object.keys(markLog).concat(blockedOrder));
  const marks = Array.from(keys).sort().map((k) => ({
    word: k,
    count: (markLog[k] && markLog[k].count) || 0,
    firstAt: markLog[k] ? (markLog[k].firstAt || null) : null,
    lastAt: markLog[k] ? (markLog[k].lastAt || null) : null,
    hidden: blockedWords.has(k)
  }));
  return {
    app: 'word-desk',
    schema: 'mark-export-v1',
    version: CONFIG.version,
    exportedAt: new Date().toISOString(),
    total: marks.length,
    marks
  };
}

function exportMarks() {
  const data = buildMarkExport();
  const day = new Date().toISOString().slice(0, 10);
  downloadFile(`word-desk-不需要-${day}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast(data.total ? `已导出 ${data.total} 个「不需要」标记` : '还没有「不需要」标记，已导出空清单');
  track('mark_export', { total: data.total });
}

function refreshBlockedUI() {
  const stat = $('blockedStat');
  const btn = $('unblockBtn');
  if (stat) stat.textContent = blockedOrder.length ? `已屏蔽 ${blockedOrder.length} 个词` : '还未屏蔽任何词';
  if (btn) btn.disabled = blockedOrder.length === 0;
  const list = $('blockedList');
  if (list) {
    list.innerHTML = blockedOrder.length
      ? blockedOrder.slice().reverse().map((k) =>
        `<span class="blocked-chip"><span>${esc(k)}</span>` +
        `<button class="btn tiny ghost" type="button" data-unblock="${esc(k)}" aria-label="恢复 ${esc(k)}">恢复</button></span>`).join('')
      : '<p class="hint">还没有隐藏的词。词库页点「不需要」后会列在这里。</p>';
  }
}

function addBlockedWord(lower, source) {
  const k = normalizeEnglish(lower);
  if (!k || blockedWords.has(k)) return false;
  blockedWords.add(k);
  blockedOrder.push(k);
  saveKV('blocked', blockedOrder.slice());
  recordMark(k, source);
  reportMark(k, source);
  invalidateLib();
  refreshBlockedUI();
  return true;
}

function restoreBlockedWord(word) {
  const k = normalizeEnglish(word);
  if (!k || !blockedWords.has(k)) return false;
  blockedWords.delete(k);
  blockedOrder = blockedOrder.filter((x) => x !== k);
  saveKV('blocked', blockedOrder.slice());
  invalidateLib();
  refreshBlockedUI();
  renderLibrary();
  renderPractice();
  renderWrong();
  toast(`已恢复「${k}」`);
  return true;
}

/* 词库页「不需要」：复用 blocked，隐藏后立刻从列表消失 */
function markNotNeeded(word) {
  const k = normalizeEnglish(word);
  if (!addBlockedWord(k, 'library')) { toast('这个词已在隐藏列表里'); return; }
  renderLibrary();
  renderPractice();
  toast(`已隐藏「${k}」，可在设置里恢复`);
}

function undoBlockedWord() {
  const k = blockedOrder.pop();
  if (!k) return null;
  blockedWords.delete(k);
  saveKV('blocked', blockedOrder.slice());
  invalidateLib();
  refreshBlockedUI();
  return k;
}

function invalidateLib() { libCache = null; }

function library() {
  if (libCache) return libCache;
  const list = new Map();
  if (settings.libMode !== 'user') {
    BUILTIN.forEach((w) => { if (!isHiddenWord(w)) list.set(w.lower, w); });
    remoteWords.forEach((w) => { if (!isHiddenWord(w)) list.set(w.lower, w); });
    extWords.forEach((w) => { if (!isHiddenWord(w) && !list.has(w.lower)) list.set(w.lower, w); });
  }
  if (settings.libMode !== 'builtin') {
    userWords.forEach((w) => { if (!isHiddenWord(w)) list.set(w.lower, w); });
  }
  libCache = Array.from(list.values()).sort((a, b) => a.word.localeCompare(b.word, 'en'));
  return libCache;
}

function findWord(lower) {
  const key = normalizeEnglish(lower);
  if (isHiddenWord(key)) return null;
  const lib = library();
  const libIndex = lib.index || (lib.index = new Map(lib.map((w) => [w.lower, w])));
  const direct = libIndex.get(key);
  if (direct) return direct;
  const extra = userWords.find((w) => w.lower === key) || BUILTIN.find((w) => w.lower === key) || null;
  return extra && !isHiddenWord(extra) ? extra : null;
}

function quickFilterPass(w) {
  if (filters.pos && !w.pos.includes(filters.pos)) return false;
  if (filters.letter && !w.word.toLowerCase().startsWith(filters.letter)) return false;
  if (filters.q) {
    const q = /[a-z]/i.test(filters.q) ? filters.q.trim().toLowerCase() : '';
    const qzh = normalizeChinese(filters.q);
    const inWord = !!q && w.word.toLowerCase().includes(q);
    const inMeaning = !!qzh && w.meanings.some((m) => normalizeChinese(m).includes(qzh));
    if (!inWord && !inMeaning) return false;
  }
  return true;
}

function filteredWords() {
  return library().filter((w) =>
    quickFilterPass(w) &&
    (!filters.prefixes.size || w.prefixes.some((t) => filters.prefixes.has(t))) &&
    (!filters.suffixes.size || w.suffixes.some((t) => filters.suffixes.has(t))) &&
    (!filters.roots.size || filters.roots.has(wordRootId(w)))
  );
}

function filtersActive() {
  return !!(filters.q || filters.pos || filters.letter || filters.prefixes.size || filters.suffixes.size || filters.roots.size);
}

/* ---------- 持久化 ---------- */
const pendingKV = {};
let kvTimer = null;
/* 写失败提示：3 秒内只报一次，避免一批写失败刷屏 */
let saveFailTimer = null;
function toastSaveFail() {
  if (saveFailTimer) return;
  saveFailTimer = setTimeout(() => { saveFailTimer = null; }, 3000);
  toast('进度保存失败，可先导出备份');
}
async function flushKV() {
  clearTimeout(kvTimer);
  kvTimer = null;
  const keys = Object.keys(pendingKV);
  if (!keys.length) return true;
  const batch = {};
  keys.forEach((k) => { batch[k] = pendingKV[k]; delete pendingKV[k]; });
  try {
    for (const k of keys) await DB.put('kv', { key: k, value: batch[k] });
    return true;
  } catch (e) {
    // 没写进去的键退回待写队列，下次保存或切后台时再试，不能当成功丢掉
    keys.forEach((k) => { if (!(k in pendingKV)) pendingKV[k] = batch[k]; });
    toastSaveFail();
    return false;
  }
}
function saveKV(key, value) {
  pendingKV[key] = value;
  clearTimeout(kvTimer);
  kvTimer = setTimeout(flushKV, 220);
}
async function saveSrs(record) {
  try {
    await DB.put('srs', record);
    return true;
  } catch (e) {
    toastSaveFail();
    return false;
  }
}
function saveWrong() { saveKV('wrong', wrongBook); }
function saveSettings() { saveKV('settings', settings); }
function saveStats() { saveKV('stats', stats); saveKV('daily', daily); }

async function loadState() {
  await DB.init();
  const kvRows = await DB.all('kv');
  const kv = {};
  kvRows.forEach((r) => { kv[r.key] = r.value; });
  if (kv.settings) settings = sanitizeBackupSettings(kv.settings);
  if (!['en2zh', 'zh2en', 'listen'].includes(settings.direction)) settings.direction = 'en2zh';
  // 听音拼写关闭时，历史设置里的 listen 自动回落到英译中，不报错
  if (settings.direction === 'listen' && !FEATURES.listenDictation) settings.direction = 'en2zh';
  settings.listenRate = Number(settings.listenRate) === 0.8 ? 0.8 : 1;
  // 缺省/旧备份无 haptic 字段时默认开；显式 false 才关
  settings.haptic = settings.haptic !== false;
  // 练习含拼写默认开；显式 false 才关。听音拼写依赖拼写，关拼写时回落英译中
  settings.includeSpell = settings.includeSpell !== false;
  // 情景例句默认关；开启时才按需拉取 examples.json，失败当无句
  settings.showExamples = !!settings.showExamples;
  if (settings.direction === 'listen' && !settings.includeSpell) settings.direction = 'en2zh';
  if (kv.audioProbe && typeof kv.audioProbe === 'object') {
    VOICE.cachedProbe = kv.audioProbe;
    VOICE.status = kv.audioProbe.status || 'unknown';
  }
  if (!Number.isFinite(Number(settings.dailyNew)) || settings.dailyNew < 0) settings.dailyNew = 10;
  settings.dailyNew = Math.min(DAILY_NEW_MAX, Math.max(0, Number(settings.dailyNew)));
  if (kv.stats) stats = Object.assign(stats, kv.stats);
  daily = normalizeDaily(kv.daily);
  wrongBook = Array.isArray(kv.wrong) ? kv.wrong : [];
  blockedOrder = Array.isArray(kv.blocked)
    ? kv.blocked.map((w) => normalizeEnglish(w)).filter(Boolean)
    : [];
  blockedWords = new Set(blockedOrder);
  markLog = kv.markLog && typeof kv.markLog === 'object' && !Array.isArray(kv.markLog) ? kv.markLog : {};
  markReportAt = kv.markReportAt && typeof kv.markReportAt === 'object' && !Array.isArray(kv.markReportAt) ? kv.markReportAt : {};
  if (kv.content && Array.isArray(kv.content.words)) {
    remoteWords = kv.content.words.map((w) => makeWord(w, 'remote')).filter(Boolean);
    contentInfo = {
      version: kv.content.version || BUILTIN_VERSION,
      source: 'remote',
      updatedAt: kv.content.fetchedAt || '',
      count: remoteWords.length
    };
  }
  if (kv.extPacks && typeof kv.extPacks === 'object' && !Array.isArray(kv.extPacks)) extStore = kv.extPacks;
  rebuildExtWords();
  userWords = (await DB.all('userWords')).map((w) => makeWord(w, 'user')).filter(Boolean);
  pasteList = kv.pasteList && Array.isArray(kv.pasteList.words) && kv.pasteList.words.length
    ? { words: kv.pasteList.words.slice(), createdAt: kv.pasteList.createdAt || Date.now() }
    : null;
  const srsRows = await DB.all('srs');
  srsMap = Object.create(null);
  srsRows.forEach((r) => { if (r && r.word) srsMap[r.word] = r; });
  events = ((await DB.all('events')) || []).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-CONFIG.maxEvents);
  pruneStoredEvents(); // 后台清理 IDB 里的历史积压，不阻塞启动
  let touched = false;
  for (const r of Object.values(srsMap)) {
    if (!r.state) { r.state = r.stability > 0 ? 'review' : 'new'; touched = true; }
    if (!Number.isFinite(r.step)) { r.step = 0; touched = true; }
  }
  if (!daily[dateKey()]) {
    daily[dateKey()] = { answers: 0, correct: 0, reviews: 0, newWords: 0, wrongAdded: 0, wrongTotal: wrongBook.length };
  }
  if (touched) {
    try {
      await DB.putMany('srs', Object.values(srsMap));
    } catch (e) {
      toastSaveFail();
    }
  }
}

/* ---------- 词缀拆解 ---------- */
function splitAffixes(w) {
  const lower = w.word.toLowerCase();
  const pre = w.prefixes.slice().sort((a, b) => b.length - a.length);
  const suf = w.suffixes.slice().sort((a, b) => b.length - a.length);
  let prefix = '';
  let prefixCore = '';
  let suffix = '';
  let suffixCore = '';
  for (const p of pre) {
    const core = p.replace(/-+$/, '').toLowerCase();
    if (!core) continue;
    if (lower.startsWith(core) && lower.length > core.length + 2) { prefix = p; prefixCore = core; break; }
  }
  for (const s of suf) {
    const core = s.replace(/^-+/, '').toLowerCase();
    if (!core) continue;
    if (lower.endsWith(core) && lower.length > core.length + 2) { suffix = s; suffixCore = core; break; }
  }
  let start = prefixCore.length;
  let end = lower.length - suffixCore.length;
  if (end <= start) { suffix = ''; suffixCore = ''; end = lower.length; }
  return { prefix: prefix ? [prefix] : [], suffix: suffix ? [suffix] : [], stem: w.word.slice(start, end) };
}

function wordDisplayHTML(w) {
  const p = splitAffixes(w);
  const out = [];
  if (p.prefix.length) out.push(`<span class="seg-pre">${esc(p.prefix[0])}</span>`);
  out.push(`<span class="seg-stem">${esc(p.stem)}</span>`);
  if (p.suffix.length) out.push(`<span class="seg-suf">${esc(p.suffix[0])}</span>`);
  return out.join('');
}

function affixTagsHTML(w) {
  const tags = w.prefixes.map((t) => `<span class="tag pre" title="${esc('前缀 ' + t + '：' + (AFFIX_INFO[t] || '未知含义'))}">${esc(t)}</span>`)
    .concat(w.suffixes.map((t) => `<span class="tag suf" title="${esc('后缀 ' + t + '：' + (AFFIX_INFO[t] || '未知含义'))}">${esc(t)}</span>`));
  return tags.join('');
}

function dueText(ts) {
  const diff = ts - Date.now();
  if (!Number.isFinite(ts)) return '暂无计划';
  if (diff <= 0) return '现在';
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} 小时后`;
  const days = Math.round(hrs / 24);
  return `${days} 天后`;
}

function dueBadgeHTML(w) {
  const r = srsMap[w.lower];
  if (!r) return '';
  const label = r.due <= Date.now() ? '待复习' : dueText(r.due);
  return `<span class="due-badge" title="下次复习：${esc(dueText(r.due))}">${esc(label)}</span>`;
}

function masteryLevel(r) {
  if (!r) return -1;
  if (r.state === 'new' || r.state === 'learning' || r.state === 'relearning') return 0;
  const s = r.stability || 0;
  if (s < 1) return 1;
  if (s < 3) return 2;
  if (s < 8) return 3;
  if (s < 20) return 4;
  return 5;
}

/* ---------- 顶部 / 今日 ---------- */
function dailyReviews(k) {
  const rec = daily[k];
  return (rec && Number(rec.reviews)) || 0;
}

function computeStreak() {
  let d = startOfDay();
  let count = 0;
  if (!dailyReviews(dateKey(d))) d = addDays(d, -1);
  while (count < 3650 && dailyReviews(dateKey(d))) {
    count++;
    d = addDays(d, -1);
  }
  return count;
}

function todaySnapshot() {
  const now = Date.now();
  const words = library();
  const libIndex = words.index || (words.index = new Map(words.map((w) => [w.lower, w])));
  const dueList = Object.values(srsMap).filter((r) => r && r.due <= now && r.state !== 'new' && libIndex.has(r.word));
  const learnedToday = Object.values(srsMap).filter((r) => r && r.firstReview && !r.fromDrill && libIndex.has(r.word) && dateKey(new Date(r.firstReview)) === dateKey()).length;
  const newLeft = Math.max(0, settings.dailyNew - learnedToday);
  const unlearned = words.filter((w) => !srsMap[w.lower]).length;
  const d = daily[dateKey()] || { reviews: 0, answers: 0, correct: 0 };
  return {
    due: Math.min(DAILY_REVIEW_CAP, dueList.length),
    dueTotal: dueList.length,
    newLeft: Math.min(newLeft, unlearned),
    unlearned,
    done: d.reviews || 0,
    streak: computeStreak()
  };
}

/* ---------- 练词：选词面板 ---------- */
function libraryScopeCount() {
  const total = library().length;
  const picked = settings.count === 'all'
    ? total
    : Math.min(total, Math.max(1, Number(settings.count) || 10));
  return { total, count: picked };
}

/* 第一次使用：没有任何复习记录，也没有自建词 */
function isFirstRun() {
  return !userWords.length && Object.keys(srsMap).length === 0;
}

/* 当前点「开始练习」会取到哪一批词：筛选结果 / 今日复习计划 / 全库 */
function pickerPlan() {
  if (filtersActive()) {
    const n = filteredWords().length;
    return {
      kind: 'filter',
      count: n,
      button: n ? `用这 ${n} 个词开始练习` : '没有命中的词',
      note: `当前筛选命中 ${n} 词`
    };
  }
  if (pickerScope === 'library') {
    const { total, count } = libraryScopeCount();
    const first = isFirstRun();
    return {
      kind: 'library',
      count,
      button: first ? `用 ${count} 个新词试一轮` : `从全库抽 ${count} 词开始练习`,
      note: first ? '第一次使用：先练一轮熟悉流程' : ''
    };
  }
  const plan = buildQueue('review', 'all', false);
  if (plan.length) {
    const first = isFirstRun();
    return {
      kind: 'review',
      count: plan.length,
      button: first ? `用 ${plan.length} 个新词试一轮` : `用今日复习计划（${plan.length} 词）开始练习`,
      note: first ? '第一次使用：先练一轮熟悉流程' : ''
    };
  }
  const { total, count } = libraryScopeCount();
  const first = isFirstRun();
  return {
    kind: 'library',
    count,
    button: first ? `用 ${count} 个新词试一轮` : `今日无待复习词 · 改用全库 ${count} 词`,
    note: first ? '第一次使用：先练一轮熟悉流程' : '今日无待复习词'
  };
}

function renderPractice() {
  const t = todaySnapshot();
  $('planStats').innerHTML = [
    ['待复习', t.due],
    ['新词', t.newLeft],
    ['今日已练', t.done],
    ['连续', `${t.streak} 天`]
  ].map(([label, value]) => `<span class="plan-stat"><b>${esc(value)}</b>${esc(label)}</span>`).join('')
    + (isFirstRun() ? '<span class="plan-first-hint">今天还没有复习记录，先试一轮。</span>' : '');
  renderChips();
  renderPickerState();
  renderRootDrill();
}

/* ---------- 词根同族词专项 ---------- */
function drillRoots() {
  if (!rootData) return [];
  const libMap = new Map(library().map((w) => [w.lower, w]));
  return Object.values(rootData.roots || {})
    .map((r) => ({
      id: r.id,
      form: r.form,
      zh: r.zh,
      words: (r.family || []).filter((l) => libMap.has(l)).map((l) => libMap.get(l))
    }))
    .filter((r) => r.words.length >= ROOT_DRILL_MIN)
    .sort((a, b) => b.words.length - a.words.length || a.form.localeCompare(b.form, 'en'));
}

function renderRootDrill() {
  const wrap = $('rootDrillChips');
  if (!wrap) return;
  const roots = drillRoots();
  $('rootDrillMeta').textContent = roots.length
    ? `${roots.length} 个词根 · ${roots.reduce((n, r) => n + r.words.length, 0)} 词`
    : '';
  const hint = $('rootDrillHint');
  if (!roots.length) {
    hint.textContent = '';
    wrap.innerHTML = `<div class="root-empty">
      <b>暂无可专项练习的词根</b>
      <p>可用词根不足，先用前后缀筛选练习。</p>
      <div class="empty-actions">
        <button class="btn tiny" type="button" data-root-action="library">去词库导入词表</button>
        <button class="btn tiny ghost" type="button" data-root-action="all">回全库随机练习</button>
      </div>
    </div>`;
    return;
  }
  hint.textContent = '';
  wrap.innerHTML = roots.map((r) => `<button type="button" class="root-chip" data-root="${esc(r.id)}" title="${esc(`词根 ${r.form}：${r.zh}`)}">
    <span class="rc-form">${esc(r.form)}</span>
    <span class="rc-zh">${esc(r.zh)}</span>
    <span class="rc-n">覆盖 ${r.words.length} 词</span>
  </button>`).join('');
}

function startDrill(rootId) {
  const r = drillRoots().find((x) => x.id === rootId);
  if (!r) { toast('这个词根的高置信词不足，换一个词根试试'); return; }
  if (r.words.length < ROOT_DRILL_MIN) {
    toast(`这个词根只有 ${r.words.length} 个高置信词，去全库练更合适`);
    return;
  }
  startSession('drill', 'all', { drillRoot: r.id });
}

function pickerEmptyHTML(plan) {
  if (filtersActive()) {
    return `<b>这组条件没有命中词</b>
      <p>去掉一个分类或清空条件即可。</p>
      <div class="empty-actions">
        <button class="btn tiny" type="button" data-picker-action="clear-affix">清空分类</button>
        <button class="btn tiny ghost" type="button" data-picker-action="clear-all">清空全部条件</button>
        <button class="btn tiny ghost" type="button" data-picker-action="library">去词库导入词表</button>
      </div>`;
  }
  return `<b>词库还没有可练的词</b>
    <p>先导入词表或新增词条。</p>
    <div class="empty-actions">
      <button class="btn tiny" type="button" data-picker-action="library">去词库导入或新增</button>
      <button class="btn tiny ghost" type="button" data-picker-action="sample">载入示例词表</button>
    </div>`;
}

/* 听音方向是否可用的硬门槛：当前队列里至少要有一个带离线音频的词 */
function planAudioWords() {
  if (filtersActive()) return filteredWords();
  if (pickerScope === 'library') return library();
  const plan = buildQueue('review', 'all', false);
  return plan.length ? plan : library();
}

function planHasOfflineAudio() {
  if (!FEATURES.listenDictation || !AUDIO.index) return false;
  return planAudioWords().some(hasOfflineAudio);
}

function syncListenAvailability() {
  const btn = $('directionSeg') && $('directionSeg').querySelector('button[data-dir="listen"]');
  const note = $('directionNote');
  const spellOn = settings.includeSpell !== false;
  const canListen = spellOn && planHasOfflineAudio();
  if (btn) btn.disabled = !canListen;
  if (note) {
    note.hidden = canListen;
    if (!canListen) {
      note.textContent = !spellOn
        ? '已关闭「练习含拼写」，听音拼写不可用'
        : '当前队列没有可播放的离线发音，听音拼写不可用';
    }
  }
  // 方向回退不在这里做：渲染只更新可用态，真正开始时按卡决定（见 startSession 的 makeCard 回落）
  // 状态可能刚被回退，重新同步方向按钮与答题方式可用性
  document.querySelectorAll('#directionSeg button').forEach((b) => b.classList.toggle('active', b.dataset.dir === settings.direction));
  const listen = settings.direction === 'listen';
  document.querySelectorAll('#answerSeg button').forEach((b) => { b.disabled = listen; });
  $('answerSeg').classList.toggle('is-disabled', listen);
}

function renderPickerState() {
  const plan = pickerPlan();
  $('pickerCount').textContent = plan.count;
  $('pickerCountLabel').textContent = plan.kind === 'filter' ? '命中' : plan.kind === 'review' ? '计划' : '取词';
  $('pickerScopeNote').textContent = plan.kind === 'filter' ? '' : plan.note;

  const sum = $('filterSummary');
  if (sum) {
    const n = filters.prefixes.size + filters.suffixes.size + filters.roots.size
      + (filters.q ? 1 : 0) + (filters.pos ? 1 : 0) + (filters.letter ? 1 : 0);
    sum.textContent = n ? `${n} 项条件` : '';
  }

  const btn = $('startPickerBtn');
  btn.textContent = plan.count === 0 || ((plan.kind === 'library' || plan.kind === 'review') && plan.note)
    ? plan.button
    : plan.kind === 'library' ? '从全库开始练习' : '开始练习';
  btn.disabled = plan.count === 0;

  syncListenAvailability();

  $('scopeSeg').hidden = filtersActive();
  document.querySelectorAll('#scopeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === pickerScope);
  });

  const quickCount = (filters.q ? 1 : 0) + (filters.pos ? 1 : 0) + (filters.letter ? 1 : 0);
  $('moreFilterCount').textContent = quickCount ? `已用 ${quickCount} 个条件` : '';
  if (quickCount) $('moreFilters').open = true;

  const hint = $('pickerHint');
  hint.textContent = !plan.count ? '' : plan.count < 4 ? '命中词少于 4 个，本轮就练这几个词；选项凑不齐 4 个时会自动改成输入作答' : '';

  const empty = $('pickerEmpty');
  if (!plan.count) {
    empty.hidden = false;
    empty.innerHTML = pickerEmptyHTML(plan);
  } else {
    empty.hidden = true;
    empty.innerHTML = '';
  }

  $('cancelEditBtn').hidden = !(session && sessionEditing);
}

function renderHeader() {
  const el = $('contentStatus');
  if (contentInfo.source === 'remote') {
    el.textContent = `内容 v${contentInfo.version} · 已缓存`;
  } else {
    el.textContent = `内置词库 v${BUILTIN_VERSION}`;
  }
  const ver = $('appVersion');
  if (ver) ver.textContent = `V${CONFIG.version}`;
  $('netDot').classList.toggle('off', !navigator.onLine);
  $('netDot').title = navigator.onLine ? '在线' : '离线';
}

/* ---------- 分类标签：前缀 / 后缀 / 词根，可搜索、全量浏览、显示词数与释义 ---------- */
const AFFIX_CHIP_LIMIT = 6;
const affixExpanded = { prefix: false, suffix: false, root: false };
const TAG_CLASS = { prefix: 'pre', suffix: 'suf', root: 'root' };

/* 词根分类只认高置信可切分的词，教学义取自 roots.json */
function wordRootId(w) {
  if (!rootData || !rootData.words) return '';
  const key = w.lower || String(w.word || '').toLowerCase();
  const row = rootData.words[key];
  if (!row || !row.segmentable || Number(row.confidence || 0) < 0.75) return '';
  return row.rootId || '';
}

function rootLabel(id) {
  const r = rootData && rootData.roots ? rootData.roots[id] : null;
  return r ? { form: r.form || id, zh: r.zh || '' } : { form: id, zh: '' };
}

function tagTokens(w, type) {
  if (type === 'prefix') return w.prefixes;
  if (type === 'suffix') return w.suffixes;
  const id = wordRootId(w);
  return id ? [id] : [];
}

function tagText(type, token) {
  if (type === 'root') return rootLabel(token);
  return { form: token, zh: AFFIX_INFO[token] || '未知含义' };
}

/* 分面计数：统计某一类时，应用其余两类和快速条件，标签上的数字直接反映交集。 */
function affixBaseWords(type) {
  const passPrefix = (w) => !filters.prefixes.size || w.prefixes.some((t) => filters.prefixes.has(t));
  const passSuffix = (w) => !filters.suffixes.size || w.suffixes.some((t) => filters.suffixes.has(t));
  const passRoot = (w) => !filters.roots.size || filters.roots.has(wordRootId(w));
  return library().filter((w) => {
    if (!quickFilterPass(w)) return false;
    if (type === 'prefix') return passSuffix(w) && passRoot(w);
    if (type === 'suffix') return passPrefix(w) && passRoot(w);
    return passPrefix(w) && passSuffix(w);
  });
}

function renderChipGroup(type) {
  const base = affixBaseWords(type);
  const counts = new Map();
  base.forEach((w) => tagTokens(w, type).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  const totalTags = counts.size;
  const allTags = new Set();
  library().forEach((w) => tagTokens(w, type).forEach((t) => allTags.add(t)));
  const activeSet = type === 'prefix' ? filters.prefixes : type === 'suffix' ? filters.suffixes : filters.roots;
  const q = filters.affixQ.trim().toLowerCase();
  let items = Array.from(counts.entries())
    .filter(([token]) => {
      if (!q) return true;
      const txt = tagText(type, token);
      return token.toLowerCase().includes(q) || txt.form.toLowerCase().includes(q) || txt.zh.toLowerCase().includes(q);
    })
    .sort((a, b) => (activeSet.has(b[0]) ? 1 : 0) - (activeSet.has(a[0]) ? 1 : 0) || b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
  activeSet.forEach((token) => {
    if (!items.some(([t]) => t === token)) items.push([token, counts.get(token) || 0]);
  });

  const expanded = !!q || !!affixExpanded[type];
  const chips = items.map(([token, count]) => {
    const active = activeSet.has(token) ? ' active ' + TAG_CLASS[type] : '';
    const txt = tagText(type, token);
    const tip = (type === 'prefix' ? '前缀 ' : type === 'suffix' ? '后缀 ' : '词根 ') + txt.form + '：' + txt.zh;
    const zh = type === 'root' ? `<span class="rz">${esc(txt.zh)}</span>` : '';
    return `<button type="button" class="chip${active}" data-affix="${esc(token)}" data-type="${type}" title="${esc(tip)}">${esc(txt.form)}${zh}<span class="n">${count}</span></button>`;
  }).join('');
  const empty = q
    ? `没有匹配「${esc(filters.affixQ)}」的分类`
    : '当前词库没有该类标签';
  const html = items.length ? chips : `<span class="hint">${empty}</span>`;

  const targets = type === 'prefix' ? [$('prefixChips'), $('libPrefixChips')]
    : type === 'suffix' ? [$('suffixChips'), $('libSuffixChips')]
      : [$('rootChips'), $('libRootChips')];
  const needMore = !q && items.length > AFFIX_CHIP_LIMIT;
  targets.forEach((el) => {
    if (!el) return;
    el.innerHTML = html;
    el.classList.toggle('is-expanded', expanded || (items.length && items.length <= AFFIX_CHIP_LIMIT));
  });
  document.querySelectorAll(`[data-expand="${type}"]`).forEach((btn) => {
    btn.hidden = !needMore;
    btn.textContent = expanded ? '收起' : '展开';
    btn.setAttribute('aria-expanded', String(expanded));
  });
  const meta = type === 'prefix' ? $('prefixGroupMeta') : type === 'suffix' ? $('suffixGroupMeta') : $('rootGroupMeta');
  if (meta) {
    meta.textContent = activeSet.size
      ? `已选 ${activeSet.size}`
      : (totalTags < allTags.size ? `${totalTags} / ${allTags.size}` : `${allTags.size}`);
  }
  return allTags.size;
}

function renderChips() {
  const prefixTotal = renderChipGroup('prefix');
  const suffixTotal = renderChipGroup('suffix');
  const rootTotal = renderChipGroup('root');
  const selected = filters.prefixes.size + filters.suffixes.size + filters.roots.size;
  const libCount = $('libAffixFoldCount');
  if (libCount) libCount.textContent = selected ? `已选 ${selected}` : '';
  renderAffixSummary();
}
/* 已选分类置顶成一条可移除的标签行 */
function renderAffixSummary() {
  const picks = [
    ...Array.from(filters.prefixes).map((t) => ({ t, type: 'prefix' })),
    ...Array.from(filters.suffixes).map((t) => ({ t, type: 'suffix' })),
    ...Array.from(filters.roots).map((t) => ({ t, type: 'root' }))
  ];
  const boxes = [$('affixSelected'), $('libAffixSelected')];
  boxes.forEach((box) => {
    if (!box) return;
    if (picks.length) {
      box.hidden = false;
      box.innerHTML = '<span class="affix-selected-label">已选</span>'
        + picks.map(({ t, type }) => {
          const txt = tagText(type, t);
          const zh = type === 'root' ? `<span class="rz">${esc(txt.zh)}</span>` : '';
          return `<button type="button" class="chip active ${TAG_CLASS[type]}" data-affix="${esc(t)}" data-type="${type}" title="点击移除">${esc(txt.form)}${zh}<span class="x" aria-hidden="true">×</span></button>`;
        }).join('')
        + '<button type="button" class="affix-clear" data-clear-affix>清空分类</button>';
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  });
}

/* ---------- 词库 ---------- */
function renderLibrary() {
  const list = filteredWords();
  $('resultCount').textContent = list.length;
  $('filterNote').textContent = filtersActive() ? '（已筛选，与练词页共用条件）' : '';
  $('libraryCount').textContent = `${library().length} 词`;

  const startBtn = $('libStartBtn');
  if (filtersActive() && list.length) {
    startBtn.hidden = false;
    startBtn.textContent = `用当前筛选（${list.length} 词）开始练习`;
  } else if (!library().length) {
    startBtn.hidden = true;
  } else {
    startBtn.hidden = false;
    startBtn.textContent = '去练词页选一批词';
  }

  const grid = $('libraryGrid');
  if (!list.length) {
    const emptyLibrary = !library().length;
    grid.innerHTML = `<div class="empty-state">
      <b>${emptyLibrary ? '词库还没有词' : '没有匹配的词'}</b>
      <p>${emptyLibrary ? '导入 CSV / JSON，或手动新增词条后再练习。' : '换个关键词，或清空筛选；也可以回练词页重新选一批词。'}</p>
      <div class="empty-actions">
        ${emptyLibrary ? '' : '<button class="btn tiny" type="button" data-empty-action="clear">清空筛选</button>'}
        <button class="btn tiny ghost" type="button" data-empty-action="practice">去练词页</button>
        <button class="btn tiny ghost" type="button" data-empty-action="import">导入词表</button>
      </div>
    </div>`;
    $('loadMoreWrap').hidden = true;
    return;
  }
  grid.innerHTML = list.slice(0, libLimit).map((w) => `
    <article class="word-card" data-word="${esc(w.word)}">
      <div class="wd">
        <b>${wordDisplayHTML(w)}</b>
        <span class="pos">${esc(w.pos.join('/') || '—')}</span>
      </div>
      <div class="mn">${esc(w.meanings.join('；') || '暂无释义')}${w.phonetic ? ` · <span class="phon">${esc(w.phonetic)}</span>` : ''}</div>
      ${examplesHTML(w)}
      <div class="ft">
        <div class="word-tags">
          ${affixTagsHTML(w)}
          ${w.origin === 'user' ? '<span class="origin-badge user">我的</span>' : ''}
          ${w.origin === 'remote' ? '<span class="origin-badge remote">远端</span>' : ''}
          ${w.origin === 'extension' ? `<span class="origin-badge ext">${esc((EXT_PACKS.find((p) => p.id === w.extId) || {}).name || '扩展')}</span>` : ''}
          ${dueBadgeHTML(w)}
        </div>
        <div class="ops">
          ${w.origin === 'user'
            ? `<button class="btn tiny" type="button" data-edit="${esc(w.word)}">编辑</button><button class="btn tiny ghost" type="button" data-del="${esc(w.word)}">删除</button>`
            : ''}
          <button class="btn tiny ghost block-lib-btn" type="button" data-block-lib="${esc(w.word)}" title="以后不想再看到这个词">不需要</button>
        </div>
      </div>
    </article>`).join('');
  $('loadMoreWrap').hidden = list.length <= libLimit;
}

/* ---------- 错题本 ---------- */
function renderWrong() {
  const visible = wrongBook.filter((x) => !isHiddenWord(x.word));
  $('wrongCount').textContent = `${visible.length} 词`;
  const box = $('wrongList');
  if (!visible.length) {
    box.innerHTML = '<div class="empty-state"><b>错题本是空的</b>练习中答错的词会自动收进来，答对后自动移出。</div>';
    return;
  }
  box.innerHTML = visible.slice(0, 30).map((x) => `
    <div class="wrong-item" data-wrong="${esc(x.word)}">
      <div class="wi-main">
        <div class="wi-word">${esc(x.word)} <span class="tag">错 ${Number(x.count) || 1} 次</span></div>
        <div class="wi-mn">${esc((x.meanings || []).join('；'))}</div>
      </div>
      <div class="wi-ops">
        <button class="btn tiny" type="button" data-retry="${esc(x.word)}">重练</button>
        <button class="btn tiny ghost" type="button" data-remove-wrong="${esc(x.word)}">移除</button>
      </div>
    </div>`).join('');
}

/* ---------- 图表 ---------- */
function lastDateKeys(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dateKey(addDays(startOfDay(), -i)));
  return out;
}

function renderHeatmap() {
  const today = startOfDay();
  const startBase = addDays(today, -90);
  const start = addDays(startBase, -((startBase.getDay() + 6) % 7));
  const cells = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const k = dateKey(d);
    const rec = daily[k];
    const n = (rec && rec.reviews) || 0;
    const lv = n === 0 ? 0 : n < 4 ? 1 : n < 10 ? 2 : n < 20 ? 3 : n < 30 ? 4 : 5;
    cells.push(`<div class="heat-cell" data-l="${lv}" title="${k} · ${Number(n) || 0} 次复习"></div>`);
  }
  while (cells.length % 7) cells.push('<div class="heat-cell blank" data-l="0"></div>');
  $('heatmap').innerHTML = cells.join('');
}

function svgFrame(W, H, padL, padT, inner, padB) {
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="xMidYMid meet" role="img">${inner}</svg>`;
}

function renderCurve() {
  const keys = lastDateKeys(14);
  const answers = keys.map((k) => (daily[k] || {}).answers || 0);
  const acc = keys.map((k) => {
    const d = daily[k];
    return d && d.answers ? percent(d.correct, d.answers) : null;
  });
  if (!answers.some((v) => v > 0)) {
    $('curveChart').innerHTML = '<div class="chart-empty">还没有答题记录，练习几题后这里会出现曲线。</div>';
    return;
  }
  const W = 340, H = 120, L = 26, R = 8, T = 10, B = 20;
  const maxA = Math.max(4, ...answers);
  const n = keys.length;
  const plotW = W - L - R, plotH = H - T - B;
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yA = (v) => T + (1 - v / maxA) * plotH;
  const yP = (v) => T + (1 - v / 100) * plotH;
  const bw = Math.max(5, plotW / n * 0.5);
  let bars = '';
  answers.forEach((v, i) => {
    if (!v) return;
    const h = plotH - (yA(v) - T);
    bars += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yA(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" style="fill:var(--brand-soft)"></rect>`;
  });
  let path = '';
  let started = false;
  acc.forEach((v, i) => {
    if (v == null) { started = false; return; }
    path += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${yP(v).toFixed(1)} `;
    started = true;
  });
  const dots = acc.map((v, i) => v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${yP(v).toFixed(1)}" r="2.6" style="fill:var(--brand)"><title>${keys[i]} 正确率 ${v}%</title></circle>`).join('');
  const labels = [0, 6, 13].map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 5}" font-size="9" style="fill:var(--muted)" text-anchor="${i === 0 ? 'start' : i === 13 ? 'end' : 'middle'}">${keys[i].slice(5).replace('-', '/')}</text>`).join('');
  const inner = `
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" style="stroke:var(--line)" stroke-width="1"/>
    <line x1="${L}" y1="${yP(50)}" x2="${W - R}" y2="${yP(50)}" style="stroke:var(--line)" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="2" y="${yP(50) + 3}" font-size="9" style="fill:var(--muted)">50%</text>
    <text x="2" y="${T + 8}" font-size="9" style="fill:var(--muted)">${maxA}</text>
    ${bars}
    <path d="${path.trim()}" fill="none" style="stroke:var(--brand)" stroke-width="1.8" stroke-linejoin="round"/>
    ${dots}${labels}`;
  $('curveChart').innerHTML = svgFrame(W, H, L, T, inner);
}

function renderWrongTrend() {
  const keys = lastDateKeys(14);
  let prev = null;
  const vals = keys.map((k) => {
    const d = daily[k];
    if (d && Number.isFinite(d.wrongTotal)) { prev = d.wrongTotal; return d.wrongTotal; }
    return prev;
  });
  const known = vals.filter((v) => v != null);
  if (!known.length) {
    $('wrongChart').innerHTML = '<div class="chart-empty">还没有错题记录。</div>';
    return;
  }
  if (known.length < 2) {
    $('wrongChart').innerHTML = `<div class="chart-empty">当前 ${known[known.length - 1]} 个错题</div>`;
    return;
  }
  const W = 340, H = 120, L = 26, R = 10, T = 12, B = 20;
  const max = Math.max(2, ...vals.filter((v) => v != null));
  const n = keys.length;
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  let path = '';
  let started = false;
  vals.forEach((v, i) => {
    if (v == null) { started = false; return; }
    path += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    started = true;
  });
  const dots = vals.map((v, i) => v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === n - 1 ? 3.4 : 2.3}" style="fill:var(--rose)"><title>${keys[i]} · ${v} 个错题</title></circle>`).join('');
  const last = vals.filter((v) => v != null).slice(-1)[0];
  const inner = `
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" style="stroke:var(--line)"/>
    <path d="${path.trim()}" fill="none" style="stroke:var(--rose)" stroke-width="1.8" stroke-linejoin="round"/>
    ${dots}
    <text x="${W - R}" y="${T + 4}" font-size="9" style="fill:var(--muted)" text-anchor="end">当前 ${last} 个</text>
    <text x="${L}" y="${H - 5}" font-size="9" style="fill:var(--muted)">${keys[0].slice(5).replace('-', '/')}</text>
    <text x="${W - R}" y="${H - 5}" font-size="9" style="fill:var(--muted)" text-anchor="end">今天</text>`;
  $('wrongChart').innerHTML = svgFrame(W, H, L, T, inner);
}

function renderMastery() {
  const words = library();
  const buckets = [0, 0, 0, 0, 0, 0];
  words.forEach((w) => {
    const r = srsMap[w.lower];
    if (!r) { buckets[0]++; return; }
    const lv = masteryLevel(r);
    buckets[Math.max(1, Math.min(5, lv + 1))]++;
  });
  const labels = ['未学', '重学', '初级', '熟悉', '掌握', '长期'];
  const total = words.length || 1;
  $('masteryChart').innerHTML = labels.map((label, i) => `
    <div class="bar-row">
      <span>${label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(buckets[i] / total * 100)}%; opacity:${i === 0 ? .35 : 1}"></div></div>
      <span class="cnt">${buckets[i]}</span>
    </div>`).join('');
}

function renderStats() {
  renderHeatmap();
  renderMastery();
  renderCurve();
  renderWrongTrend();
  const total = Object.values(daily).reduce((n, d) => n + ((d && Number(d.reviews)) || 0), 0);
  $('totalReviewed').textContent = `累计 ${total} 次复习 · 拼写差一点 ${Number(stats.spellErrors) || 0} 次`;
  const next = Object.values(srsMap)
    .filter((r) => r && Number(r.due) > Date.now() && !isHiddenWord(r.word))
    .sort((a, b) => a.due - b.due)[0];
  $('nextDuePreview').textContent = next ? `下次复习：${dueText(next.due)}` : '还没有复习计划';
  $('endpointInput').value = settings.endpoint || '';
  $('reportToggle').checked = !!settings.report;
  $('reportState').textContent = settings.report && settings.endpoint ? '已开启' : '已关闭';
}

/* ---------- 本地备份 / 恢复 ----------
   导出只在本地生成 JSON：自建词库、SRS 复习记录、错题本、屏蔽表、设置、每日统计。
   导入采用合并策略（同词取较新记录），不删除现有更新的数据；v0.09 旧「导出进度」文件也能读。 */
const BACKUP_SCHEMA = 1;
const FIRST_BACKUP_HINT_KEY = 'wd-backup-export-hint-v1';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

async function buildProgressPayload() {
  const srsRecords = await DB.all('srs');
  return {
    app: 'word-desk',
    kind: 'backup',
    schemaVersion: BACKUP_SCHEMA,
    appVersion: CONFIG.version,
    exportedAt: new Date().toISOString(),
    data: {
      userWords: userWords.map((w) => ({
        word: w.word, meanings: w.meanings, pos: w.pos,
        prefixes: w.prefixes, suffixes: w.suffixes, phonetic: w.phonetic,
        freqRank: w.freqRank, origin: w.origin, source: w.source,
        examples: w.examples, examTags: w.examTags, lemma: w.lemma, exchange: w.exchange,
        confidence: w.confidence, affixConfidence: w.affixConfidence,
        createdAt: w.createdAt, updatedAt: w.updatedAt
      })),
      srs: srsRecords,
      wrongBook,
      blocked: blockedOrder.slice(),
      settings: Object.assign({}, settings),
      daily,
      stats,
      pasteList
    },
    summary: {
      userWords: userWords.length,
      srsRecords: srsRecords.length,
      wrongWords: wrongBook.length,
      blocked: blockedOrder.length,
      dailyDays: Object.keys(daily).length
    }
  };
}

async function exportProgress() {
  try {
    const payload = await buildProgressPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `word-desk-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const s = payload.summary;
    toast(`已导出本地备份：自建词 ${s.userWords} 条 · 复习记录 ${s.srsRecords} 条 · 屏蔽 ${s.blocked} 条。文件请自行保存。`);
    let firstHint = false;
    try { firstHint = localStorage.getItem(FIRST_BACKUP_HINT_KEY) !== '1'; } catch (e) { firstHint = false; }
    if (firstHint) {
      try { localStorage.setItem(FIRST_BACKUP_HINT_KEY, '1'); } catch (e) { /* 隐私模式静默 */ }
      setTimeout(() => toast('这份文件是唯一的进度副本，请自己保存'), 900);
    }
    track('backup_export', { userWords: s.userWords, srs: s.srsRecords });
  } catch (e) {
    toast('导出失败：' + (e && e.message ? e.message : e));
  }
}

function sanitizeBackupSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const merged = {};
  Object.keys(settings).forEach((k) => { merged[k] = settings[k]; });
  ['direction', 'answerType', 'count', 'dailyNew', 'listenRate', 'shuffle', 'haptic', 'includeSpell', 'showExamples', 'report', 'endpoint', 'libMode'].forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(src, k)) merged[k] = src[k];
  });
  if (!['en2zh', 'zh2en', 'listen'].includes(merged.direction)) merged.direction = 'en2zh';
  if (merged.direction === 'listen' && !FEATURES.listenDictation) merged.direction = 'en2zh';
  if (!['choice', 'input'].includes(merged.answerType)) merged.answerType = 'choice';
  if (!['10', '20', 'all'].includes(String(merged.count))) merged.count = '10';
  merged.count = String(merged.count);
  merged.dailyNew = Math.min(DAILY_NEW_MAX, Math.max(0, Number(merged.dailyNew) || 0));
  merged.listenRate = Number(merged.listenRate) === 0.8 ? 0.8 : 1;
  merged.shuffle = merged.shuffle !== false;
  merged.haptic = merged.haptic !== false;
  merged.includeSpell = merged.includeSpell !== false;
  merged.showExamples = !!merged.showExamples;
  if (merged.direction === 'listen' && !merged.includeSpell) merged.direction = 'en2zh';
  merged.report = !!merged.report;
  // 上报地址只接受本站同源或 https 端点：备份恢复不引入任意 http(s) 上报目标
  if (typeof merged.endpoint === 'string' && merged.endpoint) {
    try {
      const u = new URL(merged.endpoint, location.href);
      if (u.origin !== location.origin && u.protocol !== 'https:') merged.endpoint = '';
      else merged.endpoint = u.href;
    } catch (e) { merged.endpoint = ''; }
  } else merged.endpoint = '';
  merged.libMode = ['all', 'builtin', 'user'].includes(merged.libMode) ? merged.libMode : 'all';
  return merged;
}

/* 旧备份缺字段时补齐 FSRS 默认值，坏记录直接丢弃，不让一条脏数据卡住整次恢复 */
function normalizeSrsRecord(raw) {
  if (!isPlainObject(raw)) return null;
  const key = normalizeEnglish(raw.word);
  if (!key) return null;
  const base = FSRS.empty(key);
  const rec = Object.assign({}, base, raw, { word: key });
  rec.history = Array.isArray(raw.history)
    ? raw.history.filter((h) => isPlainObject(h)).map((h) => ({
        t: Number(h.t) >= 0 ? Number(h.t) : 0,
        rating: [1, 2, 3, 4].includes(Number(h.rating)) ? Number(h.rating) : 3,
        ms: Number(h.ms) >= 0 ? Math.floor(Number(h.ms)) : null,
        correct: !!h.correct
      })).slice(-12)
    : [];
  ['stability', 'difficulty', 'due', 'interval', 'reps', 'lapses', 'lastReview', 'firstReview', 'step'].forEach((k) => {
    const n = Number(rec[k]);
    rec[k] = Number.isFinite(n) && n >= 0 ? n : base[k];
  });
  ['reps', 'lapses', 'step'].forEach((k) => { rec[k] = Math.floor(rec[k]); });
  rec.step = Math.min(1, rec.step);
  rec.difficulty = Math.min(10, rec.difficulty);
  rec.stability = Math.min(365, rec.stability);
  rec.interval = Math.min(365, rec.interval);
  if (!['new', 'learning', 'relearning', 'review'].includes(rec.state)) rec.state = base.state;
  return rec;
}

function normalizeWrongEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const w = makeWord(raw, 'user');
  if (!w) return null;
  return {
    word: w.word, meanings: w.meanings, pos: w.pos,
    prefixes: w.prefixes, suffixes: w.suffixes,
    count: Math.max(1, Math.min(999999, Number(raw.count) || 1)),
    createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
    lastAt: Number(raw.lastAt) > 0 ? Number(raw.lastAt) : (Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now())
  };
}

function normalizeDaily(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  Object.entries(raw).forEach(([day, record]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isPlainObject(record)) return;
    const values = {};
    ['answers', 'correct', 'reviews', 'newWords', 'wrongAdded', 'wrongTotal', 'drills', 'spellErrors'].forEach((key) => {
      const n = Number(record[key]);
      if (Number.isSafeInteger(n) && n >= 0) values[key] = n;
    });
    out[day] = values;
  });
  return out;
}

function parseBackup(raw) {
  if (!isPlainObject(raw)) throw new Error('文件内容不是有效的 JSON 对象');
  if (raw.app !== 'word-desk') throw new Error('这不是单词练习台的备份文件（缺少 app: "word-desk" 标记）');
  const schema = raw.schemaVersion == null ? 0 : Number(raw.schemaVersion);
  if (!Number.isFinite(schema) || schema < 0) throw new Error('备份的 schemaVersion 字段无效');
  if (schema > BACKUP_SCHEMA) throw new Error(`备份版本 ${schema} 比当前应用（${BACKUP_SCHEMA}）新，请先更新应用再恢复`);
  // v0.09 的「导出进度」没有 data 层，字段直接挂在顶层
  const d = isPlainObject(raw.data) ? raw.data : raw;
  const userWordsIn = (Array.isArray(d.userWords) ? d.userWords : [])
    .map((w) => makeWord(w, 'user')).filter(Boolean);
  const srsIn = (Array.isArray(d.srs) ? d.srs : []).map(normalizeSrsRecord).filter(Boolean);
  const wrongIn = (Array.isArray(d.wrongBook) ? d.wrongBook : []).map(normalizeWrongEntry).filter(Boolean);
  const blockedIn = (Array.isArray(d.blocked) ? d.blocked : [])
    .map((w) => normalizeEnglish(typeof w === 'string' ? w : (w && w.word))).filter(Boolean);
  const pasteIn = isPlainObject(d.pasteList) && Array.isArray(d.pasteList.words) && d.pasteList.words.length
    ? {
        words: d.pasteList.words.map((x) => normalizeEnglish(x)).filter(Boolean),
        createdAt: Number(d.pasteList.createdAt) || Date.now()
      }
    : null;
  return {
    schema,
    appVersion: String(raw.appVersion || ''),
    exportedAt: String(raw.exportedAt || ''),
    userWords: userWordsIn,
    srs: srsIn,
    wrongBook: wrongIn,
    blocked: blockedIn,
    settings: sanitizeBackupSettings(d.settings),
    daily: normalizeDaily(d.daily),
    stats: isPlainObject(d.stats) ? d.stats : {},
    pasteList: pasteIn
  };
}

function backupPreviewHTML(b) {
  const when = b.exportedAt ? b.exportedAt.replace('T', ' ').slice(0, 16) : '未知时间';
  const ver = b.appVersion ? ` · 应用版本 ${esc(b.appVersion)}` : '';
  return `<p>备份导出时间：<b>${esc(when)}</b>${ver}</p>
    <p>将合并恢复：<b>${b.userWords.length}</b> 个自建词条 · <b>${b.srs.length}</b> 条复习记录 · <b>${b.wrongBook.length}</b> 个错题 · <b>${b.blocked.length}</b> 个屏蔽词。</p>
    <p>同词取较新的记录，不删除本机更新的数据；恢复完成后页面会自动重载。</p>`;
}

let pendingBackup = null;

async function handleBackupFile(file) {
  if (!file) return;
  const msg = $('backupMsg');
  if (msg) { msg.className = 'import-errors'; msg.textContent = ''; }
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，可能不是备份文件');
    const text = await file.text();
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：文件可能已损坏或被截断'); }
    pendingBackup = parseBackup(raw);
    $('backupPreview').innerHTML = backupPreviewHTML(pendingBackup);
    $('backupModal').hidden = false;
  } catch (e) {
    pendingBackup = null;
    const text = '恢复失败：' + (e && e.message ? e.message : e) + '。现有数据没有改动。';
    if (msg) { msg.textContent = text; }
    toast(text);
    track('backup_import_fail', { reason: String(e && e.message || e).slice(0, 120) });
  } finally {
    const input = $('backupInput');
    if (input) input.value = '';
  }
}

/* 恢复前快照：失败时用它把内存态还原到恢复前 */
function snapshotLocalState() {
  return {
    settings: Object.assign({}, settings),
    blockedOrder: blockedOrder.slice(),
    userWords: userWords.slice(),
    srsMap: Object.assign(Object.create(null), srsMap),
    wrongBook: wrongBook.slice(),
    daily: JSON.parse(JSON.stringify(daily)),
    stats: Object.assign({}, stats),
    pasteList: pasteList ? { words: pasteList.words.slice(), createdAt: pasteList.createdAt } : null
  };
}

function restoreLocalState(snap) {
  Object.keys(settings).forEach((k) => delete settings[k]);
  Object.assign(settings, snap.settings);
  blockedOrder = snap.blockedOrder;
  blockedWords = new Set(blockedOrder);
  userWords = snap.userWords;
  srsMap = snap.srsMap;
  wrongBook = snap.wrongBook;
  Object.keys(daily).forEach((k) => delete daily[k]);
  Object.assign(daily, snap.daily);
  Object.keys(stats).forEach((k) => delete stats[k]);
  Object.assign(stats, snap.stats);
  pasteList = snap.pasteList;
}

/* 撤销已落盘的写入：kv 写回快照值；记录按「原来有则写回、原来没有则删除」 */
async function rollbackBackupWrites(ops) {
  for (const op of ops.slice().reverse()) {
    try {
      if (op.store === 'kv') {
        if (op.prev == null) await DB.del('kv', op.key);
        else await DB.put('kv', { key: op.key, value: op.prev });
      } else {
        for (const rec of (op.revert || []).slice().reverse()) {
          if (rec.prev) await DB.put(op.store, rec.prev);
          else await DB.del(op.store, rec.key);
        }
      }
    } catch (e) { /* 回滚尽力而为，不掩盖原始错误 */ }
  }
}

/* 备份恢复：先写数据、最后写设置；任何一步失败都按快照回滚 */
async function applyBackup(b) {
  // 丢弃尚未落盘的旧防抖写入，避免恢复后又被旧值覆盖
  clearTimeout(kvTimer);
  Object.keys(pendingKV).forEach((k) => delete pendingKV[k]);

  const snap = snapshotLocalState();
  const revert = [];
  try {
    const blockedIn = Array.isArray(b.blocked) ? b.blocked : [];
    const blockedSet = new Set(blockedOrder);
    const nextBlocked = blockedOrder.slice();
    blockedIn.forEach((k) => { if (!blockedSet.has(k)) { blockedSet.add(k); nextBlocked.push(k); } });
    await DB.put('kv', { key: 'blocked', value: nextBlocked });
    revert.push({ store: 'kv', key: 'blocked', prev: snap.blockedOrder });
    blockedOrder = nextBlocked;
    blockedWords = blockedSet;

    // 自建词：同词取 updatedAt 较新的一条
    const userOps = [];
    (b.userWords || []).forEach((w) => {
      if (!w || !w.lower) return;
      const idx = userWords.findIndex((x) => x.lower === w.lower);
      if (idx >= 0 && (Number(userWords[idx].updatedAt) || 0) >= (Number(w.updatedAt) || 0)) return;
      const prev = idx >= 0 ? userWords[idx] : null;
      if (idx >= 0) userWords[idx] = w; else userWords.push(w);
      userOps.push({ w, prev, key: w.lower });
    });
    for (const op of userOps) {
      await DB.put('userWords', op.w);
      revert.push({ store: 'userWords', revert: [{ prev: op.prev, key: op.key }] });
    }

    // SRS：同词取 lastReview 较新的一条
    const srsOps = [];
    (b.srs || []).forEach((r) => {
      if (!r || !r.word) return;
      const existing = srsMap[r.word];
      if (existing && (Number(existing.lastReview) || 0) >= (Number(r.lastReview) || 0)) return;
      srsMap[r.word] = r;
      srsOps.push({ w: r, prev: existing || null, key: r.word });
    });
    for (const op of srsOps) {
      await DB.put('srs', op.w);
      revert.push({ store: 'srs', revert: [{ prev: op.prev, key: op.key }] });
    }

    // 错题本：次数无条件取最大；lastAt 只决定其余字段取哪边
    (b.wrongBook || []).forEach((x) => {
      const key = normalizeEnglish(x.word);
      const idx = wrongBook.findIndex((y) => normalizeEnglish(y.word) === key);
      if (idx >= 0) {
        const prev = wrongBook[idx];
        const base = (Number(x.lastAt) || 0) > (Number(prev.lastAt) || 0)
          ? Object.assign({}, prev, x)
          : Object.assign({}, x, prev);
        base.count = Math.max(Number(prev.count) || 1, Number(x.count) || 1);
        base.lastAt = Math.max(Number(prev.lastAt) || 0, Number(x.lastAt) || 0);
        wrongBook[idx] = base;
      } else {
        wrongBook.unshift(x);
      }
    });
    await DB.put('kv', { key: 'wrong', value: wrongBook.slice() });
    revert.push({ store: 'kv', key: 'wrong', prev: snap.wrongBook });

    // 每日统计：按日期逐项取较大值，避免同一轮练习被重复计数
    b.daily = normalizeDaily(b.daily);
    Object.keys(b.daily).forEach((day) => {
      const inc = b.daily[day];
      if (!isPlainObject(inc)) return;
      if (!isPlainObject(daily[day])) { daily[day] = Object.assign({}, inc); return; }
      Object.keys(inc).forEach((k) => {
        if (typeof inc[k] === 'number') daily[day][k] = Math.max(Number(daily[day][k]) || 0, inc[k]);
      });
    });
    Object.keys(isPlainObject(b.stats) ? b.stats : {}).forEach((k) => {
      const n = Number(b.stats[k]);
      if (Number.isSafeInteger(n) && n >= 0) stats[k] = Math.max(Number(stats[k]) || 0, n);
    });
    await DB.put('kv', { key: 'daily', value: daily });
    revert.push({ store: 'kv', key: 'daily', prev: snap.daily });
    await DB.put('kv', { key: 'stats', value: stats });
    revert.push({ store: 'kv', key: 'stats', prev: snap.stats });

    if (b.pasteList) {
      pasteList = b.pasteList;
      await DB.put('kv', { key: 'pasteList', value: pasteList });
      revert.push({ store: 'kv', key: 'pasteList', prev: snap.pasteList });
    }

    // 设置最后写：前面的数据都成功落盘后才覆盖每日上限/方向等
    await DB.put('kv', { key: 'settings', value: b.settings });
    revert.push({ store: 'kv', key: 'settings', prev: snap.settings });
    Object.assign(settings, b.settings);
  } catch (e) {
    restoreLocalState(snap);
    await rollbackBackupWrites(revert);
    throw e;
  }

  track('backup_import_ok', { userWords: (b.userWords || []).length, srs: (b.srs || []).length });
  toast('恢复完成，页面即将重载');
  setTimeout(() => location.reload(), 300);
}

/* ---------- 简化版 FSRS 调度（自包含，无依赖） ----------
   目标记忆保持率 desiredRetention = 0.9，学习步骤 1 分钟 / 10 分钟，
   最大间隔 365 天。字段命名对齐 FSRS：stability / difficulty / state。 */
const FSRS = (() => {
  const RETENTION = 0.9;
  const MAX_IVL = 365;
  const DECAY = -0.5;
  const FACTOR = 19 / 81;
  const STEP_1M = 1 / 1440;
  const STEP_10M = 10 / 1440;
  const INIT_S = [0.4, 1.18, 3.17, 15.69];
  const INIT_D = 7.19;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function retrievability(elapsedDays, stability) {
    if (stability <= 0) return 0;
    return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
  }
  function initDifficulty(rating) { return clamp(INIT_D - (rating - 3) * 0.53, 1, 10); }
  function initStability(rating) { return Math.max(0.2, INIT_S[rating - 1] || 3); }
  function nextDifficulty(d, rating) {
    const nd = d + (3 - rating) * 0.5;
    return clamp(0.95 * nd + 0.05 * INIT_D, 1, 10);
  }
  function nextStabilityOk(d, s, r, rating) {
    const hardPenalty = rating === 2 ? 0.8 : 1;
    const easyBonus = rating === 4 ? 1.3 : 1;
    const inc = Math.exp(1.54575) * (11 - d) * Math.pow(Math.max(0.2, s), -0.1192) *
      (Math.exp((1 - Math.max(0, Math.min(1, r))) * 1.01925) - 1) * hardPenalty * easyBonus;
    return clamp(s * (1 + inc), 0.2, MAX_IVL);
  }
  function nextStabilityFail(d, s, r) {
    return clamp(Math.pow(d, -0.3) * (Math.pow(Math.max(0.2, s) + 1, 0.5) - 1) * Math.exp(0.5 * (1 - Math.max(0, Math.min(1, r)))), 0.2, MAX_IVL);
  }
  function intervalFromStability(s) {
    return clamp(Math.round(s * (Math.log(RETENTION) / Math.log(0.9))), 1, MAX_IVL);
  }

  function empty(word) {
    return {
      word,
      stability: 0,
      difficulty: 0,
      state: 'new',
      step: 0,
      due: Date.now(),
      interval: 0,
      reps: 0,
      lapses: 0,
      lastReview: 0,
      firstReview: 0,
      history: []
    };
  }

  /* rating: 1 忘记 / 2 勉强 / 3 记住 / 4 轻松 */
  function schedule(rec, rating, now) {
    const r = Object.assign({}, rec);
    const wasNew = r.state === 'new' || r.reps === 0;
    const elapsed = r.lastReview ? Math.max(0, (now - r.lastReview) / 86400000) : 0;
    const R = r.stability > 0 ? retrievability(elapsed, r.stability) : 0;
    r.reps = (r.reps || 0) + 1;
    r.lastReview = now;
    if (!r.firstReview) r.firstReview = now;

    if (rating === 1) {
      r.lapses = (r.lapses || 0) + 1;
      r.difficulty = wasNew ? initDifficulty(1) : nextDifficulty(r.difficulty, 1);
      r.stability = wasNew ? initStability(1) : nextStabilityFail(r.difficulty, r.stability, R);
      r.state = wasNew ? 'learning' : 'relearning';
      r.step = 0;
      r.interval = STEP_1M;
      r.due = now + STEP_1M * 86400000;
    } else if (wasNew) {
      r.difficulty = initDifficulty(rating);
      r.stability = initStability(rating);
      if (rating === 4) {
        r.state = 'review';
        r.step = 0;
        r.interval = intervalFromStability(r.stability);
        r.due = now + r.interval * 86400000;
      } else {
        r.state = 'learning';
        r.step = rating === 2 ? 0 : 1;
        r.interval = rating === 2 ? STEP_1M : STEP_10M;
        r.due = now + r.interval * 86400000;
      }
    } else if (r.state === 'learning' || r.state === 'relearning') {
      r.difficulty = nextDifficulty(r.difficulty, rating);
      r.stability = nextStabilityOk(r.difficulty, r.stability, R, rating);
      if (rating === 2) {
        r.step = 0;
        r.interval = STEP_1M;
        r.due = now + STEP_1M * 86400000;
      } else if (rating === 3 && r.step === 0) {
        r.step = 1;
        r.interval = STEP_10M;
        r.due = now + STEP_10M * 86400000;
      } else {
        r.state = 'review';
        r.step = 0;
        r.interval = Math.max(1, intervalFromStability(r.stability));
        r.due = now + r.interval * 86400000;
      }
    } else {
      r.difficulty = nextDifficulty(r.difficulty, rating);
      if (rating === 1) {
        r.stability = nextStabilityFail(r.difficulty, r.stability, R);
        r.state = 'relearning';
        r.step = 0;
        r.interval = STEP_1M;
        r.due = now + STEP_1M * 86400000;
      } else {
        r.stability = nextStabilityOk(r.difficulty, r.stability, R, rating);
        r.interval = Math.max(1, intervalFromStability(r.stability));
        r.state = 'review';
        r.due = now + r.interval * 86400000;
      }
    }
    r.history = (r.history || []).concat({ t: now, rating, ms: null }).slice(-12);
    return r;
  }

  return { empty, schedule, retrievability };
})();

/* ---------- 每日统计 / 埋点 ---------- */
/* events 只是本地行为日志（导出/上报用）；复习计划由 srs 表驱动，与此无关。
   IDB 里的旧事件此前从不删除，会随使用天数无限增长；这里按 CONFIG.maxEvents
   裁掉最旧的，和内存数组、localStorage 降级路径的上限保持一致。 */
async function pruneStoredEvents() {
  try {
    const rows = (await DB.all('events')) || [];
    if (rows.length <= CONFIG.maxEvents) return;
    rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const drop = rows.slice(0, rows.length - CONFIG.maxEvents);
    for (const e of drop) { if (e && e.id) await DB.del('events', e.id); }
  } catch (e) { /* 清理失败不影响主流程，下次启动再试 */ }
}

function todayRec() {
  const k = dateKey();
  if (!daily[k]) daily[k] = { answers: 0, correct: 0, reviews: 0, newWords: 0, wrongAdded: 0, wrongTotal: wrongBook.length, drills: 0 };
  return daily[k];
}

function track(name, props) {
  const ev = { id: uid(), name, ts: Date.now(), date: dateKey(), props: props || {} };
  events.push(ev);
  if (events.length > CONFIG.maxEvents) events = events.slice(-CONFIG.maxEvents);
  // 埋点是可丢数据：写不进去不影响学习进度，也不弹保存失败提示
  DB.put('events', ev).catch(() => null);
}

async function flushAnalytics() {
  if (!settings.report || !settings.endpoint) {
    toast('先在设置里填写上报端点并开启');
    return;
  }
  const batch = events.filter((e) => !e.sentAt).slice(0, 500);
  if (!batch.length) { toast('没有待上报事件'); return; }
  try {
    const res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'word-translation-practice', version: CONFIG.version, events: batch })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    for (const e of batch) {
      e.sentAt = Date.now();
      try { await DB.put('events', e); } catch (err) { toastSaveFail(); break; }
    }
    toast(`已上报 ${batch.length} 条事件`);
  } catch (e) {
    toast('上报失败，事件仍保留在本机');
  }
}

/* ---------- 复习队列 ---------- */
function countTodayNew() {
  const lib = library();
  const libIndex = lib.index || (lib.index = new Map(lib.map((w) => [w.lower, w])));
  return Object.values(srsMap).filter((r) => r && r.firstReview && !r.fromDrill && libIndex.has(r.word) && dateKey(new Date(r.firstReview)) === dateKey()).length;
}

function buildQueue(source, count, doShuffle, drillRoot) {
  let words = [];
  if (source === 'review') {
    const now = Date.now();
    const lib = library();
    const libIndex = lib.index || (lib.index = new Map(lib.map((w) => [w.lower, w])));
    const cap = DAILY_REVIEW_CAP;
    const due = Object.values(srsMap)
      .filter((r) => r && r.due <= now && libIndex.has(r.word))
      .sort((a, b) => a.due - b.due)
      .slice(0, cap);
    const remainingNew = Math.max(0, settings.dailyNew - countTodayNew());
    const newPool = lib.filter((w) => !srsMap[w.lower]);
    const ratioCap = due.length ? Math.max(3, Math.ceil(due.length / 3)) : remainingNew;
    const newTake = Math.min(remainingNew, ratioCap, newPool.length);
    const fresh = (doShuffle ? shuffle(newPool) : newPool).slice(0, newTake);
    words = due.map((r) => libIndex.get(r.word)).concat(fresh);
  } else if (source === 'filter') {
    words = filteredWords();
  } else if (source === 'library') {
    words = library();
  } else if (source === 'list') {
    const list = pasteList && Array.isArray(pasteList.words) ? pasteList.words : [];
    words = list.map((l) => findWord(l)).filter(Boolean);
  } else if (source === 'drill') {
    const r = rootData && rootData.roots ? rootData.roots[drillRoot] : null;
    words = (r ? r.family : []).map((l) => findWord(l)).filter(Boolean);
  } else {
    words = wrongBook
      .filter((x) => !isHiddenWord(x.word))
      .map((x) => findWord(x.word.toLowerCase()) || makeWord(x, 'user'))
      .filter(Boolean);
  }
  if (doShuffle && source !== 'review') words = shuffle(words);
  if (source === 'drill') return words.slice(0, ROOT_DRILL_MAX);
  const cap = count === 'all' ? words.length : Math.min(words.length, Number(count) || 10);
  return words.slice(0, cap);
}

/* ---------- 训练卡片与阶段 ---------- */
const STEP_LABELS = { breakdown: '拆解', clue: '线索', guess: '猜义', reveal: '验证', recall: '拼写', listen: '听音' };
const DIR_LABELS = { en2zh: '英译中', zh2en: '中译英', listen: '听音拼写' };
function directionLabel(dir) { return DIR_LABELS[dir] || '英译中'; }

function makeCard(w) {
  let dir = settings.direction;
  let audioGated = false;
  // 听音拼写依赖拼写阶段：关闭「练习含拼写」时回落英译中（比藏按钮更小改动）
  if (dir === 'listen' && settings.includeSpell === false) {
    dir = 'en2zh';
  }
  // 硬门槛：听音方向只给音频索引里真实存在的词，查不到的词降为文字练习并说明原因
  if (dir === 'listen' && !hasOfflineAudio(w)) {
    dir = 'en2zh';
    audioGated = true;
  }
  const conf = wordConfidence(w);
  let steps;
  if (dir === 'listen') {
    // 听音拼写是独立卡型：只看发音拼写，不展示原词，因此不进入拆解/猜义
    steps = ['listen', 'reveal'];
  } else if (dir === 'en2zh') {
    const hasAffix = w.prefixes.length || w.suffixes.length;
    if (!hasAffix) steps = ['guess', 'reveal', 'recall']; // 无词缀：跳过无信息量的拆解
    else if (conf >= AFFIX_MIN_CONF) steps = ['breakdown', 'guess', 'reveal', 'recall'];
    else steps = ['guess', 'reveal', 'recall']; // 低置信：拆解不可靠就不展示，猜义照常（学习强度一致）
  } else {
    steps = ['clue', 'guess', 'reveal', 'recall'];
  }
  // 关闭拼写：从步骤里去掉 recall（听音方向已在上方回落，不会走到 listen 步）
  if (settings.includeSpell === false) {
    steps = steps.filter((s) => s !== 'recall');
  }
  return demoteListenSteps({
    word: w,
    dir,
    audioGated,
    method: settings.answerType,
    confidence: conf,
    steps,
    step: 0,
    stageShownAt: Date.now(),
    guess: '',
    guessOk: null,
    guessMs: 0,
    choices: [],
    selected: -1,
    recallOk: null,
    result: null,
    record: null,
    audioPlayed: false,
    audioAutoTried: false,
    listenFailed: false,
    listenFallback: ''
  });
}

/* 听音拼写下架后的兜底：任何来源的 listen 步骤都安全降级为普通拼写
   （历史队列 / 旧 kv 里残留的 listen 卡型都走这里，不播放、不报错） */
function demoteListenSteps(card) {
  if (!card || FEATURES.listenDictation) return card;
  const i = Array.isArray(card.steps) ? card.steps.indexOf('listen') : -1;
  if (i >= 0) {
    card.steps[i] = 'recall';
    card.dir = 'en2zh';
    card.listenDemoted = true;
  }
  return card;
}

function currentCard() {
  return session && session.queue[session.index] ? session.queue[session.index] : null;
}

function cardStage(card) {
  return card.steps[card.step] || 'result';
}

function stepLabelFor(card, step) {
  if (step === 'recall' && card.dir === 'zh2en') return '回忆';
  return STEP_LABELS[step] || step;
}

/* 步骤序号以 card.steps 实际位置为准，避免无词缀流程写死「第 3 步」 */
function stepPrefix(card, stage) {
  const i = card.steps.indexOf(stage);
  return i >= 0 ? `第 ${i + 1} 步 · ` : '';
}

function letterPattern(word) {
  const chars = word.split('');
  return chars.map((ch, i) => (i === 0 || i === chars.length - 1 ? ch : '·')).join('');
}

function wordMetaHTML(w) {
  return `<div class="meta-line">
    ${w.pos.length ? `<span class="tag pos">${esc(w.pos.join('/'))}</span>` : ''}
    ${w.phonetic ? `<span class="tag">${esc(w.phonetic)}</span>` : ''}
    ${Number.isFinite(w.freqRank) ? `<span class="tag">词频 #${esc(w.freqRank)}</span>` : ''}
    ${(w.examTags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
  </div>`;
}

/* ---------- 词根数据（教学层；content/roots.json + 内置副本） ---------- */
let rootData = (typeof ROOT_DATA !== 'undefined') ? ROOT_DATA : null;
const ROOT_CONF_MIN = 0.75;
const ROOT_DRILL_MIN = 2;
const ROOT_DRILL_MAX = 8;

function rootEntry(w) {
  if (!rootData || !w) return null;
  const key = w.lower || String(w.word || '').toLowerCase();
  if (rootData.overall && rootData.overall[key]) return { overall: true, note: rootData.overall[key] };
  const row = rootData.words && rootData.words[key];
  if (!row) return null;
  if (!row.segmentable || row.confidence < ROOT_CONF_MIN) {
    return { overall: true, note: row.note || '词根切分置信度较低，按整体记忆' };
  }
  return { row, root: rootData.roots[row.rootId] || null };
}

function rootFamily(root, selfLower) {
  if (!root || !Array.isArray(root.family)) return [];
  return root.family.filter((x) => x !== selfLower && !isHiddenWord(x)).slice(0, 5);
}

function rootRowsHTML(w, entry, opts) {
  const o = opts || {};
  const row = entry.row;
  const rows = [];
  (row.segments || []).forEach((s) => {
    if (s.type === 'prefix') {
      rows.push(`<div class="affix-row"><span class="affix-tag pre">${esc(s.text)}</span><span class="mean">前缀 · ${esc(s.gloss_zh || '含义未知')}</span></div>`);
    } else if (s.type === 'root') {
      rows.push(`<div class="affix-row"><span class="affix-tag root">${esc(s.text)}</span><span class="mean">词根 · ${esc(s.gloss_zh || row.rootZh || '')}</span></div>`);
    } else if (s.type === 'suffix') {
      rows.push(`<div class="affix-row"><span class="affix-tag suf">${esc(s.text)}</span><span class="mean">后缀 · ${esc(s.gloss_zh || '含义未知')}</span></div>`);
    } else if (s.type === 'base' && s.text) {
      rows.push(`<div class="affix-row"><span class="affix-tag base">${esc(s.text)}</span><span class="mean">词干</span></div>`);
    }
  });
  if (!rows.length) rows.push('<div class="affix-row"><span class="affix-tag base">整体记忆</span><span class="mean">暂无可用切分</span></div>');

  const fam = (o.family === false) ? [] : rootFamily(entry.root, w.lower);
  const famHTML = fam.length
    ? `<div class="root-family"><span class="rf-label">同族词</span>${fam.map((x) => `<span class="rf-word">${esc(x)}</span>`).join('')}</div>`
    : '';
  const notes = [];
  if (entry.root && entry.root.homograph) notes.push(entry.root.homograph);
  return `<div class="affix-list">${rows.join('')}</div>${famHTML}
    ${notes.map((n) => `<p class="hint-line">${esc(n)}</p>`).join('')}`;
}

function affixRowsHTML(w, opts) {
  const entry = rootEntry(w);
  if (entry && entry.overall) {
    return `<div class="affix-list"><div class="affix-row"><span class="affix-tag base">整体记忆</span><span class="mean">${esc(entry.note)}</span></div></div>
      <p class="hint-line">这个词不按词根硬拆，记住整体意思更可靠。</p>`;
  }
  if (entry && entry.row) return rootRowsHTML(w, entry, opts);
  const parts = splitAffixes(w);
  const rows = [];
  parts.prefix.forEach((t) => rows.push(`<div class="affix-row"><span class="affix-tag pre">${esc(t)}</span><span class="mean">前缀 · ${esc(AFFIX_INFO[t] || '含义未知')}</span></div>`));
  if (!parts.prefix.length && !parts.suffix.length) {
    rows.push('<div class="affix-row"><span class="affix-tag base">基础词</span><span class="mean">整体记忆</span></div>');
  } else {
    rows.push(`<div class="affix-row"><span class="affix-tag base">${esc(parts.stem)}</span><span class="mean">词干</span></div>`);
  }
  parts.suffix.forEach((t) => rows.push(`<div class="affix-row"><span class="affix-tag suf">${esc(t)}</span><span class="mean">后缀 · ${esc(AFFIX_INFO[t] || '含义未知')}</span></div>`));
  return `<div class="affix-list">${rows.join('')}</div>`;
}

function stageBarHTML(card) {
  const finished = card.result != null;
  const stageOk = (s) => (s === 'guess' ? card.guessOk : s === 'recall' || s === 'listen' ? card.recallOk : true);
  const items = card.steps.map((s, i) => {
    const passed = finished || i < card.step;
    const cls = passed ? 'done' : i === card.step ? 'active' : '';
    let mark = passed ? '✓' : i + 1;
    let miss = false;
    if (passed) {
      const ok = stageOk(s);
      if (ok === false) { mark = '×'; miss = true; }
      else if (ok === null) mark = i + 1;
    }
    return `<div class="stage-item ${cls}${miss ? ' miss' : ''}"><span class="num">${mark}</span><span>${esc(stepLabelFor(card, s))}</span></div>`;
  });
  return `<div class="stage-bar" aria-label="本题内部流程"><span class="stage-kicker">本题</span>${items.join('<span class="stage-sep"></span>')}</div>`;
}

function breakdownHTML(card) {
  const w = card.word;
  const low = card.confidence < AFFIX_MIN_CONF;
  return `
    <div class="reveal-anim">
      <div class="prompt-label">第 1 步 · 先拆一下（辅助）</div>
      <div class="word-display">${wordDisplayHTML(w)}</div>
      ${wordMetaHTML(w)}
      ${affixRowsHTML(w)}
      <p class="hint-line">这一步只帮你认识词缀，不评分；看完点下一步。</p>
      <div class="action-row">
        <button class="btn primary" type="button" data-action="next-stage">${low ? '看标准答案 →' : '开始猜义 →'}</button>
        <span class="spacer"></span>
        <span class="hint-line kbd-hint">Enter 继续</span>
      </div>
    </div>`;
}

function clueHTML(card) {
  const w = card.word;
  const high = card.confidence >= AFFIX_MIN_CONF;
  return `
    <div class="reveal-anim">
      <div class="prompt-label">第 1 步 · 从释义回想单词</div>
      <div class="meaning-list">${w.meanings.map((m, i) => `<div class="meaning-item"><span class="idx">${i + 1}</span><span>${esc(m)}</span></div>`).join('')}</div>
      ${wordMetaHTML(w)}
      <div class="affix-list">
        <div class="affix-row"><span class="affix-tag base">${esc(letterPattern(w.word))}</span></div>
      </div>
      ${high ? affixRowsHTML(w, { family: false }) : ''}
      <div class="action-row">
        <button class="btn primary" type="button" data-action="next-stage">开始拼写 →</button>
        <span class="spacer"></span>
        <span class="hint-line kbd-hint">Enter 继续</span>
      </div>
    </div>`;
}

function choiceHTML(card) {
  if (!card.choices.length) buildChoices(card);
  return `<div class="choice-list">${card.choices.map((opt, i) => `
    <button class="choice${card.selected === i ? ' selected' : ''}" type="button" data-choice="${i}">
      <span class="key">${i + 1}</span><span>${esc(opt.text)}</span>
    </button>`).join('')}</div>`;
}

function guessHTML(card) {
  const w = card.word;
  const isEn = card.dir === 'en2zh';
  ensureChoices(card);
  return `
    <div class="reveal-anim">
      <div class="prompt-label">${stepPrefix(card, 'guess')}${isEn ? '猜中文意思' : '写出英文单词'}</div>
      ${isEn
        ? `<div class="word-display small">${wordDisplayHTML(w)}</div>
           <div class="word-tools"><button class="speak-btn" type="button" data-action="speak-word" aria-label="播放单词发音"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 6.2h2.2L8.5 3.4v9.2L5.2 9.8H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10.6 5.6a3 3 0 0 1 0 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>发音</span></button><button class="block-word-btn" type="button" data-action="block-word" aria-label="不再出现这个词" title="不再出现这个词">别出现</button></div>
           <p class="hint-line">${card.steps.includes('breakdown') ? '根据刚才的词缀拆解，猜一猜它的中文意思。' : '根据词形线索，猜一猜它的中文意思。'}</p>`
        : `<div class="meaning-list">${w.meanings.map((m, i) => `<div class="meaning-item"><span class="idx">${i + 1}</span><span>${esc(m)}</span></div>`).join('')}</div>
           <p class="hint-line">根据释义、词性和字母提示，写出对应的英文单词。</p>`}
      <div class="answer-box">
        ${card.method === 'choice'
          ? choiceHTML(card)
          : `<input class="answer-input" id="guessInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="${isEn ? '写下你的中文猜测，例如“不快乐的”' : '输入英文单词'}" value="${esc(card.guessTyped || '')}" />`}
      </div>
      <div class="action-row">
        <button class="btn primary" type="button" data-action="submit-guess">${card.method === 'choice' ? '提交选择' : '提交猜测'}</button>
        <button class="btn ghost" type="button" data-action="skip-guess">不确定，直接看答案</button>
        <span class="spacer"></span>
        ${card.method === 'choice' ? '<span class="hint-line kbd-hint">数字键 1-4 选择 · Enter 提交</span>' : '<span class="hint-line kbd-hint">Enter 提交</span>'}
      </div>
    </div>`;
}

function verdictHTML(kind, mark, text) {
  return `<div class="verdict ${kind}" role="status" aria-live="polite"><span class="verdict-mark">${mark}</span><div>${text}</div></div>`;
}

function revealHTML(card) {
  const w = card.word;
  let verdict;
  if (card.dir === 'listen') {
    verdict = card.recallOk
      ? verdictHTML('good', '✓', `听写正确：<strong>${esc(w.word)}</strong>。`)
      : verdictHTML('bad', '×', `这次没听对，正确拼写是 <strong>${esc(w.word)}</strong>。`);
  } else if (card.listenDemoted) {
    verdict = verdictHTML('skip', '—', '听音拼写不可用，这题按普通拼写继续。<strong>下面是拆解与答案</strong>。');
  } else if (card.guessOk === null) {
    verdict = verdictHTML('skip', '—', '你跳过了猜义。<strong>没关系</strong>，下面用拼写验证来确认记忆。');
  } else if (card.dir === 'zh2en' && card.guessGrade === 'close') {
    verdict = verdictHTML('skip', '≈', `意思对了，拼写差一点：你写的是 <strong>${esc(card.guess)}</strong>，正确拼写 <strong>${esc(w.word)}</strong>。这次算难，拼写错误单独计数。`);
  } else if (card.dir === 'zh2en' && card.guessGrade === 'synonym') {
    verdict = verdictHTML('good', '✓', `同义也算对：<strong>${esc(card.guess)}</strong> 同样表示这个释义。这题的标准答案是 <strong>${esc(w.word)}</strong>。`);
  } else if (card.guessOk) {
    const affixHint = card.steps.includes('breakdown') ? '词缀推理方向是对的。' : '';
    verdict = verdictHTML('good', '✓', `猜义命中：<strong>${esc(card.guess)}</strong>。${affixHint}`);
  } else {
    const tail = card.steps.includes('breakdown') ? '对照下面的拆解再看一遍。' : '对照下面的答案和释义再看一遍。';
    verdict = verdictHTML('bad', '×', `你的猜测：<strong>${esc(card.guess || '（空）')}</strong>，和标准答案有差距。${tail}`);
  }
  return `
    <div class="reveal-anim">
      <div class="prompt-label">${stepPrefix(card, 'reveal')}${card.dir === 'listen' ? '核对拼写' : '核对答案'}</div>
      ${verdict}
      <div class="reveal-box">
        <div class="word-display small">${wordDisplayHTML(w)}</div>
        <div class="word-tools"><button class="speak-btn" type="button" data-action="speak-word" aria-label="播放单词发音"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 6.2h2.2L8.5 3.4v9.2L5.2 9.8H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10.6 5.6a3 3 0 0 1 0 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>发音</span></button><button class="block-word-btn" type="button" data-action="block-word" aria-label="不再出现这个词" title="不再出现这个词">别出现</button></div>
        ${wordMetaHTML(w)}
        <div class="meaning-list">
          ${w.meanings.map((m, i) => `<div class="meaning-item"><span class="idx">${i + 1}</span><span>${esc(m)}</span></div>`).join('')}
        </div>
        ${examplesHTML(w)}
        ${affixRowsHTML(w)}
      </div>
      <div class="action-row">
        <button class="btn primary" type="button" data-action="next-stage">${card.dir === 'listen' ? '看结果 →' : (!card.steps.includes('recall') ? '看结果 →' : card.dir === 'en2zh' ? '开始拼写验证 →' : '再回忆一次 →')}</button>
        <span class="spacer"></span>
        <span class="hint-line kbd-hint">Enter 继续</span>
      </div>
    </div>`;
}

function recallHTML(card) {
  const w = card.word;
  return `
    <div class="reveal-anim">
      <div class="prompt-label">${stepPrefix(card, 'recall')}${card.dir === 'zh2en' ? '回忆验证' : '拼写验证'}</div>
      <p class="recall-hint">${card.dir === 'zh2en'
        ? '再写一次这个英文单词，确认不是刚刚照着抄。'
        : '不看上面的答案，把英文单词完整拼出来。'}</p>
      <div class="meaning-list">
        <div class="meaning-item"><span class="idx">释义</span><span>${esc(w.meanings.join('；'))}</span></div>
        <div class="meaning-item"><span class="idx">提示</span><span class="letter-hint">${esc(letterPattern(w.word))}</span></div>
      </div>
      <input class="answer-input" id="recallInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入英文单词" value="${esc(card.recallTyped || '')}" />
      <div class="action-row">
        <button class="btn primary" type="button" data-action="submit-recall">提交拼写</button>
        <button class="btn ghost" type="button" data-action="give-up">想不起来，看答案</button>
        <span class="spacer"></span>
        <span class="hint-line kbd-hint">Enter 提交</span>
      </div>
    </div>`;
}

/* 听音拼写：只播放发音，题干不出现原词拼写 */
function listenHTML(card) {
  const w = card.word;
  const rate = settings.listenRate === 0.8 ? 0.8 : 1;
  let fallback = '';
  if (card.listenFailed) {
    if (w.phonetic) {
      fallback = `<div class="listen-fallback">
        <span class="listen-fb-label">发音不可用 · 看音标拼写</span>
        <span class="phon">${esc(w.phonetic)}</span>
      </div>`;
    } else {
      fallback = `<div class="listen-fallback">
        <span class="listen-fb-label">发音不可用 · 字母提示</span>
        <span class="letter-hint">${esc(letterPattern(w.word))}</span>
        <span class="hint">${esc(w.word.length)} 个字母</span>
      </div>`;
    }
  }
  return `
    <div class="reveal-anim">
      <div class="prompt-label">第 1 步 · 听音拼写</div>
      <div class="listen-player">
        <button class="listen-play" type="button" data-action="play-audio" aria-label="播放单词发音">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"></path></svg>
          <span>${card.audioPlayed ? '再听一遍' : '播放发音'}</span>
        </button>
        <div class="seg small listen-rate" role="group" aria-label="播放语速">
          <button type="button" data-rate="0.8" class="${rate === 0.8 ? 'active' : ''}">0.8×</button>
          <button type="button" data-rate="1" class="${rate === 1 ? 'active' : ''}">1.0×</button>
        </div>
      </div>
      <p class="recall-hint">只听发音，把单词完整拼出来。这里不显示原词拼写。</p>
      ${fallback}
      <input class="answer-input" id="recallInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入你听到的单词" value="${esc(card.recallTyped || '')}" />
      <div class="action-row listen-actions">
        <button class="btn primary" type="button" data-action="submit-recall">提交拼写</button>
        <button class="btn ghost" type="button" data-action="give-up">想不起来，看答案</button>
        <span class="spacer"></span>
        <button class="btn tiny ghost" type="button" data-action="listen-to-recall">改看释义拼写</button>
      </div>
    </div>`;
}

function resultHTML(card) {
  const w = card.word;
  const rec = card.record;
  const ok = card.result;
  return `
    <div class="reveal-anim">
      ${ok
        ? card.recallGrade === 'close'
          ? verdictHTML('skip', '≈', `意思对了，拼写差一点：你写的是 <strong>${esc(card.recallTyped || '')}</strong>，正确拼写 <strong>${esc(w.word)}</strong>。这次算难，拼写错误单独计数。`)
          : card.recallGrade === 'synonym'
            ? verdictHTML('good', '✓', `同义也算对：<strong>${esc(card.recallTyped || '')}</strong> 同样表示这个释义。这题的标准答案是 <strong>${esc(w.word)}</strong>，记不错。`)
            : verdictHTML('good', '✓', `${card.dir === 'listen' ? '听写正确' : (card.steps.includes('recall') ? '拼写正确' : '答对了')}，本题记为 <strong>${card.rating === 2 ? '困难（答得太快，按困难记）' : card.rating === 4 ? '简单' : '不错'}</strong>。`)
        : verdictHTML('bad', '×', `这次没${card.dir === 'listen' ? '听对' : (card.steps.includes('recall') ? '拼对' : '答对')}。正确答案是 <strong>${esc(w.word)}</strong>，已自动加入错题本。`)}
      <div class="reveal-box">
        <div class="word-display small">${wordDisplayHTML(w)}</div>
        <div class="word-tools"><button class="speak-btn" type="button" data-action="speak-word" aria-label="播放单词发音"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 6.2h2.2L8.5 3.4v9.2L5.2 9.8H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M10.6 5.6a3 3 0 0 1 0 4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span>发音</span></button><button class="block-word-btn" type="button" data-action="block-word" aria-label="不再出现这个词" title="不再出现这个词">别出现</button></div>
        ${wordMetaHTML(w)}
        <div class="meaning-list">
          ${w.meanings.map((m, i) => `<div class="meaning-item"><span class="idx">${i + 1}</span><span>${esc(m)}</span></div>`).join('')}
        </div>
        ${examplesHTML(w)}
        ${affixRowsHTML(w)}
      </div>
      <p class="hint-line">下次复习：<b>${rec ? esc(dueText(rec.due)) : '—'}</b> · 稳定度 ${rec ? esc((rec.stability || 0).toFixed(1)) : '0'} 天 · 难度 ${rec ? esc((rec.difficulty || 0).toFixed(1)) : '—'}</p>
      <div class="action-row">
        <button class="btn primary" type="button" data-action="next-card">${session.index + 1 >= session.total ? '完成本轮' : '下一题'}</button>
        <span class="spacer"></span>
        <span class="hint-line kbd-hint">Enter 继续</span>
      </div>
    </div>`;
}

function sessionFilterTags() {
  if (!session) return '';
  if (session.source === 'filter') {
    const snap = session.filtersSnapshot || { prefixes: [], suffixes: [], roots: [], pos: '', letter: '', q: '' };
    const tags = [];
    snap.prefixes.forEach((t) => tags.push(`<span class="sf-tag pre">${esc(t)}<i aria-hidden="true">×</i></span>`));
    snap.suffixes.forEach((t) => tags.push(`<span class="sf-tag suf">${esc(t)}<i aria-hidden="true">×</i></span>`));
    (snap.roots || []).forEach((t) => tags.push(`<span class="sf-tag root">词根 ${esc(rootLabel(t).form)} · ${esc(rootLabel(t).zh)}<i aria-hidden="true">×</i></span>`));
    if (snap.pos) tags.push(`<span class="sf-tag plain">词性 ${esc(snap.pos)}</span>`);
    if (snap.letter) tags.push(`<span class="sf-tag plain">首字母 ${esc(snap.letter)}</span>`);
    if (snap.q) tags.push(`<span class="sf-tag plain">关键词「${esc(snap.q)}」</span>`);
    return tags.length ? tags.join('<span class="sf-sep">｜</span>') : '<span class="sf-plain">未加筛选条件</span>';
  }
  if (session.source === 'review') return '<span class="sf-plain">今日复习计划</span>';
  if (session.source === 'library') return '<span class="sf-plain">全库随机</span>';
  if (session.source === 'drill') {
    const r = rootData && rootData.roots ? rootData.roots[session.drillRoot] : null;
    if (!r) return '<span class="sf-plain">词根专项</span>';
    return `<span class="sf-tag root">词根 ${esc(r.form)} · ${esc(r.zh)}</span><span class="sf-sep">｜</span><span class="sf-plain">同族词成组</span>`;
  }
  if (session.source === 'wrong') return '<span class="sf-plain">错题重练</span>';
  return '<span class="sf-plain">单题重练</span>';
}

function renderSession() {
  clearPlayingState();
  const onPractice = document.body.dataset.currentView === 'practice';
  const active = !!session && !sessionEditing && onPractice;
  document.body.classList.toggle('is-session', !!session && onPractice);
  $('pickerSheet').hidden = active;
  $('sessionSheet').hidden = !active;
  $('cancelEditBtn').hidden = !(session && sessionEditing);

  if (!session) {
    $('sessionBody').innerHTML = '';
    const note = $('sessionDrillNote');
    if (note) note.hidden = true;
    return;
  }
  $('sessionFilterTags').innerHTML = sessionFilterTags();
  $('sessionFilterCount').textContent = `${session.total} 词`;
  $('sessionFilterDir').textContent = directionLabel(session.direction);
  const drillNote = $('sessionDrillNote');
  if (drillNote) drillNote.hidden = session.source !== 'drill';

  if (sessionEditing) return;
  if (session.finished) { renderFinish(); return; }

  const card = currentCard();
  if (!card) { renderFinish(); return; }
  demoteListenSteps(card);
  if (cardStage(card) === 'guess' && !card.guessShownAt) card.guessShownAt = Date.now();
  const body = $('sessionBody');
  const progress = session.total ? ((session.index + (card.result != null ? 1 : 0)) / session.total) * 100 : 0;
  $('progressBar').style.width = `${Math.min(100, progress)}%`;
  $('progressMeta').textContent = `${session.index + 1} / ${session.total}`;
  $('sessionStats').textContent = `正确 ${session.correct} · 连对 ${session.streakNow}`;

  const stage = cardStage(card);
  const stageSeqKey = `${session.startedAt}:${session.index}:${stage}`;
  if (stageSeqKey !== lastAudioKey) {
    lastAudioKey = stageSeqKey;
    stopSpeaking();
  }
  let html = '';
  if (stage === 'breakdown') html = breakdownHTML(card);
  else if (stage === 'clue') html = clueHTML(card);
  else if (stage === 'guess') html = guessHTML(card);
  else if (stage === 'reveal') html = revealHTML(card);
  else if (stage === 'recall') html = recallHTML(card);
  else if (stage === 'listen') html = listenHTML(card);
  else html = resultHTML(card);
  body.innerHTML = stageBarHTML(card)
    + (card.audioGated && card.step === 0 ? '<p class="hint-line audio-gate-note">这个词没有离线发音，本次用文字练习。</p>' : '')
    + html;
  // 提前把这一个词的音频取到内存，点击发音时无需等网络
  prefetchAudio(card.word.word);

  if (stage === 'guess' || stage === 'recall' || stage === 'listen') {
    const input = $(stage === 'guess' ? 'guessInput' : 'recallInput');
    if (input) {
      input.addEventListener('input', () => {
        if (!session || session.queue[session.index] !== card) return;
        if (stage === 'guess') card.guessTyped = input.value;
        else card.recallTyped = input.value;
      });
      setTimeout(() => input.focus({ preventScroll: true }), 60);
    }
  }
  if (stage === 'listen') applyListenEntry(card);
}

/* ---------- 听音拼写：进入、播放、降级 ----------
   只用离线音频：索引里查不到就降级为文字练习，绝不调用语音合成。 */
function applyListenEntry(card) {
  if (!FEATURES.listenDictation) return;
  if (card.listenEntryDone) return;
  card.listenEntryDone = true;
  const s = session;
  const key = audioKey(card.word.word);
  if (!key || !hasOfflineAudio(card.word)) { handleListenFailure(card, 'no-file'); return; }
  if (AUDIO.urls.has(key)) return;
  // 进入卡片先预取当前词所在分片，最多等 5 秒；失败只降级，不阻塞答题
  loadAudioWithTimeout(key, 5000).then((url) => {
    if (!url && session === s && currentCard() === card && cardStage(card) === 'listen' && !card.audioPlayed) {
      handleListenFailure(card, 'timeout');
    }
  });
}

function switchListenToRecall(card, note) {
  // 手动或超时转文字拼写前先保住已输入内容，重绘后回填并恢复焦点
  const typed = document.getElementById('recallInput');
  if (typed) card.recallTyped = typed.value;
  const i = card.steps.indexOf('listen');
  if (i >= 0) card.steps[i] = 'recall';
  card.listenFailed = true;
  card.listenFallback = 'recall';
  renderSession();
  restoreRecallFocus();
  if (note) toast(note);
}

/* 听音卡只用离线音频，失败时按原因给出明确文案并降级为看词拼写 */
function handleListenFailure(card, reason) {
  if (card.listenFailed && card.listenFallback) return;
  // 整块重绘前先把已敲的字存进卡片，重绘后回填并恢复焦点
  const typed = document.getElementById('recallInput');
  if (typed) card.recallTyped = typed.value;
  const note = reason === 'timeout'
    ? '这个词的音频取不到或超时，已改为看词拼写'
    : reason === 'blocked'
      ? '发音被浏览器拦截，已改为看音标拼写'
      : '这个词的音频不可用，已改为看词拼写';
  if (card.word.phonetic) {
    card.listenFailed = true;
    card.listenFallback = 'phonetic';
    renderSession();
    restoreRecallFocus();
    toast(note);
  } else {
    switchListenToRecall(card);
    toast(note);
  }
}

/* 降级重绘后把焦点还给拼写输入框，光标移到末尾 */
function restoreRecallFocus() {
  const inp = document.getElementById('recallInput');
  if (!inp) return;
  try { inp.focus(); const n = inp.value.length; inp.setSelectionRange(n, n); } catch (e) { /* ignore */ }
}

async function playListenAudio(card) {
  if (!session || currentCard() !== card || cardStage(card) !== 'listen') return;
  const s = session;
  card.audioPlayed = true;
  unlockAudio();
  const key = audioKey(card.word.word);
  const res = await playAudioFile(card.word.word, settings.listenRate); // 只听离线音频，不退到 TTS
  if (session !== s || currentCard() !== card || cardStage(card) !== 'listen') return; // 播放期间已切题/换队列
  if (res.ok) {
    if (card.listenFailed) {
      card.listenFailed = false;
      card.listenFallback = '';
      renderSession();
    } else {
      const label = document.querySelector('[data-action="play-audio"] span');
      if (label) label.textContent = '再听一遍';
    }
    return;
  }
  if (res.reason === 'decode') markAudioBroken(key);
  handleListenFailure(card, res.reason);
}

function renderFinish() {
  const s = session;
  const rate = s.answered ? percent(s.correct, s.answered) : 0;
  const mins = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
  $('progressBar').style.width = '100%';
  $('progressMeta').textContent = `${s.total} / ${s.total}`;
  $('sessionStats').textContent = `正确 ${s.correct} · 连对 ${s.streakNow}`;
  $('sessionBody').innerHTML = `
    <div class="reveal-anim session-summary">
      <div class="section-kicker">本轮完成</div>
      <h3 class="summary-rate">正确率 ${rate}%</h3>
      <p class="hint-line">${s.answered} 题 · ${s.correct} 题正确 · 用时约 ${mins} 分钟 · 最长连对 ${s.bestStreak}</p>
      <div class="meaning-list summary-next">
        <div class="meaning-item"><span class="idx">到期</span><span>${todaySnapshot().due} 个词</span></div>
        <div class="meaning-item"><span class="idx">错题</span><span>${wrongBook.filter((x) => !isHiddenWord(x.word)).length} 个词在错题本</span></div>
      </div>
      <div class="action-row summary-actions">
        <button class="btn primary" type="button" data-action="restart">再来一轮</button>
        <button class="btn" type="button" data-action="go-wrong">去错题本</button>
        <button class="btn ghost" type="button" data-action="close-session">返回</button>
      </div>
    </div>`;
}

/* ---------- 训练动作与评分 ---------- */
/* 干扰项安全池：敏感词、用户屏蔽、近义、拼写只差 1~2 字母的候选一律不选。
   近义判定用释义的归一化字符串与二字片段做交集，双向检查（中译英/英译中都适用）。 */
function meaningSignature(w) {
  if (w._mSig) return w._mSig;
  const sig = new Set();
  const full = [];
  (w.meanings || []).forEach((m) => {
    const n = normalizeChinese(m);
    if (!n) return;
    full.push(n);
    sig.add(n);
    for (let i = 0; i + 2 <= n.length; i++) sig.add(n.slice(i, i + 2));
  });
  w._mSig = sig;
  w._mFull = full;
  return sig;
}

function meaningsOverlap(a, b) {
  if (!a || !b) return false;
  const sa = meaningSignature(a);
  const sb = meaningSignature(b);
  for (const s of sa) if (sb.has(s)) return true;
  // 单字/短释义（如「血」与「血统」）二字片段不重合，再补一次包含判断
  return (a._mFull || []).some((x) => (b._mFull || []).some((y) => x.includes(y) || y.includes(x)));
}

function spellingTooClose(a, b) {
  const x = normalizeEnglish(a);
  const y = normalizeEnglish(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.abs(x.length - y.length) > 2) return false;
  // 词长短于 3 时编辑距离 2 几乎等于任意替换，按 1 处理
  const limit = Math.min(2, x.length <= 3 || y.length <= 3 ? 1 : 2);
  return levenshtein(x, y) <= limit;
}

function distractorScore(cand, correct) {
  let s = 0;
  const posA = correct.pos || [];
  const sharedPos = (cand.pos || []).filter((p) => posA.includes(p)).length;
  if (sharedPos) s += 30 + (sharedPos - 1) * 8;
  if (correct.prefixes[0] && cand.prefixes[0] && correct.prefixes[0] === cand.prefixes[0]) s += 12;
  if (correct.suffixes[0] && cand.suffixes[0] && correct.suffixes[0] === cand.suffixes[0]) s += 12;
  if (correct.freqRank && cand.freqRank) {
    const d = Math.abs(correct.freqRank - cand.freqRank);
    s += d < 500 ? 18 : d < 2000 ? 11 : d < 5000 ? 5 : 0;
  }
  s += Math.max(0, 10 - Math.abs(correct.word.length - cand.word.length));
  return s + Math.random() * 2; // 同分候选轻微打散，避免长期固定几个词
}

function insertBest(best, item, max) {
  best.push(item);
  best.sort((a, b) => b.score - a.score);
  if (best.length > max) best.pop();
}

function buildChoices(card) {
  const dir = card.dir;
  const correct = card.word;
  const correctText = dir === 'en2zh' ? correct.meanings.join('；') : correct.word;
  const seen = new Set([dir === 'en2zh' ? normalizeChinese(correctText) : normalizeEnglish(correctText)]);
  const options = [{ text: correctText, ok: true }];
  const best = [];
  for (const w of library()) {
    if (w.lower === correct.lower) continue;
    if (!isDistractorSafe(w)) continue;
    const text = dir === 'en2zh' ? (w.meanings[0] || '') : w.word;
    if (!text) continue;
    const norm = dir === 'en2zh' ? normalizeChinese(text) : normalizeEnglish(text);
    if (!norm || seen.has(norm)) continue;
    if (best.some((b) => b.norm === norm)) continue;
    const score = distractorScore(w, correct);
    // 便宜的分数剪枝：进不了前三就不做近义/拼写的高开销判定
    if (best.length === 3 && score <= best[2].score) continue;
    // 中文释义方向也要排除近义：begin 的题里不能出现「开始」这种选项
    if (meaningsOverlap(w, correct)) continue;
    if (spellingTooClose(w.word, correct.word)) continue;
    insertBest(best, { text, norm, score }, 3);
  }
  best.forEach((b) => options.push({ text: b.text, ok: false }));
  // 选项池不足 4 个时，别把答案混进少数选项：直接转输入题
  if (options.length < 4) {
    card.choices = [];
    card.method = 'input';
    return;
  }
  card.choices = shuffle(options);
}

/* 渲染前确保选项池已就绪：buildChoices 可能把这一卡从选择改成输入 */
function ensureChoices(card) {
  if (card.method !== 'choice') return;
  if (!card.choices.length) buildChoices(card);
}

/* 反义守卫：「不快乐的」包含「快乐的」不是同义而是反义。
   否定字的作用域不止管后一个字（「不/快乐/的」），所以向前看 3 个字内有没有否定字。
   「非常/别人/未来/非同」等词里的「非/别/未」不是否定算子，需按二字词例外跳过。 */
const ZH_NEG_CHARS = '不无没非未别莫勿';
const ZH_NEG_LEXICAL = new Set([
  '非常', '非凡', '非洲', '非同', '非但',
  '未来',
  '别人', '别的', '别处', '别样', '别墅', '别致', '别名', '特别'
]);
function negatedNear(s, i) {
  for (let j = Math.max(0, i - 3); j < i; j++) {
    if (!ZH_NEG_CHARS.includes(s[j])) continue;
    // 否定字是「非常」等非否定二字词的首字 → 不算否定
    if (j + 1 < s.length && ZH_NEG_LEXICAL.has(s.slice(j, j + 2))) continue;
    // 「特别」等：否定字形落在二字词第二字
    if (j > 0 && ZH_NEG_LEXICAL.has(s.slice(j - 1, j + 1))) continue;
    return true;
  }
  return false;
}
function hasPlainHit(container, sub) {
  let i = container.indexOf(sub);
  while (i !== -1) {
    if (!negatedNear(container, i)) return true;
    i = container.indexOf(sub, i + 1);
  }
  return false;
}

function looseChineseMatch(input, meanings) {
  const g = normalizeChinese(input);
  if (!g) return false;
  return meanings.some((m) => {
    const t = normalizeChinese(m);
    if (!t) return false;
    if (hasPlainHit(g, t) || hasPlainHit(t, g)) return true;
    const maxLen = Math.min(6, t.length);
    for (let len = maxLen; len >= 2; len--) {
      for (let i = 0; i + len <= t.length; i++) {
        if (!negatedNear(t, i) && hasPlainHit(g, t.slice(i, i + len))) return true;
      }
    }
    return false;
  });
}

/* ---------- 英文拼写评分：把「词义会了」和「拼写差一点」拆成两根轴 ----------
   exact 完全正确；close 编辑距离内的拼写失误 → 记 Hard、单独计拼写错误，不进错题本；
   synonym 词库里同样表示该释义的其他词 → 记对；只有 wrong 才算不会。 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function lookupWordAll(lower) {
  return BUILTIN.find((w) => w.lower === lower)
    || remoteWords.find((w) => w.lower === lower)
    || userWords.find((w) => w.lower === lower)
    || null;
}

/* 英文反义守卫：unhappy/happy、careless/careful 是否定构词对，不算同义。
   中文释义碎片（如「心的」）区分不了反义，必须在词形层拦截。 */
const NEG_PREFIXES = ['un', 'dis', 'in', 'im', 'ir', 'il', 'non'];
function negPrefixOf(w, otherLower) {
  if (otherLower.length < 3) return false;
  const annotated = (w.prefixes || []).map((p) => p.replace(/-+$/, ''));
  const pres = annotated.length ? annotated.filter((p) => NEG_PREFIXES.includes(p)) : NEG_PREFIXES;
  return pres.some((p) => w.lower === p + otherLower);
}
function isNegatedPair(a, b) {
  if (negPrefixOf(a, b.lower) || negPrefixOf(b, a.lower)) return true;
  const lessStem = (w) => w.lower.length > 5 && w.lower.endsWith('less') ? w.lower.slice(0, -4) : '';
  const sa = lessStem(a);
  const sb = lessStem(b);
  if (sa && b.lower.startsWith(sa) && b.lower.length > sa.length) return true;
  if (sb && a.lower.startsWith(sb) && a.lower.length > sb.length) return true;
  return false;
}

function gradeEnglish(word, input) {
  const target = normalizeEnglish(word.word);
  const got = normalizeEnglish(input);
  if (!got) return { level: 'wrong' };
  if (got === target) return { level: 'exact' };
  // 短词（<5 字母）编辑距离 1 就是另一个词，不做容错；长词放宽到 2
  const tol = target.length >= 9 ? 2 : target.length >= 5 ? 1 : 0;
  const alt = lookupWordAll(got);
  // 反义构词对连「拼写差一点」都不算：unimportant 不是 important 的 typo。
  // 输入的词可能不在词库里（alt 为空），词形判断不依赖词条释义，照查。
  if (isNegatedPair(word, alt || { lower: got, prefixes: [], suffixes: [] })) return { level: 'wrong' };
  if (tol > 0 && levenshtein(got, target) <= tol) return { level: 'close' };
  if (alt && alt.meanings.some((m) => looseChineseMatch(m, word.meanings))) {
    return { level: 'synonym', match: alt.word };
  }
  return { level: 'wrong' };
}

function startSession(source, countOverride, opts) {
  const o = opts || {};
  const count = countOverride || (source === 'review' || source === 'filter' || source === 'drill' ? 'all' : settings.count);
  const words = buildQueue(source, count, settings.shuffle, o.drillRoot);
  if (!words.length) {
    toast(source === 'review' ? '今天没有到期词，也没有可学的新词了' : source === 'wrong' ? '错题本还是空的' : source === 'drill' ? '这个词根暂时没有可用词，换一个词根或去全库' : '当前筛选没有匹配的词');
    return;
  }
  const replacing = !!session;
  stopSpeaking();
  lastAudioKey = '';
  const wantListen = settings.direction === 'listen' && settings.includeSpell !== false;
  const listenable = wantListen && words.some(hasOfflineAudio);
  if (settings.direction === 'listen' && settings.includeSpell === false) toast('已关闭拼写：听音拼写改为英译中');
  else if (wantListen && !listenable) toast('当前队列没有可播放的离线发音，已改为英译中');
  session = {
    source,
    drillRoot: o.drillRoot || '',
    countMode: count,
    direction: listenable ? 'listen' : (settings.direction === 'listen' ? 'en2zh' : settings.direction),
    filtersSnapshot: snapshotFilters(),
    queue: words.map(makeCard),
    index: 0,
    total: words.length,
    correct: 0,
    answered: 0,
    streakNow: 0,
    bestStreak: 0,
    startedAt: Date.now(),
    finished: false
  };
  sessionEditing = false;
  track('practice_start', { source, total: words.length, direction: settings.direction, method: settings.answerType, replaced: replacing });
  renderSession();
  showView('practice');
  if (replacing) toast(`已换成新的队列：${words.length} 词`);
}

/* 练词页主按钮：严格按面板当前展示的那一批词开局 */
function startFromPicker() {
  const plan = pickerPlan();
  if (!plan.count) {
    toast(filtersActive() ? '当前条件没有命中词，换个条件或清空筛选' : '词库还没有可练的词');
    return;
  }
  if (plan.kind === 'filter') startSession('filter', 'all');
  else if (plan.kind === 'review') startSession('review', 'all');
  else startSession('library', settings.count);
}

/* 从练习页顶部筛选条回到面板，改完点击开始按钮即替换队列 */
function openPickerForSession() {
  if (!session) { showView('practice'); return; }
  stopSpeaking();
  sessionEditing = true;
  renderPractice();
  renderSession();
  showView('practice');
  // 点「修改」总是打开筛选弹窗：没有条件时也让用户能看到分类去加
  if ($('filterModal')) {
    filterModalSnapshot = snapshotFilters();
    $('filterModal').hidden = false;
  }
  setTimeout(() => {
    const sheet = $('pickerSheet');
    if (sheet) sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

function cancelPickerEdit() {
  if (session) restoreFilters(session.filtersSnapshot);
  sessionEditing = false;
  renderAll();
}

function advanceStage() {
  const card = currentCard();
  if (!card) return;
  const stage = cardStage(card);
  // 听音卡在提交时已写入 FSRS，但仍要先核对答案，再进结果页
  if (card.result != null && stage !== 'reveal') return;
  // 关闭拼写后 steps 无 recall/listen：核对页之后按猜义结果直接收尾，避免空结果页不写 FSRS
  if (stage === 'reveal' && card.result == null
      && !card.steps.includes('recall') && !card.steps.includes('listen')) {
    finishCard(card, card.guessOk === true, { grade: card.guessGrade || '' });
    return;
  }
  card.step = Math.min(card.steps.length, card.step + 1);
  card.stageShownAt = Date.now();
  if (cardStage(card) === 'guess' && !card.guessShownAt) card.guessShownAt = Date.now();
  renderSession();
}

function selectChoice(index) {
  const card = currentCard();
  if (!card || !['guess'].includes(cardStage(card))) return;
  if (!card.choices.length) buildChoices(card);
  card.selected = index;
  renderSession();
}

function submitGuess() {
  const card = currentCard();
  if (!card || cardStage(card) !== 'guess') return;
  let value;
  if (card.method === 'choice') {
    if (card.selected < 0) { toast('先选一个选项'); return; }
    value = card.choices[card.selected].text;
    card.guessMs = Date.now() - (card.guessShownAt || Date.now());
  } else {
    const input = $('guessInput');
    value = (input ? input.value.trim() : '') || String(card.guessTyped || '').trim();
    if (!value) { toast('写点你的猜测，或者直接跳过'); return; }
    card.guessMs = Date.now() - (card.guessShownAt || Date.now());
  }
  card.guess = value;
  if (card.dir === 'en2zh') {
    card.guessOk = card.method === 'choice' ? !!card.choices[card.selected].ok : looseChineseMatch(value, card.word.meanings);
  } else {
    const g = gradeEnglish(card.word, value);
    card.guessOk = g.level !== 'wrong';
    card.guessGrade = g.level;
    card.guessSynonym = g.match || '';
  }
  track('practice_step', { word: card.word.word, stage: 'guess', correct: card.guessOk, ms: card.guessMs });
  hapticFeedback(!!card.guessOk);
  advanceStage();
}

function skipGuess() {
  const card = currentCard();
  if (!card || cardStage(card) !== 'guess') return;
  card.guess = '';
  card.guessOk = null;
  card.guessMs = 0;
  card.step = Math.min(card.steps.length, card.step + 1);
  renderSession();
}

function submitRecall() {
  const card = currentCard();
  const stage = card ? cardStage(card) : '';
  if (!card || (stage !== 'recall' && stage !== 'listen')) return;
  const input = $('recallInput');
  const value = (input ? input.value.trim() : '') || String(card.recallTyped || '').trim();
  if (!value) { toast('先拼一下，或点“想不起来”'); return; }
  const g = gradeEnglish(card.word, value);
  card.recallOk = g.level !== 'wrong';
  card.recallGrade = g.level;
  card.recallSynonym = g.match || '';
  card.recallTyped = value;
  stopSpeaking();
  finishCard(card, g.level !== 'wrong', { stayReveal: stage === 'listen', grade: g.level });
}

function giveUp() {
  const card = currentCard();
  const stage = card ? cardStage(card) : '';
  if (!card || (stage !== 'recall' && stage !== 'listen')) return;
  stopSpeaking();
  card.recallOk = false;
  finishCard(card, false, { stayReveal: stage === 'listen' });
}

function addWrong(word) {
  const key = word.lower;
  const existing = wrongBook.find((x) => x.word.toLowerCase() === key);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastAt = Date.now();
  } else {
    wrongBook.unshift({
      word: word.word,
      meanings: word.meanings,
      pos: word.pos,
      prefixes: word.prefixes,
      suffixes: word.suffixes,
      count: 1,
      createdAt: Date.now(),
      lastAt: Date.now()
    });
  }
  saveWrong();
  todayRec().wrongAdded = (todayRec().wrongAdded || 0) + 1;
  todayRec().wrongTotal = wrongBook.length;
  track('answer_wrong', { word: word.word });
}

function removeWrong(lower) {
  const before = wrongBook.length;
  wrongBook = wrongBook.filter((x) => x.word.toLowerCase() !== lower);
  if (wrongBook.length !== before) {
    saveWrong();
    todayRec().wrongTotal = wrongBook.length;
    saveKV('daily', daily);
  }
}

/* 练习反馈震动。Android Chromium 在用户手势后可用；iOS Safari/PWA 无 Vibration API，静默跳过。 */
function hapticFeedback(ok) {
  if (!settings.haptic) return;
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(ok ? 12 : [30, 40, 30]);
  } catch (e) { /* 不支持或被拒：静默 */ }
}

function finishCard(card, correct, opts) {
  const o = opts || {};
  hapticFeedback(!!correct);
  const now = Date.now();
  const key = card.word.lower;
  const existing = srsMap[key];
  let rating;
  if (!correct) {
    rating = 1;
  } else {
    // 选择阶段秒选（< 800ms）即使答对也只记 Hard，避免排除法蒙对；
    // 拼写差一点（close）同样记 Hard——词义这条轴算会，但不给满格
    const fast = card.method === 'choice' && card.guessMs > 0 && card.guessMs < 800;
    rating = fast || o.grade === 'close' ? 2 : 3;
  }
  const base = existing || FSRS.empty(key);
  const rec = FSRS.schedule(base, rating, now);
  const isDrill = session && session.source === 'drill';
  // 专项首次学习的词不占每日新词额度，也不计入今日复习
  if (isDrill && !existing) rec.fromDrill = true;
  if (rec.history && rec.history.length) {
    rec.history[rec.history.length - 1].ms = card.guessMs || 0;
    rec.history[rec.history.length - 1].correct = correct;
  }
  srsMap[key] = rec;
  saveSrs(rec);

  const d = todayRec();
  if (isDrill) d.drills = (d.drills || 0) + 1;
  else d.reviews = (d.reviews || 0) + 1;
  d.answers = (d.answers || 0) + 1;
  if (correct) d.correct = (d.correct || 0) + 1;
  if (!existing && !isDrill) d.newWords = (d.newWords || 0) + 1;
  stats.answered = (stats.answered || 0) + 1;
  if (correct) stats.correct = (stats.correct || 0) + 1;
  // 拼写差一点单独立账（猜义或回忆任一阶段差一点都算），不混进词义轴
  if (o.grade === 'close' || card.guessGrade === 'close') {
    d.spellErrors = (d.spellErrors || 0) + 1;
    stats.spellErrors = (stats.spellErrors || 0) + 1;
  }
  saveStats();
  saveKV('daily', daily);

  if (correct) removeWrong(key); else addWrong(card.word);
  d.wrongTotal = wrongBook.length;

  session.answered += 1;
  if (correct) {
    session.correct += 1;
    session.streakNow += 1;
    session.bestStreak = Math.max(session.bestStreak, session.streakNow);
  } else {
    session.streakNow = 0;
  }

  card.rating = rating;
  card.record = rec;
  card.result = correct;
  card.recallOk = correct;
  card.step = card.steps.length;
  track('review_complete', {
    word: card.word.word,
    correct,
    grade: o.grade || '',
    rating,
    ms: card.guessMs || 0,
    interval: rec.interval,
    state: rec.state
  });
  // 听音拼写：先停在核对页展示正确拼写，用户点“看结果”再进结果页
  if (o.stayReveal) {
    const i = card.steps.indexOf('reveal');
    if (i >= 0) card.step = i;
  }
  renderSession();
  renderHeaderStats();
}

function nextCard() {
  if (!session) return;
  stopSpeaking();
  session.index += 1;
  if (session.index >= session.queue.length) {
    session.finished = true;
    track('session_complete', {
      source: session.source,
      total: session.total,
      correct: session.correct,
      answered: session.answered,
      ms: Date.now() - session.startedAt
    });
    renderFinish();
    renderPractice();
    renderStats();
    return;
  }
  renderSession();
  renderPractice();
}

/* 词卡上的「别出现」：写入本地黑名单，并把当前词从正在进行的队列里立即剔除 */
function blockCurrentWord() {
  const card = currentCard();
  if (!session || !card) return;
  const lower = card.word.lower;
  if (!addBlockedWord(lower, 'practice')) {
    toast('这个词已经在屏蔽列表里');
    return;
  }
  const idx = session.index;
  let removedBefore = 0;
  const kept = [];
  session.queue.forEach((c, i) => {
    if (c && c.word && c.word.lower === lower) {
      if (i < idx) removedBefore += 1;
      return;
    }
    kept.push(c);
  });
  session.queue = kept;
  session.total = kept.length;
  session.index = Math.max(0, idx - removedBefore);
  sessionEditing = false;
  card.blocked = true;
  if (!kept.length || session.index >= kept.length) session.finished = true;
  renderSession();
  renderPractice();
  // 错题本同步移除，避免屏蔽后还能从错题本重练
  const beforeWrong = wrongBook.length;
  wrongBook = wrongBook.filter((x) => String(x.word || '').toLowerCase() !== lower);
  if (wrongBook.length !== beforeWrong) { saveWrong(); renderWrong(); }
  toast(`已屏蔽「${card.word.word}」，之后的练习不再出现`);
}

function undoBlockedFromSettings() {
  const k = undoBlockedWord();
  if (!k) {
    toast('没有可撤销的屏蔽词');
    return;
  }
  invalidateLib();
  renderLibrary();
  renderPractice();
  toast(`已恢复「${k}」`);
}

function restartSession() {
  if (!session) return;
  const src = session.source;
  const count = session.countMode;
  const drillRoot = session.drillRoot;
  stopSpeaking();
  session = null;
  startSession(src, count, { drillRoot });
}

function closeSession() {
  if (session && !session.finished) {
    track('practice_abandon', { at: session.index + 1, total: session.total, answered: session.answered });
  }
  stopSpeaking();
  session = null;
  sessionEditing = false;
  lastAudioKey = '';
  renderAll();
  showView('practice');
  toast('已结束本轮');
}

function renderHeaderStats() {
  renderPractice();
  renderStats();
  renderWrong();
  renderLibrary();
}

/* ---------- 视图切换 ---------- */
const VIEWS = ['practice', 'library', 'data'];

function showView(name, opts = {}) {
  if (!VIEWS.includes(name)) name = 'practice';
  clearPlayingState();
  document.body.dataset.currentView = name;
  document.body.classList.toggle('is-session', !!session && name === 'practice');
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('.nav-item, .tab-item').forEach((btn) => {
    const on = btn.dataset.view === name;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (opts.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'practice') renderSession();
}

/* ---------- 提示 / 导入 / 词条管理 ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

const CSV_TEMPLATE = '\uFEFFword,meaning,pos,prefixes,suffixes,phonetic,freqRank,examTags\r\n' +
  'unhappy,"不快乐的；不幸的",adj,un-,,\u002fʌnˈhæpi\u002f,1800,\r\n' +
  'rewrite,"重写；改写",v,re-,,,3200,CET6\r\n' +
  'comfortable,"舒适的；舒服的",adj,,-able,,4500,\r\n';

const JSON_EXAMPLE = JSON.stringify([
  { word: 'biweekly', meaning: '两周一次的；双周刊', pos: 'adj', prefixes: ['bi-'], suffixes: ['-ly'], phonetic: '/baɪˈwiːkli/', freqRank: 9000 },
  { word: 'hyperlink', meanings: ['超链接'], pos: ['n'], prefixes: ['hyper-'], suffixes: [] },
  { word: 'postgraduate', meaning: '研究生；毕业后的', pos: 'n,adj', prefixes: ['post-'], suffixes: [], examTags: ['CET6'] }
], null, 2);

const SAMPLE_WORDS = [
  { word: 'biweekly', meaning: '两周一次的；双周刊', pos: 'adj,adv', prefixes: 'bi-', suffixes: '-ly', phonetic: '/baɪˈwiːkli/', freqRank: 9000, examTags: 'GRE' },
  { word: 'coauthor', meaning: '合著者；共同作者', pos: 'n', prefixes: 'co-', suffixes: '', phonetic: '/koʊˈɔːθər/' },
  { word: 'decentralize', meaning: '使分散；去中心化', pos: 'v', prefixes: 'de-', suffixes: '-ize', examTags: 'TOEFL' },
  { word: 'hyperlink', meaning: '超链接', pos: 'n', prefixes: 'hyper-', suffixes: '' },
  { word: 'monolingual', meaning: '单语的；只用一种语言的', pos: 'adj', prefixes: 'mono-', suffixes: '-al' },
  { word: 'postgraduate', meaning: '研究生；毕业后的', pos: 'n,adj', prefixes: 'post-', suffixes: '-ate', examTags: 'CET6' },
  { word: 'autopilot', meaning: '自动驾驶仪；自动导航', pos: 'n', prefixes: 'auto-', suffixes: '' },
  { word: 'transcontinental', meaning: '横贯大陆的', pos: 'adj', prefixes: 'trans-', suffixes: '-al', examTags: 'GRE' }
];

/* CSV 解析：支持 BOM、引号、转义双引号、CRLF */
function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const src = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = []; field = '';
      line++;
      rowLine = line;
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push({ cells: row, line: rowLine });
  }
  return rows.filter((r) => r.cells.some((c) => String(c).trim() !== ''));
}

const HEADER_ALIASES = {
  word: ['word', 'term', 'vocabulary', '单词', '英文', '词汇'],
  meaning: ['meaning', 'meanings', 'translation', 'zh', 'cn', '中文', '释义', '翻译'],
  pos: ['pos', 'partofspeech', '词性', '词类'],
  prefixes: ['prefix', 'prefixes', '前缀'],
  suffixes: ['suffix', 'suffixes', '后缀'],
  phonetic: ['phonetic', 'ipa', '音标'],
  freqRank: ['freqrank', 'frequency', 'rank', 'bnc', '词频'],
  examTags: ['examtags', 'exam', 'tags', '考试标签'],
  lemma: ['lemma', '词元'],
  exchange: ['exchange', '词形变化', '变形']
};

function parseCSVWords(text) {
  const errors = [];
  const rows = parseCSVRows(text);
  if (!rows.length) return { words: [], errors: ['文件是空的：第一行需要是表头（word,meaning,...）'] };
  const header = rows[0].cells.map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
  const map = {};
  header.forEach((h, i) => {
    Object.keys(HEADER_ALIASES).forEach((key) => {
      if (HEADER_ALIASES[key].includes(h) && map[key] == null) map[key] = i;
    });
  });
  if (map.word == null) errors.push('第 1 行：表头里找不到 word（单词）列，请参考 CSV 模板');
  if (map.meaning == null) errors.push('第 1 行：表头里找不到 meaning（中文释义）列，请参考 CSV 模板');
  if (map.word == null || map.meaning == null) return { words: [], errors };

  const words = [];
  rows.slice(1).forEach((row) => {
    const get = (k) => (map[k] != null ? String(row.cells[map[k]] || '').trim() : '');
    const word = get('word');
    if (!word) {
      errors.push(`第 ${row.line} 行第 ${map.word + 1} 列：单词为空`);
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z' -]*$/.test(word)) {
      errors.push(`第 ${row.line} 行第 ${map.word + 1} 列：单词「${word}」只能包含英文字母、空格、连字符或撇号`);
      return;
    }
    const meaning = get('meaning');
    if (!meaning) {
      errors.push(`第 ${row.line} 行第 ${map.meaning + 1} 列：中文释义为空`);
      return;
    }
    words.push(makeWord({
      word,
      meaning,
      pos: get('pos'),
      prefixes: get('prefixes'),
      suffixes: get('suffixes'),
      phonetic: get('phonetic'),
      freqRank: get('freqRank'),
      examTags: get('examTags'),
      lemma: get('lemma'),
      exchange: get('exchange'),
      origin: 'user',
      source: 'import'
    }, 'user'));
  });
  return { words, errors };
}

function parseJSONWords(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (err) {
    const m = /position\s+(\d+)/i.exec(err.message || '');
    let line = 1;
    let col = 1;
    if (m) {
      const pos = Math.min(Number(m[1]), text.length);
      const before = text.slice(0, pos);
      line = before.split('\n').length;
      col = pos - before.lastIndexOf('\n');
    }
    return { words: [], errors: [`JSON 语法错误（第 ${line} 行第 ${col} 列附近）：${err.message}`] };
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.words)) list = data.words;
  else if (data && typeof data === 'object') list = [data];
  else list = [];
  if (!list.length) return { words: [], errors: ['JSON 里没有找到词条：请使用数组，或 {"words": [...]} 结构'] };

  const errors = [];
  const words = [];
  list.forEach((item, idx) => {
    const raw = typeof item === 'string' ? { word: item } : item;
    if (!raw || typeof raw !== 'object') {
      errors.push(`第 ${idx + 1} 条（第 1 列）：应该是对象或单词字符串`);
      return;
    }
    const w = makeWord(raw, 'user');
    if (!w || !w.word) {
      errors.push(`第 ${idx + 1} 条（第 1 列）：缺少 word 字段`);
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z' -]*$/.test(w.word)) {
      errors.push(`第 ${idx + 1} 条（第 1 列）：单词「${w.word}」包含不支持的字符`);
      return;
    }
    if (!w.meanings.length) {
      errors.push(`第 ${idx + 1} 条（第 2 列）：缺少中文释义（meaning 或 meanings），音标、词频可以留空`);
      return;
    }
    words.push(w);
  });
  return { words, errors };
}

function showImportErrors(errors) {
  const box = $('importErrors');
  if (!errors.length) { box.innerHTML = ''; return; }
  const shown = errors.slice(0, 8).map((e) => `<div class="import-error">${esc(e)}</div>`).join('');
  const more = errors.length > 8 ? `<div class="import-error">还有 ${errors.length - 8} 处问题，修正后重新上传即可。</div>` : '';
  const retry = `<div class="empty-actions"><button class="btn tiny" type="button" data-retry-import>重新选择文件</button></div>`;
  box.innerHTML = shown + more + retry;
}

function showImportOk(html) { $('importResult').innerHTML = `<div class="import-ok">${html}</div>`; }
function clearImportMessages() { $('importErrors').innerHTML = ''; $('importResult').innerHTML = ''; }

/* 导入后的音频命中率：拿词去比对 audio/index.json 的真实收录情况，不按假设覆盖率估算 */
async function audioCoverageLine(words) {
  const keys = new Set();
  (words || []).forEach((w) => {
    const k = audioKey(typeof w === 'string' ? w : (w && w.word));
    if (k && !isHiddenWord(k)) keys.add(k);
  });
  if (!keys.size) return '';
  const idx = await loadAudioIndex();
  if (!idx || !idx.words) return '音频命中率暂时无法统计（音频索引没加载到）。';
  let hit = 0;
  keys.forEach((k) => { if (idx.words[k]) hit++; });
  return `其中 ${hit} 个词有标准音频，其余 ${keys.size - hit} 个词这次用文字练习（不发声）。`;
}

async function mergeImported(list, format) {
  let added = 0;
  let replaced = 0;
  let invalid = 0;
  let hidden = 0;
  const seen = new Set();
  const toPersist = [];
  list.forEach((raw) => {
    const w = makeWord(Object.assign({}, raw, { origin: 'user', source: format }), 'user');
    if (!w || !w.meanings.length) { invalid++; return; }
    if (isHiddenWord(w)) { hidden++; return; }
    if (seen.has(w.lower)) { invalid++; return; }
    seen.add(w.lower);
    const idx = userWords.findIndex((x) => x.lower === w.lower);
    w.createdAt = idx >= 0 ? userWords[idx].createdAt : Date.now();
    w.updatedAt = Date.now();
    if (idx >= 0) { userWords[idx] = w; replaced++; } else { userWords.push(w); added++; }
    toPersist.push(w);
  });
  // 入库必须等真的写进去：单条失败不拦其他条，但整批失败要报出来
  let failed = 0;
  for (const w of toPersist) {
    try { await DB.put('userWords', w); } catch (e) { failed++; }
  }
  if (failed) toastSaveFail();
  invalidateLib();
  libLimit = Math.max(libLimit, CONFIG.pageSize);
  renderAll();
  return { added, replaced, invalid, hidden };
}

async function handleFile(file) {
  clearImportMessages();
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['csv', 'json', 'txt', 'tsv'].includes(ext)) {
    showImportErrors([`文件类型 .${ext} 不支持：请上传 .csv、.tsv、.txt 或 .json 文件`]);
    track('import_fail', { format: ext, reason: 'unsupported' });
    return;
  }
  try {
    const text = await file.text();
    if (ext === 'txt' || ext === 'tsv') {
      const r = parseTXTWords(text);
      if (r.errors.length) showImportErrors(r.errors);
      if (r.listWords.length) {
        pasteList = { words: r.listWords.slice(), createdAt: Date.now() };
        saveKV('pasteList', pasteList);
      }
      if (r.words.length) {
        const merged = await mergeImported(r.words, 'txt');
        const cover = await audioCoverageLine(r.words);
        showImportOk(`成功导入 ${merged.added + merged.replaced} 条（新增 ${merged.added}，覆盖 ${merged.replaced}）`
          + (merged.hidden ? `，跳过 ${merged.hidden} 条已屏蔽/已剔除的词` : '') + '。'
          + (cover ? ` ${cover}` : '')
          + (r.listWords.length ? ` 另有 ${r.listWords.length} 个纯单词已存为「粘贴批次」，<button type="button" class="btn tiny" data-start-list>用这批词开始 →</button>` : ''));
        track('import_success', { format: 'txt', added: merged.added, replaced: merged.replaced });
        toast(`TXT 导入完成，共 ${merged.added + merged.replaced} 条`);
        return;
      }
      if (r.listWords.length) {
        const cover = await audioCoverageLine(r.listWords);
        showImportOk(`纯词表命中 ${r.listWords.length} 个内置词`
          + (r.listUnknown.length ? `，未收录 ${r.listUnknown.length} 个已跳过` : '')
          + `。${cover ? ` ${cover}` : ''}`
          + `<button type="button" class="btn tiny" data-start-list>用这批词开始 →</button>`);
        syncPasteEntry();
        toast(`识别到 ${r.listWords.length} 个词，可以开始练习`);
        return;
      }
      track('import_fail', { format: 'txt', errors: r.errors.length });
      if (!r.errors.length) showImportErrors(['没有解析到任何词条：每行「单词,释义」或直接粘贴纯单词列表']);
      return;
    }
    const result = ext === 'csv' ? parseCSVWords(text) : parseJSONWords(text);
    if (result.errors.length) showImportErrors(result.errors);
    if (!result.words.length) {
      track('import_fail', { format: ext, errors: result.errors.length });
      if (!result.errors.length) showImportErrors(['没有解析到任何词条']);
      return;
    }
    const merged = await mergeImported(result.words, ext);
    const cover = await audioCoverageLine(result.words);
    const parts = [`成功导入 ${merged.added + merged.replaced} 条（新增 ${merged.added}，覆盖 ${merged.replaced}）`];
    if (merged.invalid) parts.push(`跳过 ${merged.invalid} 条重复或无效`);
    if (merged.hidden) parts.push(`跳过 ${merged.hidden} 条已屏蔽/已剔除的词`);
    if (result.errors.length) parts.push(`另有 ${result.errors.length} 条有问题已标红`);
    showImportOk(parts.join('，') + '。' + (cover ? ` ${cover}` : ''));
    track('import_success', { format: ext, added: merged.added, replaced: merged.replaced, errors: result.errors.length });
    toast(`导入完成，共 ${merged.added + merged.replaced} 条`);
  } catch (e) {
    showImportErrors([`读取文件失败：${e.message}`]);
    track('import_fail', { format: ext, reason: 'exception' });
  }
}

/* ---------- 纯单词表：粘贴 / TXT（只读内置词库，不写 userWords） ---------- */
const PASTE_TOKEN_RE = /[A-Za-z][A-Za-z'-]*/g;

function restorePasteWord(lower) {
  const hit = findWord(lower);
  if (hit) return hit;
  const candidates = [];
  const add = (s) => { if (s && s.length >= 3) candidates.push(s); };
  if (/ies$/.test(lower)) add(lower.slice(0, -3) + 'y');
  if (/ied$/.test(lower)) add(lower.slice(0, -3) + 'y');
  if (/es$/.test(lower)) add(lower.slice(0, -2));
  if (/s$/.test(lower)) add(lower.slice(0, -1));
  if (/ed$/.test(lower)) {
    const b = lower.slice(0, -2);
    add(b); add(b + 'e');
    if (/(.)\1$/.test(b)) add(b.slice(0, -1));
  }
  if (/ing$/.test(lower)) {
    const b = lower.slice(0, -3);
    add(b); add(b + 'e');
    if (/(.)\1$/.test(b)) add(b.slice(0, -1));
  }
  for (const c of candidates) {
    const w = findWord(c);
    if (w) return w;
  }
  return null;
}

function resolvePasteList(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const matched = [];
  const unknown = [];
  const errors = [];
  const seen = new Set();
  const resolved = new Set();
  let duplicates = 0;
  let tokens = 0;
  lines.forEach((line, i) => {
    const found = line.match(PASTE_TOKEN_RE) || [];
    if (!found.length) {
      if (line.trim()) errors.push(`第 ${i + 1} 行：「${line.trim().slice(0, 24)}」不是英文单词，已跳过`);
      return;
    }
    found.forEach((rawToken) => {
      const t = rawToken.toLowerCase().replace(/^'+|'+$/g, '');
      if (t.length < 3) return;
      tokens += 1;
      if (seen.has(t)) { duplicates += 1; return; }
      seen.add(t);
      const w = restorePasteWord(t);
      if (w) {
        if (resolved.has(w.lower)) duplicates += 1;
        else { resolved.add(w.lower); matched.push(w.lower); }
      }
      else {
        unknown.push(t);
        errors.push(`第 ${i + 1} 行：「${rawToken}」内置词库未收录且没有释义，已跳过`);
      }
    });
  });
  return { matched, unknown, duplicates, errors, tokens };
}

function renderPastePreview() {
  const r = resolvePasteList($('pasteInput').value);
  const btn = $('pasteStart');
  const box = $('pastePreview');
  const hint = `识别 ${r.tokens} 个单词 · 内置可查 ${r.matched.length} · 未收录 ${r.unknown.length} · 重复已去重 ${r.duplicates}`;
  const errs = r.errors.slice(0, 3).map((e) => `<div class="import-error">${esc(e)}</div>`).join('');
  const more = r.errors.length > 3 ? `<div class="import-error">还有 ${r.errors.length - 3} 处问题…</div>` : '';
  box.innerHTML = `<div class="paste-stat">${esc(hint)}</div>${errs}${more}`;
  btn.disabled = !r.matched.length;
  btn.textContent = `开始练习（${r.matched.length} 词）`;
  return r;
}

let pasteTimer = null;
function onPasteInput() {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(() => { try { renderPastePreview(); } catch (_) {} }, 280);
}

function openImportModal() {
  const modal = $('importModal');
  if (!modal) return;
  modal.hidden = false;
}

function closeImportModal() {
  const modal = $('importModal');
  if (!modal) return;
  modal.hidden = true;
}

function openPasteModal() {
  $('pasteModal').hidden = false;
  if (!$('pasteInput').value && pasteList && pasteList.words.length) {
    $('pasteInput').value = pasteList.words.join('\n');
  }
  renderPastePreview();
  setTimeout(() => $('pasteInput').focus(), 60);
}

function closePasteModal() {
  $('pasteModal').hidden = true;
}

function startPasteSession() {
  const r = resolvePasteList($('pasteInput').value);
  if (!r.matched.length) { toast('先粘贴至少一个内置词库里有的单词'); return; }
  pasteList = { words: r.matched.slice(), createdAt: Date.now() };
  saveKV('pasteList', pasteList);
  closePasteModal();
  closeImportModal();
  syncPasteEntry();
  startSession('list', 'all');
}

function syncPasteEntry() {
  const resume = $('pasteResumeBtn');
  if (!resume) return;
  const n = pasteList && pasteList.words ? pasteList.words.length : 0;
  resume.hidden = !n;
  resume.textContent = `继续练上次粘贴的 ${n} 词`;

}

function parseTXTWords(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const errors = [];
  const words = [];
  const listWords = [];
  const listUnknown = [];
  const listSeen = new Set();
  lines.forEach((line, i) => {
    const src = line.trim();
    if (!src || src.startsWith('#')) return;
    if (i === 0 && /^(word|单词)\s*[,，\t]/i.test(src)) return;
    const pair = /^([A-Za-z][A-Za-z' -]*?)[\t,，]\s*(.+)$/.exec(src);
    if (pair) {
      const rawWord = pair[1].trim();
      const meaning = pair[2].trim();
      if (!/^[a-zA-Z][a-zA-Z' -]*$/.test(rawWord)) {
        errors.push(`第 ${i + 1} 行第 1 列：单词「${rawWord}」包含不支持的字符`);
        return;
      }
      if (!meaning) {
        errors.push(`第 ${i + 1} 行第 2 列：缺少中文释义`);
        return;
      }
      words.push(makeWord({ word: rawWord, meaning }, 'user'));
      return;
    }
    const toks = src.match(PASTE_TOKEN_RE) || [];
    if (toks.length === 1) {
      const w = restorePasteWord(toks[0].toLowerCase());
      if (w) {
        if (!listSeen.has(w.lower)) { listSeen.add(w.lower); listWords.push(w.lower); }
        else errors.push(`第 ${i + 1} 行：「${toks[0]}」与前文重复，已只保留一次`);
      }
      else listUnknown.push(toks[0].toLowerCase());
      return;
    }
    errors.push(`第 ${i + 1} 行：TXT 每行只支持「单词,释义」或一个纯单词（这一行识别到 ${toks.length} 个）`);
  });
  return { words, errors, listWords, listUnknown };
}

async function loadSampleLibrary() {
  clearImportMessages();
  const merged = await mergeImported(SAMPLE_WORDS, 'sample');
  const cover = await audioCoverageLine(SAMPLE_WORDS);
  showImportOk(`已载入示例词表 ${merged.added + merged.replaced} 条，可以直接去练习或筛选。${cover ? ` ${cover}` : ''}`);
  track('import_success', { format: 'sample', added: merged.added, replaced: merged.replaced });
  toast('示例词表已载入');
}

/* ---------- 词条编辑 ---------- */
let editingWord = null;
let modalReturnFocus = null;

function openWordModal(wordText) {
  modalReturnFocus = document.activeElement;
  editingWord = wordText || null;
  const w = wordText ? userWords.find((x) => x.lower === wordText.toLowerCase()) : null;
  $('modalTitle').textContent = w ? '编辑词条' : '新增词条';
  $('fWord').value = w ? w.word : '';
  $('fPos').value = w ? w.pos.join(',') : '';
  $('fMeanings').value = w ? w.meanings.join('；') : '';
  $('fPrefixes').value = w ? w.prefixes.join(',') : '';
  $('fSuffixes').value = w ? w.suffixes.join(',') : '';
  $('wordModal').hidden = false;
  setTimeout(() => $('fWord').focus(), 80);
}

function closeWordModal() {
  $('wordModal').hidden = true;
  editingWord = null;
  if (modalReturnFocus && modalReturnFocus.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

async function handleWordForm(event) {
  event.preventDefault();
  const word = $('fWord').value.trim();
  const meanings = splitMeanings($('fMeanings').value);
  if (!word || !/^[a-zA-Z][a-zA-Z' -]*$/.test(word)) { toast('单词只能用英文字母、空格、连字符或撇号'); return; }
  if (!meanings.length) { toast('请填写中文释义'); return; }
  // 编辑时以原词条为底，只覆盖表单展示的字段；重命名不在此处理（避免静默产生重复词条）
  const original = editingWord ? userWords.find((x) => x.lower === editingWord.toLowerCase()) : null;
  if (original && original.lower !== word.toLowerCase()) { toast('暂不支持修改拼写：如需换词请删除后重新添加'); return; }
  const existing = userWords.find((x) => x.lower === word.toLowerCase());
  const obj = makeWord(Object.assign({}, original || {}, {
    word,
    meanings,
    pos: $('fPos').value,
    prefixes: $('fPrefixes').value,
    suffixes: $('fSuffixes').value,
    origin: 'user',
    source: 'manual',
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  }), 'user');
  const idx = userWords.findIndex((x) => x.lower === obj.lower);
  if (idx >= 0) userWords[idx] = obj; else userWords.push(obj);
  // 等真写进库再报成功：写失败只提示失败，不给“已保存”的假信号
  let stored = true;
  try { await DB.put('userWords', obj); } catch (e) { stored = false; toastSaveFail(); }
  invalidateLib();
  renderAll();
  closeWordModal();
  if (stored) toast(idx >= 0 ? '已更新词条' : '已新增词条');
}

async function deleteUserWord(word) {
  if (!window.confirm(`确定删除「${word}」吗？`)) return;
  const lower = word.toLowerCase();
  await DB.del('userWords', lower);
  userWords = userWords.filter((x) => x.lower !== lower);
  invalidateLib();
  renderAll();
  toast('已删除');
}

async function clearUserWords() {
  if (!userWords.length) { toast('我的词库已经是空的'); return; }
  if (!window.confirm(`确定清空 ${userWords.length} 条自建词条吗？内置词库不受影响。`)) return;
  await DB.clear('userWords');
  userWords = [];
  invalidateLib();
  renderAll();
  toast('我的词库已清空');
}

/* ---------- 设置与筛选 UI ---------- */
function buildFilterOptions() {
  const words = library();
  const posSet = new Set();
  words.forEach((w) => w.pos.forEach((p) => posSet.add(p)));
  const posHTML = '<option value="">全部词性</option>' + Array.from(posSet).sort()
    .map((p) => `<option value="${esc(p)}">${esc(p)}${POS_LABELS[p] ? ' · ' + POS_LABELS[p] : ''}</option>`).join('');
  const letters = Array.from(new Set(words.map((w) => w.word[0].toLowerCase()))).sort();
  const letterHTML = '<option value="">全部字母</option>' + letters
    .map((l) => `<option value="${esc(l)}">${esc(l.toUpperCase())}</option>`).join('');
  [$('posSelect'), $('pickPosSelect')].forEach((sel) => { if (sel) sel.innerHTML = posHTML; });
  [$('letterSelect'), $('pickLetterSelect')].forEach((sel) => { if (sel) sel.innerHTML = letterHTML; });
  syncQuickFilterUI();
}

function syncQuickFilterUI() {
  [['searchInput', 'q'], ['pickSearchInput', 'q'], ['posSelect', 'pos'], ['pickPosSelect', 'pos'],
    ['letterSelect', 'letter'], ['pickLetterSelect', 'letter'], ['affixSearch', 'affixQ']].forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    const value = filters[key] || '';
    if (el.value !== value) el.value = value;
  });
}

function syncSettingsUI() {
  document.querySelectorAll('#libModeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === settings.libMode));
  document.querySelectorAll('#directionSeg button').forEach((b) => b.classList.toggle('active', b.dataset.dir === settings.direction));
  document.querySelectorAll('#answerSeg button').forEach((b) => b.classList.toggle('active', b.dataset.answer === settings.answerType));
  document.querySelectorAll('#scopeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.scope === pickerScope));
  const listen = settings.direction === 'listen';
  document.querySelectorAll('#answerSeg button').forEach((b) => { b.disabled = listen; });
  $('answerSeg').classList.toggle('is-disabled', listen);
  $('countSelect').value = settings.count;
  $('dailyNewInput').value = settings.dailyNew;
  $('shuffleToggle').checked = !!settings.shuffle;
  if ($('hapticToggle')) $('hapticToggle').checked = settings.haptic !== false;
  if ($('includeSpellToggle')) $('includeSpellToggle').checked = settings.includeSpell !== false;
  if ($('showExamplesToggle')) $('showExamplesToggle').checked = !!settings.showExamples;
  if ($('pickerCount')) renderPickerState();
}

function renderAll() {
  invalidateLib();
  renderHeader();
  renderPractice();
  renderLibrary();
  renderWrong();
  renderStats();
  renderSession();
  buildFilterOptions();
  syncPasteEntry();
}

function clearAllFilters() {
  filters = { q: '', pos: '', letter: '', prefixes: new Set(), suffixes: new Set(), roots: new Set(), affixQ: '' };
  libLimit = CONFIG.pageSize;
  syncQuickFilterUI();
  renderAll();
}

function clearAllTags() {
  filters.prefixes.clear();
  filters.suffixes.clear();
  filters.roots.clear();
  libLimit = CONFIG.pageSize;
  renderChips();
  renderPickerState();
  renderLibrary();
}

function toggleAffix(token, type) {
  const set = type === 'prefix' ? filters.prefixes : type === 'suffix' ? filters.suffixes : filters.roots;
  if (set.has(token)) set.delete(token); else set.add(token);
  libLimit = CONFIG.pageSize;
  renderChips();
  renderPickerState();
  renderLibrary();
}

/* 开局时冻结一份筛选条件：练习页筛选条、取消修改都以此为准 */
function snapshotFilters() {
  return {
    prefixes: Array.from(filters.prefixes),
    suffixes: Array.from(filters.suffixes),
    roots: Array.from(filters.roots),
    pos: filters.pos,
    letter: filters.letter,
    q: filters.q
  };
}

function restoreFilters(snap) {
  if (!snap) return;
  filters.prefixes = new Set(snap.prefixes);
  filters.suffixes = new Set(snap.suffixes);
  filters.roots = new Set(snap.roots || []);
  filters.pos = snap.pos;
  filters.letter = snap.letter;
  filters.q = snap.q;
  filters.affixQ = '';
  libLimit = CONFIG.pageSize;
  syncQuickFilterUI();
}

function pruneFilters() {
  const words = library();
  const preSet = new Set();
  const sufSet = new Set();
  const rootSet = new Set();
  words.forEach((w) => {
    w.prefixes.forEach((t) => preSet.add(t));
    w.suffixes.forEach((t) => sufSet.add(t));
    const rid = wordRootId(w);
    if (rid) rootSet.add(rid);
  });
  Array.from(filters.prefixes).forEach((t) => { if (!preSet.has(t)) filters.prefixes.delete(t); });
  Array.from(filters.suffixes).forEach((t) => { if (!sufSet.has(t)) filters.suffixes.delete(t); });
  Array.from(filters.roots).forEach((t) => { if (!rootSet.has(t)) filters.roots.delete(t); });
}

function setLibMode(mode) {
  settings.libMode = mode;
  saveSettings();
  pruneFilters();
  libLimit = CONFIG.pageSize;
  invalidateLib();
  syncSettingsUI();
  renderAll();
}

/* ---------- 词根内容（远端热更新；失败静默回退内置副本） ---------- */
let rootsInfo = { source: 'builtin', version: '' };

async function loadRootContent(expectedVersion) {
  const builtin = (typeof ROOT_DATA !== 'undefined') ? ROOT_DATA : null;
  if (!rootData) rootData = builtin;
  if (!rootData) return false;
  rootsInfo = { source: rootData === builtin ? 'builtin' : 'remote', version: rootData.version || '' };
  if (!/^http/i.test(location.protocol)) return false;
  if (expectedVersion && rootData.version && expectedVersion === rootData.version) return false;
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
    const res = await fetch(`./content/roots.json?_=${Date.now()}`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || !data.roots || !data.words) return false;
    rootData = data;
    rootsInfo = { source: 'remote', version: data.version || '' };
    return true;
  } catch (e) {
    return false; /* 静默回退内置副本 */
  }
}

/* ---------- 扩展词包：加载 / 移除 / 列表（Play B） ---------- */
function rebuildExtWords() {
  extWords = [];
  Object.keys(extStore).forEach((id) => {
    const pack = extStore[id];
    const list = pack && Array.isArray(pack.words) ? pack.words : [];
    list.forEach((raw) => {
      const w = makeWord(raw, 'extension');
      if (w && w.meanings.length) { w.extId = id; extWords.push(w); }
    });
  });
  saveKV('extPacks', extStore);
  invalidateLib();
}

function extPackMeta(id) {
  const p = extManifest && Array.isArray(extManifest.packs)
    ? extManifest.packs.find((x) => x.id === id) : null;
  return p || null;
}

function renderExtPackList() {
  const box = $('extPackList');
  if (!box) return;
  box.innerHTML = EXT_PACKS.map((p) => {
    const st = extStore[p.id];
    const meta = extPackMeta(p.id);
    const count = st && Array.isArray(st.words) ? st.words.length : (meta ? meta.count : null);
    const metaText = st
      ? `已加载 ${count} 词`
      : (count != null ? `${count.toLocaleString('en')} 词` : '未加载');
    const flag = p.official ? '' : '<span class="ep-flag">非官方大纲</span>';
    const action = extBusy.has(p.id)
      ? '<button class="btn tiny ghost" type="button" disabled>处理中…</button>'
      : st
        ? `<button class="btn tiny ghost" type="button" data-ext-action="remove" data-ext-id="${p.id}">移除</button>`
        : `<button class="btn tiny" type="button" data-ext-action="load" data-ext-id="${p.id}">加载</button>`;
    return `<div class="ext-pack-row"><span class="ep-name">${esc(p.name)}${flag}</span>` +
      `<span class="ep-meta">${metaText}</span>${action}</div>`;
  }).join('');
}

async function fetchExtManifest() {
  try {
    const res = await fetch(EXT_BASE + 'manifest.json', { cache: 'no-cache' });
    if (res.ok) extManifest = await res.json();
  } catch (e) { /* 离线或缺失时只显示已加载层 */ }
  renderExtPackList();
}

async function loadExtPack(id) {
  const pack = EXT_PACKS.find((x) => x.id === id);
  if (!pack || extBusy.has(id)) return;
  extBusy.add(id);
  renderExtPackList();
  try {
    const res = await fetch(EXT_BASE + id + '.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const words = Array.isArray(data.words) ? data.words : [];
    if (!words.length) throw new Error('词包为空');
    extStore[id] = { v: String(data.v || ''), fetchedAt: new Date().toISOString(), words };
    rebuildExtWords();
    invalidateLib();
    renderAll();
    track('ext_pack_load', { id, count: words.length });
    toast(`已加载「${pack.name}」${words.length} 词`);
  } catch (e) {
    toast(`「${pack.name}」加载失败，请检查网络后重试`);
  }
  extBusy.delete(id);
  renderExtPackList();
}

function removeExtPack(id) {
  const pack = EXT_PACKS.find((x) => x.id === id);
  if (!pack || !extStore[id]) return;
  delete extStore[id];
  rebuildExtWords();
  invalidateLib();
  renderAll();
  track('ext_pack_remove', { id });
  toast(`已移除「${pack.name}」`);
  renderExtPackList();
}

/* ---------- 远端内容热更新 ---------- */
async function refreshRemoteContent() {
  if (!/^http/i.test(location.protocol)) return;
  try {
    const res = await fetch(`${CONFIG.contentUrl}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const man = await res.json();
    if (!man) return;
    const rootsChanged = man.roots && man.roots.version ? await loadRootContent(man.roots.version) : false;
    const contentUnchanged = !man.version || !Array.isArray(man.sources)
      || (contentInfo.source === 'remote' && contentInfo.version === man.version);
    if (contentUnchanged) {
      if (rootsChanged) { invalidateLib(); renderAll(); }
      return;
    }
    const base = new URL(CONFIG.contentUrl, location.href);
    const collected = [];
    for (const src of man.sources) {
      if (!src || !src.url) continue;
      try {
        const r = await fetch(new URL(src.url, base).href, { cache: 'no-store' });
        if (!r.ok) continue;
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.words || []);
        list.forEach((raw) => {
          const w = makeWord(raw, 'remote');
          if (w && w.meanings.length) { w.source = 'remote'; w.origin = 'remote'; collected.push(w); }
        });
      } catch (e) { /* 单个源失败不影响其他源 */ }
    }
    if (!collected.length) return;
    const prevSource = contentInfo.source;
    const prevVersion = contentInfo.version;
    remoteWords = collected;
    contentInfo = { version: man.version, source: 'remote', updatedAt: new Date().toISOString(), count: collected.length };
    await DB.put('kv', { key: 'content', value: { version: man.version, fetchedAt: contentInfo.updatedAt, words: collected } });
    invalidateLib();
    renderAll();
    track('content_update', { version: man.version, count: collected.length });
    // 首访只是把内置库落成在线副本（source=builtin），不算“有新版本”，静默写入不提示
    if (prevSource === 'remote' && prevVersion !== man.version) toast(`词库已更新至内容版本 ${man.version}`);
  } catch (e) { /* 静默回退本地内容 */ }
}

/* ---------- PWA ---------- */
let deferredPrompt = null;

/* 新版本提示：不自动刷新，避免打断正在做的练习 */
function showUpdateBar() {
  if ($('updateBar')) return;
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  bar.className = 'update-bar';
  bar.innerHTML = '有新版本，<button type="button">点此刷新</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
}

function setupPWA() {
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // 已由 SW 控制时，进入页面检查一次更新
      if (navigator.serviceWorker.controller) reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    }).catch(() => { /* 离线缓存失败不影响使用 */ });
    $('offlineNote').textContent = '离线可用';
  } else if (location.protocol === 'file:') {
    $('offlineNote').textContent = '本地文件模式：可正常使用，离线安装需通过 http 访问';
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) { /* ignore */ }
    deferredPrompt = null;
    $('installBtn').hidden = true;
  });
  window.addEventListener('online', renderHeader);
  window.addEventListener('offline', renderHeader);
}

/* ---------- 首次使用引导 / 存储降级 / 数据与隐私 ---------- */
const ONBOARD_KEY = 'wd-onboarding-v1';
function onboardingSeen() {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch (e) { return true; }
}
/* 老用户判定：已有复习记录 / 练习事件 / 自建词，升级后不再弹引导 */
function hasPracticeHistory() {
  return Object.keys(srsMap).length > 0 || (Array.isArray(events) && events.length > 0) || userWords.length > 0;
}
function maybeShowOnboarding() {
  if (onboardingSeen()) return;
  if (hasPracticeHistory()) {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* 隐私模式下忽略 */ }
    return;
  }
  const el = $('onboardingModal');
  if (el) el.hidden = false;
}
function dismissOnboarding() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) { /* 隐私模式下忽略 */ }
  const el = $('onboardingModal');
  if (el) el.hidden = true;
}

function showStorageNotice() {
  const el = $('storageNotice');
  if (!el) return;
  if (DB.mode.current === 'idb') { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = '本地数据库不可用，已临时改用浏览器存储；清理站点数据会丢失进度，建议到「进度」页导出备份。';
}

async function refreshPrivacyInfo() {
  const el = $('privacyStorage');
  if (!el) return;
  const maxEl = $('privacyMaxEvents');
  if (maxEl) maxEl.textContent = String(CONFIG.maxEvents);
  let cacheText = '离线缓存未启用';
  try {
    if ('caches' in window) {
      const keys = (await caches.keys()).filter((k) => k.startsWith('wtp-shell-'));
      cacheText = keys.length ? `离线缓存 ${keys.sort().pop()}` : '离线缓存未启用';
    }
  } catch (e) { /* ignore */ }
  el.textContent = `${cacheText} · 应用版本 V${CONFIG.version}`;
}

function openPrivacy() {
  const el = $('privacyModal');
  if (!el) return;
  el.hidden = false;
  refreshPrivacyInfo();
}

let clearArmTimer = null;
function armClearData() {
  const btn = $('clearDataBtn');
  if (!btn) return;
  if (btn.dataset.armed === '1') {
    clearTimeout(clearArmTimer);
    clearAllLocalData();
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('is-danger');
  btn.textContent = '再点一次确认清除';
  clearArmTimer = setTimeout(() => {
    btn.dataset.armed = '';
    btn.classList.remove('is-danger');
    btn.textContent = '清除本机全部数据';
  }, 5000);
}

async function clearAllLocalData() {
  const btn = $('clearDataBtn');
  if (btn) { btn.disabled = true; btn.textContent = '正在清除…'; }
  try {
    clearTimeout(kvTimer);
    Object.keys(pendingKV).forEach((k) => delete pendingKV[k]);
    for (const store of ['kv', 'userWords', 'srs', 'events']) {
      try { await DB.clear(store); } catch (e) { /* 单个 store 失败不阻断其它清理 */ }
    }
    // localStorage：进度缓存、主题、引导标记、坏音频名单
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('wtp.') || k.startsWith('wd-'))) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    AUDIO_BROKEN.clear();
    stopAudioFile(); // 先停播：revoke 正在播的 URL 会触发 onerror，被误记成 decode 失败
    AUDIO.urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
    AUDIO.urls.clear();
    AUDIO.loading.clear();
    AUDIO.els.clear();
    AUDIO.index = null;
    // 只删音频包缓存，保留应用外壳（内置词库在 words.js 里，不受影响）
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(AUDIO_CACHE_PREFIX)).map((k) => caches.delete(k)));
    }
    location.reload();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('is-danger'); btn.dataset.armed = ''; btn.textContent = '清除本机全部数据'; }
    toast('清除失败：' + (e && e.message ? e.message : e));
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 播放态兜底：离开页面、切后台、失焦、指针取消时都清掉绿色，
  // 避免回调丢失或触摸序列被系统打断后按钮永久处于播放态。
  window.addEventListener('blur', clearPlayingState);
  // 关页/切后台时立即落盘 pendingKV：220ms 防抖窗口内的错题、统计、设置不能丢
  window.addEventListener('pagehide', () => { clearPlayingState(); flushKV(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearPlayingState(); stopSpeaking(); flushKV(); }
  });
  document.addEventListener('pointercancel', clearPlayingState, true);

  $('clearAudioCacheBtn').addEventListener('click', clearAudioCache);
  $('unblockBtn').addEventListener('click', undoBlockedFromSettings);
  $('exportMarksBtn').addEventListener('click', exportMarks);
  $('blockedList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unblock]');
    if (btn) restoreBlockedWord(btn.dataset.unblock);
  });

  $('privacyOpenBtn').addEventListener('click', openPrivacy);
  $('privacyDone').addEventListener('click', () => { $('privacyModal').hidden = true; });
  $('closePrivacyModal').addEventListener('click', () => { $('privacyModal').hidden = true; });
  $('privacyModal').addEventListener('click', (e) => { if (e.target === $('privacyModal')) $('privacyModal').hidden = true; });
  $('clearDataBtn').addEventListener('click', armClearData);
  $('onboardSkip').addEventListener('click', dismissOnboarding);
  $('onboardStart').addEventListener('click', () => {
    dismissOnboarding();
    startFromPicker();
  });

  $('startPickerBtn').addEventListener('click', startFromPicker);
  $('cancelEditBtn').addEventListener('click', cancelPickerEdit);
  $('sessionFilterBar').addEventListener('click', openPickerForSession);
  $('scopeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scope]');
    if (!b) return;
    pickerScope = b.dataset.scope;
    syncSettingsUI();
    renderPickerState();
  });

  document.querySelectorAll('.nav-item, .tab-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (session && !session.finished && !sessionEditing) { toast('先结束本轮练习，再切换页面'); return; }
      if (sessionEditing) cancelPickerEdit();
      showView(btn.dataset.view);
    });
  });
  $('quitBtn').addEventListener('click', closeSession);

  $('directionSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    if (b.dataset.dir === 'listen' && settings.includeSpell === false) {
      toast('请先开启「练习含拼写」');
      return;
    }
    if (b.dataset.dir === 'listen' && !planHasOfflineAudio()) {
      toast('当前队列没有可播放的离线发音，听音拼写不可用');
      return;
    }
    settings.direction = b.dataset.dir;
    saveSettings();
    syncSettingsUI();
    renderSession();
    toast({
      en2zh: '已切换为英译中：看词，选/写中文',
      zh2en: '已切换为中译英：看释义，写英文',
      listen: '已切换为听音拼写：只播发音，不显示原词'
    }[settings.direction] || '已切换方向');
  });
  $('answerSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-answer]');
    if (!b) return;
    settings.answerType = b.dataset.answer;
    saveSettings();
    syncSettingsUI();
  });
  $('libModeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    setLibMode(b.dataset.mode);
  });

  $('countSelect').addEventListener('change', (e) => {
    settings.count = e.target.value;
    saveSettings();
    renderPickerState();
  });
  $('dailyNewInput').addEventListener('change', (e) => {
    let n = Number(e.target.value);
    if (!Number.isFinite(n)) n = 10;
    n = Math.max(0, Math.min(DAILY_NEW_MAX, Math.round(n)));
    settings.dailyNew = n;
    e.target.value = n;
    saveSettings();
    renderPractice();
    syncSettingsUI();
  });
  $('shuffleToggle').addEventListener('change', (e) => { settings.shuffle = e.target.checked; saveSettings(); });
  if ($('hapticToggle')) {
    $('hapticToggle').addEventListener('change', (e) => {
      settings.haptic = !!e.target.checked;
      saveSettings();
    });
  }
  if ($('includeSpellToggle')) {
    $('includeSpellToggle').addEventListener('change', (e) => {
      settings.includeSpell = !!e.target.checked;
      if (!settings.includeSpell && settings.direction === 'listen') {
        settings.direction = 'en2zh';
        toast('已关闭拼写：听音拼写回落为英译中');
      }
      saveSettings();
      syncSettingsUI();
      syncListenAvailability();
    });
  }
  if ($('showExamplesToggle')) {
    $('showExamplesToggle').addEventListener('change', (e) => {
      settings.showExamples = !!e.target.checked;
      saveSettings();
      const refresh = () => { if (session) renderSession(); renderLibrary(); };
      if (settings.showExamples && !EXAMPLE_BANK.loaded) loadExamplesContent().then(refresh);
      else refresh();
    });
  }

  /* 词性 / 首字母 / 关键词：练词页与词库页共用同一份筛选状态 */
  let searchTimer = null;
  const bindQuickFilter = (id, key, debounce) => {
    const el = $(id);
    if (!el) return;
    const apply = () => {
      filters[key] = el.value;
      libLimit = CONFIG.pageSize;
      syncQuickFilterUI();
      renderChips();
      renderPickerState();
      renderLibrary();
    };
    if (debounce) {
      el.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(apply, 120);
      });
    } else {
      el.addEventListener('change', apply);
    }
  };
  ['searchInput', 'pickSearchInput'].forEach((id) => bindQuickFilter(id, 'q', true));
  ['posSelect', 'pickPosSelect'].forEach((id) => bindQuickFilter(id, 'pos', false));
  ['letterSelect', 'pickLetterSelect'].forEach((id) => bindQuickFilter(id, 'letter', false));

  let affixSearchTimer = null;
  $('affixSearch').addEventListener('input', (e) => {
    clearTimeout(affixSearchTimer);
    const value = e.target.value;
    affixSearchTimer = setTimeout(() => {
      filters.affixQ = value;
      renderChips();
    }, 120);
  });

  const bindChipBox = (el) => {
    if (!el) return;
    el.addEventListener('click', (e) => {
      const clear = e.target.closest('[data-clear-affix]');
      if (clear) {
        clearAllTags();
        return;
      }
      const more = e.target.closest('[data-expand]');
      if (more) {
        affixExpanded[more.dataset.expand] = !affixExpanded[more.dataset.expand];
        renderChips();
        return;
      }
      const chip = e.target.closest('[data-affix]');
      if (chip) toggleAffix(chip.dataset.affix, chip.dataset.type);
    });
  };
  document.querySelectorAll('.chip-row, .affix-selected').forEach(bindChipBox);

  $('pickClearFilters').addEventListener('click', clearAllFilters);
  $('clearFilters').addEventListener('click', clearAllFilters);
  $('libStartBtn').addEventListener('click', () => {
    if (filtersActive() && filteredWords().length) startSession('filter', 'all');
    else {
      showView('practice');
      toast(filtersActive() ? '当前筛选没有命中词' : '在练词页按分类选词，或切到全库开始');
    }
  });
  $('pickerEmpty').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-picker-action]');
    if (!btn) return;
    const action = btn.dataset.pickerAction;
    if (action === 'clear-affix') {
      clearAllTags();
    } else if (action === 'clear-all') {
      clearAllFilters();
    } else if (action === 'library') {
      showView('library');
    } else if (action === 'sample') {
      await loadSampleLibrary();
    }
  });
  $('rootDrill').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-root]');
    if (chip) { startDrill(chip.dataset.root); return; }
    const act = e.target.closest('[data-root-action]');
    if (!act) return;
    if (act.dataset.rootAction === 'library') {
      showView('library');
      openImportModal();
    } else if (act.dataset.rootAction === 'all') {
      startSession('library', settings.count);
    }
  });
  $('loadMoreBtn').addEventListener('click', () => { libLimit += CONFIG.pageSize; renderLibrary(); });

  $('libraryGrid').addEventListener('click', (e) => {
    const emptyAct = e.target.closest('[data-empty-action]');
    if (emptyAct) {
      const action = emptyAct.dataset.emptyAction;
      if (action === 'clear') clearAllFilters();
      else if (action === 'practice') showView('practice');
      else if (action === 'import') { showView('library'); openImportModal(); }
      return;
    }
    const blockLib = e.target.closest('[data-block-lib]');
    if (blockLib) { markNotNeeded(blockLib.dataset.blockLib); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) { openWordModal(edit.dataset.edit); return; }
    const del = e.target.closest('[data-del]');
    if (del) deleteUserWord(del.dataset.del);
  });
  $('wrongList').addEventListener('click', (e) => {
    const retry = e.target.closest('[data-retry]');
    if (retry) { startSessionForWord(retry.dataset.retry); return; }
    const rm = e.target.closest('[data-remove-wrong]');
    if (rm) { removeWrong(rm.dataset.removeWrong.toLowerCase()); renderWrong(); renderStats(); toast('已移出错题本'); }
  });
  $('retryAllWrong').addEventListener('click', () => startSession('wrong', 'all'));
  $('clearWrong').addEventListener('click', () => {
    if (!wrongBook.length) { toast('错题本已经是空的'); return; }
    wrongBook = [];
    saveWrong();
    todayRec().wrongTotal = 0;
    saveKV('daily', daily);
    renderWrong();
    renderStats();
    toast('错题本已清空');
  });

  $('importBtn').addEventListener('click', () => {
    showView('library');
    openImportModal();
  });
  $('addWordBtn').addEventListener('click', () => openWordModal(''));
  $('closeModal').addEventListener('click', closeWordModal);
  $('cancelModal').addEventListener('click', closeWordModal);
  $('wordModal').addEventListener('click', (e) => { if (e.target === $('wordModal')) closeWordModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('wordModal').hidden) closeWordModal();
    if (e.key === 'Escape' && $('filterModal') && !$('filterModal').hidden) {
      $('filterModal').hidden = true;
      if (sessionEditing) {
        // 中途改条件时按 Esc 关弹窗=放弃这次改词，回到原队列
        cancelPickerEdit();
        renderChips();
      } else {
        restoreFilters(filterModalSnapshot);
        syncQuickFilterUI();
        renderChips();
        renderPickerState();
        renderLibrary();
      }
    }
    if (e.key === 'Escape' && $('settingsModal') && !$('settingsModal').hidden) $('settingsModal').hidden = true;
  });
  $('wordForm').addEventListener('submit', handleWordForm);

  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
    e.target.value = '';
  });
  if ($('filePickBtn')) $('filePickBtn').addEventListener('click', () => $('fileInput').click());
  $('importErrors').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-import]')) $('fileInput').click();
  });
  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('over')));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  $('csvTemplateBtn').addEventListener('click', () => downloadFile('单词词表模板.csv', CSV_TEMPLATE, 'text/csv;charset=utf-8'));
  $('jsonExampleBtn').addEventListener('click', () => downloadFile('单词词表示例.json', JSON_EXAMPLE, 'application/json'));
  $('loadSampleBtn').addEventListener('click', loadSampleLibrary);
  $('clearUserBtn').addEventListener('click', clearUserWords);

  if ($('pasteFromPanelBtn')) $('pasteFromPanelBtn').addEventListener('click', openPasteModal);

  if ($('importModal')) {
    const closeImp = () => closeImportModal();
    if ($('importModalDone')) $('importModalDone').addEventListener('click', closeImp);
    if ($('closeImportModal')) $('closeImportModal').addEventListener('click', closeImp);
    $('importModal').addEventListener('click', (e) => { if (e.target === $('importModal')) closeImp(); });
  }

  /* 分类筛选弹窗：打开时存快照，取消还原，应用保留 */
  if ($('filterOpenBtn')) {
    $('filterOpenBtn').addEventListener('click', () => {
      filterModalSnapshot = snapshotFilters();
      $('filterModal').hidden = false;
    });
    const closeFilterModal = (apply) => {
      $('filterModal').hidden = true;
      if (apply) {
        renderChips();
        renderPickerState();
        renderLibrary();
      } else {
        restoreFilters(filterModalSnapshot);
        syncQuickFilterUI();
        renderChips();
        renderPickerState();
        renderLibrary();
      }
    };
    $('filterModalApply').addEventListener('click', () => closeFilterModal(true));
    $('filterModalCancel').addEventListener('click', () => closeFilterModal(false));
    $('closeFilterModal').addEventListener('click', () => closeFilterModal(false));
    $('filterModal').addEventListener('click', (e) => { if (e.target === $('filterModal')) closeFilterModal(false); });
  }

  /* 练习设置弹窗：设置本来就是即时生效，弹窗只当容器 */
  const openSettingsModal = () => {
    $('settingsModal').hidden = false;
    refreshBlockedUI();
    refreshAudioCacheStat();
    renderExtPackList();
    fetchExtManifest();
  };
  if ($('settingsOpenBtn')) $('settingsOpenBtn').addEventListener('click', openSettingsModal);
  if ($('settingsGearBtn')) $('settingsGearBtn').addEventListener('click', openSettingsModal);
  if ($('settingsOpenBtn') || $('settingsGearBtn')) {
    const closeSettingsModal = () => { $('settingsModal').hidden = true; };
    $('settingsModalDone').addEventListener('click', closeSettingsModal);
    $('closeSettingsModal').addEventListener('click', closeSettingsModal);
    $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettingsModal(); });
  }
  if ($('extPackList')) {
    $('extPackList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ext-action]');
      if (!btn) return;
      if (btn.dataset.extAction === 'load') loadExtPack(btn.dataset.extId);
      else if (btn.dataset.extAction === 'remove') removeExtPack(btn.dataset.extId);
    });
  }
  if ($('copyBriefBtn')) {
    $('copyBriefBtn').addEventListener('click', () => {
      const box = $('aiBrief');
      if (!box) return;
      const text = box.value;
      const done = () => toast('提示词已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
          box.select();
          toast('复制失败，已选中提示词，按 Command+C');
        });
      } else {
        box.select();
        toast('已选中提示词，按 Command+C 复制');
      }
    });
  }
  $('pasteResumeBtn').addEventListener('click', () => startSession('list', 'all'));
  $('pasteInput').addEventListener('input', onPasteInput);
  $('pasteStart').addEventListener('click', startPasteSession);
  $('pasteCancel').addEventListener('click', closePasteModal);
  $('closePasteModal').addEventListener('click', closePasteModal);
  $('pasteModal').addEventListener('click', (e) => { if (e.target === $('pasteModal')) closePasteModal(); });
  $('importResult').addEventListener('click', (e) => {
    if (e.target.closest('[data-start-list]')) startSession('list', 'all');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('pasteModal') && !$('pasteModal').hidden) { closePasteModal(); return; }
    if ($('importModal') && !$('importModal').hidden) { closeImportModal(); return; }
  });

  $('analyticsBtn').addEventListener('click', () => { $('analyticsPanel').hidden = !$('analyticsPanel').hidden; });
  $('exportBtn').addEventListener('click', () => exportProgress());
  $('importBackupBtn').addEventListener('click', () => $('backupInput').click());
  $('backupInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    handleBackupFile(file);
  });
  const closeBackupModal = () => { $('backupModal').hidden = true; pendingBackup = null; };
  $('closeBackupModal').addEventListener('click', closeBackupModal);
  $('backupCancel').addEventListener('click', closeBackupModal);
  $('backupModal').addEventListener('click', (e) => { if (e.target === $('backupModal')) closeBackupModal(); });
  $('backupConfirm').addEventListener('click', async () => {
    if (!pendingBackup) return;
    const b = pendingBackup;
    pendingBackup = null;
    $('backupModal').hidden = true;
    $('backupConfirm').disabled = true;
    try {
      await applyBackup(b);
    } catch (e) {
      $('backupConfirm').disabled = false;
      const msg = '恢复中断：' + (e && e.message ? e.message : e) + '。可重新导入同一个备份。';
      $('backupMsg').textContent = msg;
      toast(msg);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('backupModal') && !$('backupModal').hidden) closeBackupModal();
  });
  $('endpointInput').addEventListener('change', (e) => {
    settings.endpoint = e.target.value.trim();
    saveSettings();
    renderStats();
  });
  $('reportToggle').addEventListener('change', (e) => {
    settings.report = e.target.checked;
    if (settings.report && !settings.endpoint) toast('先填写上报端点');
    saveSettings();
    renderStats();
  });
  $('flushBtn').addEventListener('click', flushAnalytics);

  $('sessionBody').addEventListener('click', (e) => {
    const rateBtn = e.target.closest('[data-rate]');
    if (rateBtn) {
      settings.listenRate = Number(rateBtn.dataset.rate) === 0.8 ? 0.8 : 1;
      saveSettings();
      document.querySelectorAll('.listen-rate [data-rate]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.rate) === settings.listenRate);
      });
      const card = currentCard();
      if (card) {
        const playBtn = document.querySelector('.listen-play');
        if (playBtn) setPlayingState(playBtn, 8000);
        playListenAudio(card).finally(clearPlayingState);
      }
      return;
    }
    const choice = e.target.closest('[data-choice]');
    if (choice) { selectChoice(Number(choice.dataset.choice)); return; }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'next-stage') advanceStage();
    else if (action === 'submit-guess') submitGuess();
    else if (action === 'skip-guess') skipGuess();
    else if (action === 'submit-recall') submitRecall();
    else if (action === 'give-up') giveUp();
    else if (action === 'next-card') nextCard();
    else if (action === 'block-word') blockCurrentWord();
    else if (action === 'restart') restartSession();
    else if (action === 'speak-word') {
      const card = currentCard();
      if (card) {
        setPlayingState(btn, 8000);
        speakWord(card.word.word).finally(clearPlayingState);
      }
    } else if (action === 'play-audio') {
      const card = currentCard();
      if (card) {
        setPlayingState(btn, 8000);
        playListenAudio(card).finally(clearPlayingState);
      }
    } else if (action === 'listen-to-recall') {
      const card = currentCard();
      if (card) switchListenToRecall(card, '已改为看释义拼写');
    } else if (action === 'go-wrong') {
      closeSession();
      showView('data');
      setTimeout(() => $('wrongCard').scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    } else if (action === 'close-session') closeSession();
  });

  document.addEventListener('keydown', (e) => {
    if (!session || e.isComposing) return;
    // 任何弹窗打开时快捷键都让位：只挡 sessionBody 之外的按键，答题框内仍可正常提交
    const modalOpen = ['settingsModal', 'wordModal', 'importModal', 'filterModal', 'pasteModal', 'backupModal', 'privacyModal']
      .some((id) => { const el = $(id); return el && !el.hidden; });
    if (modalOpen && e.target && e.target.id !== 'guessInput' && e.target.id !== 'recallInput') return;
    const tag = e.target && e.target.tagName;
    const inAnswerInput = e.target && (e.target.id === 'guessInput' || e.target.id === 'recallInput');
    if (tag === 'INPUT' && !inAnswerInput) return;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    const card = currentCard();
    if (!card) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const stage = cardStage(card);
      if (stage === 'guess') submitGuess();
      else if (stage === 'recall' || stage === 'listen') submitRecall();
      else if (stage === 'result') nextCard();
      else advanceStage();
      return;
    }
    if (/^[1-4]$/.test(e.key) && cardStage(card) === 'guess' && card.method === 'choice') {
      e.preventDefault();
      selectChoice(Number(e.key) - 1);
    }
  });
}

function startSessionForWord(word) {
  if (isHiddenWord(String(word))) return; // 屏蔽/下架词不许从错题本复活
  const w = findWord(String(word).toLowerCase()) || makeWord({ word, meanings: ['（词条已删除，仅保留错题记录）'] }, 'user');
  if (!w) return;
  stopSpeaking();
  lastAudioKey = '';
  session = {
    source: 'wrong',
    countMode: 'single',
    direction: settings.direction === 'listen' && !hasOfflineAudio(w) ? 'en2zh' : settings.direction,
    filtersSnapshot: snapshotFilters(),
    queue: [makeCard(w)],
    index: 0,
    total: 1,
    correct: 0,
    answered: 0,
    streakNow: 0,
    bestStreak: 0,
    startedAt: Date.now(),
    finished: false
  };
  track('practice_start', { source: 'single', word: w.word });
  sessionEditing = false;
  renderSession();
  showView('practice');
}

/* ---------- 启动 ---------- */
/* ---------- 显示模式：白天 / 晚上 ---------- */
function applyTheme(theme, persist) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  if (persist) {
    try { localStorage.setItem('wd-theme', t); } catch (e) { /* 隐私模式下静默 */ }
  }
  const toggle = $('themeToggle');
  if (toggle) {
    const label = t === 'dark' ? '切到白天' : '切到晚上';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  const colorMeta = document.getElementById('themeColorMeta');
  if (colorMeta) colorMeta.setAttribute('content', t === 'dark' ? '#141713' : '#f2efe7');
  const schemeMeta = document.getElementById('colorSchemeMeta');
  if (schemeMeta) schemeMeta.setAttribute('content', t);
}

function initTheme() {
  applyTheme(document.documentElement.dataset.theme || 'light', false);
  const toggle = $('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
    });
  }
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', (e) => {
        let saved = null;
        try { saved = localStorage.getItem('wd-theme'); } catch (err) { /* 静默 */ }
        if (!saved) applyTheme(e.matches ? 'dark' : 'light', false);
      });
    }
  }
}

/* ---------- 滚动条：靠近右缘或滚动时渐显，不改变布局宽度 ---------- */
function initScrollbarHint() {
  const root = document.documentElement;
  let hideTimer = null;
  const flash = () => {
    root.classList.add('edge-near');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => root.classList.remove('edge-near'), 1000);
  };
  window.addEventListener('mousemove', (e) => {
    clearTimeout(hideTimer);
    root.classList.toggle('edge-near', window.innerWidth - e.clientX <= 64);
  }, { passive: true });
  window.addEventListener('scroll', flash, { passive: true });
  document.addEventListener('mouseleave', () => root.classList.remove('edge-near'));
}

async function init() {
  initTheme();
  initScrollbarHint();
  await loadState();
  showStorageNotice();
  // 词根先用内置副本；是否下载 roots.json 交给 content/manifest.json 的版本号决定
  await loadRootContent(typeof ROOT_DATA !== 'undefined' ? ROOT_DATA.version : '');
  // 敏感性清单决定练习库与干扰项安全池，必须在任何队列/选项卡生成之前加载
  await loadSensitiveContent();
  buildFilterOptions();
  bindEvents();
  syncSettingsUI();
  refreshAudioCacheStat();
  refreshBlockedUI();
  renderAll();
  showView('practice', { scroll: false });
  maybeShowOnboarding();
  // 音频索引（约 89KB）后台加载：索引没回来时听音入口先按不可用展示，到达后刷新可用态
  loadAudioIndex()
    .then(() => { syncListenAvailability(); if (currentCard()) renderSession(); })
    .catch(() => null);
  // 例句旁路（约 264KB）也放后台：默认开启不等于挡首屏，到达后再刷新
  if (settings.showExamples) {
    loadExamplesContent()
      .then(() => { if (settings.showExamples) renderAll(); })
      .catch(() => null);
  }
  track('app_open', { db: DB.mode.current, version: CONFIG.version });
  setupPWA();
  refreshRemoteContent();
  probeVoice().catch(() => null);
  if (new URLSearchParams(location.search).get('action') === 'review') {
    setTimeout(() => startSession('review', 'all'), 250);
  }
  window.__wtp = {
    get session() { return session; },
    get settings() { return settings; },
    get library() { return library(); },
    get pasteList() { return pasteList; },
    get builtinCount() { return BUILTIN.length; },
    get rawCoreCount() { return typeof RAW_CORE_WORDS !== 'undefined' ? RAW_CORE_WORDS.length : 0; },
    get coreWords() { return typeof RAW_CORE_WORDS !== 'undefined' ? RAW_CORE_WORDS.slice() : []; },
    get curatedWords() { return RAW_WORDS.slice(); },
    resolvePasteList,
    parseTXTWords,
    get srsMap() { return srsMap; },
    get wrongBook() { return wrongBook; },
    get events() { return events; },
    get daily() { return daily; },
    get contentInfo() { return contentInfo; },
    get rootsInfo() { return rootsInfo; },
    get rootData() { return rootData; },
    get features() { return { listenDictation: FEATURES.listenDictation }; },
    wordExamples,
    examplesHTML,
    EXAMPLE_BANK,
    rootEntry,
    drillRoots,
    startDrill,
    startSessionForWord,
    get voice() { return { status: VOICE.status, voice: VOICE.voice ? VOICE.voice.name : '', unlocked: VOICE.unlocked, error: VOICE.lastError }; },
    probeVoice,
    forceVoiceStatus(status) { VOICE.status = status; VOICE.forced = true; persistVoiceProbe(); },
    speak: speakWord,
    startSession,
    parseCSVWords,
    parseJSONWords,
    renderSession,
    gradeEnglish,
    buildChoices,
    get sensitive() {
      return { loaded: SENSITIVE.loaded, count: SENSITIVE.words.size, removed: Array.from(SENSITIVE.removed) };
    },
    isSensitiveWord,
    isDistractorSafe,
    isHiddenWord,
    isUnsafeMeaningText: isSubstringUnsafeMeaning,
    meaningsOverlap,
    spellingTooClose,
    blockWord: addBlockedWord,
    unblockLast: undoBlockedWord,
    get blockedWords() { return Array.from(blockedWords); },
    buildProgressPayload,
    renderAll,
    todaySnapshot,
    parseBackup,
    applyBackup,
    DB,
    get stats() { return stats; },
    get extWords() { return extWords; },
    get extStore() { return extStore; },
    get extManifest() { return extManifest; },
    loadExtPack,
    removeExtPack
  };
}

function showInitError(e) {
  const msg = e && e.message ? e.message : String(e);
  document.body.insertAdjacentHTML('beforeend', `<div class="card init-error-card">
    <b>初始化失败（V${esc(CONFIG.version)}）</b>
    <p>${esc(msg)}</p>
    <div class="empty-actions">
      <button class="btn tiny" type="button" id="initRetryBtn">重试</button>
      <button class="btn tiny ghost" type="button" id="initCopyBtn">复制错误信息</button>
    </div>
  </div>`);
  $('initRetryBtn').addEventListener('click', () => location.reload());
  $('initCopyBtn').addEventListener('click', async () => {
    const text = `单词练习台 V${CONFIG.version}\n${msg}\n${navigator.userAgent}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('错误信息已复制');
    } catch (err) {
      toast('复制失败，请手动记录：' + msg);
    }
  });
}

init().catch(showInitError);

})();

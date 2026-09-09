// Interface language for the web UI. Deliberately SEPARATE from the notebook's output language.
//
// `RN_OUTPUT_LANGUAGE` / `Notebook.output_language` (invariant 39) decide what the MODEL writes —
// answers, summaries, a podcast script. This decides what the BUTTONS say. They are different
// questions with different right answers: a reader in Taiwan may well want a Chinese interface over
// English papers, and folding the two together makes that combination unexpressible.
//
// The choice IS now sent to the server, as one SIGNAL among four that `naming.SuggestLanguage`
// weighs when a notebook has no output language yet (`X-RLM-Interface-Language`, added in `api()`).
// That is not the two settings merging: an explicit output-language setting still wins outright and
// the settings page still carries both rows. It is that a reader who picked Traditional Chinese for
// the interface has told us something real about what they read, and ranking it ABOVE
// `Accept-Language` — which was inherited from the OS, not chosen here — is what a user asked for
// after their notebook came back titled in English. An earlier version of this comment said nothing
// here ever reaches a prompt; that stopped being true and is stated rather than left to be found.
//
// Zero-build, same as the rest of `web/`: a plain script defining globals, loaded before `app.js`.

const UI_LANGUAGES = [
  // `name` is the ENGLISH name, and is what travels to the server as the language SIGNAL — the
  // model weighing it answers in English language names ("Traditional Chinese"), so sending
  // `zh-Hant` or `繁體中文` would make it parse a code or a word in the very language it is trying
  // to identify. `label` stays in the language itself, because that is what a picker should show.
  { code: "en", label: "English", name: "English" },
  { code: "zh-Hant", label: "繁體中文", name: "Traditional Chinese" },
];

// The English name of the interface language currently in force, for the request header.
function uiLangName() {
  const found = UI_LANGUAGES.find((l) => l.code === uiLang());
  return found ? found.name : "";
}

const STRINGS = {
  en: {},  // the source language: every key falls back to `index.html`/`app.js`'s own text
  "zh-Hant": {
    // --- header
    "app.newNotebook": "開新筆記本",
    "app.settings": "設定",
    "app.theme": "切換 Paper / Study 佈景",
    "app.pickerTip": "切換筆記本、改名，或開一本新的",
    "app.noNotebook": "還沒有筆記本",
    "app.untitled": "未命名筆記本",
    "app.newNotebookRow": "＋ 新的筆記本",
    "app.rowMeta": "{sources} 個來源 · {turns} 次對話",
    "app.rename": "改名",
    "app.generating": "這個筆記本正在產生東西",
    "time.justNow": "剛剛",
    "time.minutes": "{n} 分鐘前",
    "time.hours": "{n} 小時前",
    "time.days": "{n} 天前",
    "err.rename": "無法改名：{message}",

    // --- sources
    "sources.head": "來源",
    "sources.tab.url": "網址",
    "sources.tab.text": "貼上文字",
    "sources.tab.file": "檔案",
    "sources.url.hint": "網頁，或 YouTube 連結；只取字幕，不會下載影片或音訊。",
    "sources.text.placeholder": "貼上要匯入的文字…",
    "sources.file.hint": "PDF、TXT 或 Markdown，一次一個檔案。",
    "sources.add": "加入來源",
    "sources.empty": "還沒有來源。從上面加入一個。",
    "sources.adding": "加入中…",
    "sources.remove": "移除這個來源",
    "sources.removeConfirm": "要把「{origin}」從這個筆記本移除嗎？",
    "sources.flagHelp":
      "這是在來源本身的文字裡發現的，不是在你的提問裡。它沒有被阻擋，回答仍然會引用它；這只是提醒你，這份來源包含看起來像是在對模型下指令的內容。",
    "err.removeSource": "無法移除來源：{message}",

    // --- chat
    "chat.head": "對話",
    "chat.empty": "加入來源之後就可以開始提問。",
    "chat.placeholder": "提出一個有依據的問題…",
    "chat.ask": "提問",
    "chat.enterHint": "送出",
    "chat.newlineHint": "換行",
    "chat.thinking": "思考中…",
    "chat.stopped": "（已停止）",
    "chat.askNext": "接著問",
    "chat.noStarters": "這份概覽沒有附上建議問題，重新產生可以再試一次。",
    "chat.startWith": "可以先問",
    "chat.generateOverview": "✨ 整理重點並建議問題",
    "chat.orJustAsk": "…或直接在下面提問。",
    "chat.regenerateOverview": "↻ 重新產生概覽",
    "chat.overview": "概覽",
    "chat.overviewStale": "概覽 · 來源在這之後有變動",
    "chat.overviewSuperseded": "這份概覽已被新的產製取代。",
    "chat.overviewFailed": "（無法產生概覽：{message}）",
    "chat.tryAgain": "↻ 再試一次",
    "chat.readingSources": "正在讀取你的來源…",
    "chat.saveAsNote": "存成筆記",
    "chat.saved": "已存進筆記",
    "chat.saveAsNoteHelp":
      "在右側 Notes 保留一份副本。筆記之後可以「升級」成來源，那才是讓後續提問引用得到它的關鍵。",

    // --- citations
    "cite.references": "{n} 則參考",
    "cite.trace": "⌁ 推理",
    "cite.traceTip": "顯示模型讀到這段文字的那一步",
    "cite.verified": "這組座標確實對應到來源裡的真實文字。這不代表旁邊那句話忠實地描述了它。",
    "cite.unverified": "無法用目前的來源解析出這組座標{reason}",
    "cite.loading": "載入中…",
    "source.kind": "類型",
    "source.url": "網址",
    "source.origin": "來源",
    "source.pasted": "貼上的文字",
    "source.pastedIn": "直接貼進這個筆記本",
    "source.size": "大小",
    "source.sizeValue": "{blocks} 個區塊 · {chars} 個字元",
    "source.flags": "已標記",

    // --- studio
    "studio.head": "工作室",
    "studio.collapse": "收合這個面板",
    "references.head": "參考",
    "references.sub": "這個筆記本裡所有被引用過的段落，集中在一處。",
    "references.empty": "還沒有任何引用。先提問，或產生一份概覽。",
    "references.uses": "引用 {n} 次",
    // --- trajectory drawer
    "chat.refreshOverview": "↻ 重新產生",
    "chat.clear": "清空對話",
    "chat.clearTip": "刪除這本筆記本裡所有的提問與回答。來源、筆記和概覽會保留。",
    "chat.clearConfirm": "確定要刪除全部 {n} 則提問與回答？來源、筆記和概覽會保留。",
    "chat.regenerateTurn": "↻ 重新產生",
    "chat.regenerateTurnTip": "重新問一次這個問題並取代這則回答。會花費一次完整的模型執行。",
    "chat.overviewSecondHalf": "摘要完成 · 正在產生建議問題…",
    "traj.title": "執行軌跡",
    "traj.open": "開啟這次執行的軌跡",
    "traj.start": "開始",
    "traj.initTitle": "起始狀態",
    "traj.initSub": "輸入 + 環境",
    "traj.timingTag": "● 每回合耗時",
    "traj.timingTagOff": "ⓘ 耗時",
    "traj.budgetTag": "\u25cf 用量",
    "traj.budgetTagCut": "\u26a0 已截斷",
    "traj.budgetTagNone": "\u24d8 用量",
    "traj.budgetOk": "最吃資源的一輪用了 {used} / {cap} tokens（{pct}%）。",
    "traj.budgetCut": "有一輪撞到生成上限：{used} tokens，上限 {cap}。被截斷的如果是程式碼格，通常下一輪就會修好；被截斷的如果是最終答案，這次執行就結束了。",
    "traj.budgetNone": "這份軌跡沒有記錄 token 用量：它早於這個欄位存在。這不等於「沒有發生截斷」。",
    "traj.budgetPartial": "這次執行沒有回報生成上限。",
    "traj.budgetNoUsage": "生成上限是 {cap} tokens；這次執行沒有記錄可供比對的 token 用量。",
    "traj.budgetDropped": "步數預算被拒絕並退回函式庫的預設值，所以設定的上限並未生效。",
    "traj.noTools": "這次執行沒有呼叫任何工具 \u2014 包括指示要求它在 SUBMIT 前執行的驗證器。",
    "traj.noMeta": "這次執行沒有留下設定紀錄。",
    "traj.notStarted": "這次執行還沒有留下任何紀錄，可能還在啟動，也可能根本沒跑起來。",
    "traj.search": "搜尋回合…",
    "traj.stat": "{turns} 個回合 · {tools} 次工具呼叫",
    "traj.init": "起始",
    "traj.turn": "第 {n} 回合",
    "traj.task": "任務",
    "traj.reasoning": "推理",
    "traj.code": "程式碼",
    "traj.output": "輸出",
    "traj.tool": "工具",
    "traj.openTurn": "\u2191 開啟回合 {n}",
    "traj.verdict": "驗證結果",
    "traj.result": "結果",
    "traj.input": "輸入",
    "traj.error": "錯誤",
    "traj.matches": "{n} 筆符合",
    "traj.missing": "找不到這次執行的軌跡（{message}）",
    "traj.timingLive": "每回合的耗時是即時記錄的，在每個回合被解析時就寫下。",
    "traj.timingStale": "這份軌跡沒有每回合的耗時（回合不是即時標記的，或這次執行太短）；上方的工具時間軸仍是真實時間。",
    "cite.unverifiedShort": "座標對不上",
    "cite.unverifiedHover": "{label}（這個座標在來源中找不到）",
    "cite.unverifiedWhy":
      "這則引用指向的位置在這個來源裡不存在，所以我們無法查核它。下面的引文本身仍可能是正確的，" +
      "對不上的是位址，不一定是內容。",
    "studio.sub": "從你的來源產出的東西。這裡沒有任何操作會自動執行。",
    "studio.tab.summary": "摘要",
    "studio.tab.faq": "問答",
    "studio.tab.timeline": "時間軸",
    "studio.tab.insight": "洞察",
    "studio.tip.summary": "涵蓋所有來源說了什麼的幾段文字，附上可以查證的引用。",
    "studio.tip.faq": "你的來源真正回答得了的問題，每題都附答案和引用。",
    "studio.tip.timeline": "從來源裡抽出有日期的事件，依序排列。",
    "studio.tip.insight": "最重要的一個結論，一句話。",
    "studio.regenerate": "↻ 重新產生",
    "studio.regenerateTip": "用目前的來源再跑一次。",
    "studio.generate": "✨ 產生{kind}",
    "studio.generating": "正在產生{kind}…",
    "studio.addSourceFirst": "先加入來源，才能產生這個。",
    "studio.kind.summary": "摘要",
    "studio.kind.faq": "問答",
    "studio.kind.timeline": "時間軸",
    "studio.kind.insight": "洞察",
    "studio.noFaq": "（沒有問答項目，來源不足以整理出問題）",
    "studio.noTimeline": "（沒有時間軸事件，來源裡沒有可定位在時間上的內容）",

    // --- podcast
    "podcast.head": "Podcast",
    "podcast.sub": "兩位主持人討論你的來源，產出一集可以播放或下載的節目。",
    "podcast.generate": "產生 Podcast",
    "podcast.length": "長度",
    "podcast.lenShort": "短",
    "podcast.lenDefault": "預設",
    "podcast.lenLong": "長",
    "podcast.lengthTip": "節目要瞄準多長。越長，模型執行和語音合成都越久。",
    "podcast.regenerate": "↻ 重新產生 Podcast",
    "podcast.regenerateStale": "↻ 重新產生 · 來源已變動",
    "podcast.generateTip": "先寫出一份以你的來源為依據的雙主持人腳本，再合成語音。這是這裡最慢的操作。",
    "podcast.writing": "正在撰寫腳本…",
    "podcast.stale": "Podcast · 來源在這之後有變動",
    "podcast.empty": "（沒有 Podcast 腳本，來源不足以討論）",
    "podcast.failed": "（無法產生 Podcast）{message}",
    "podcast.download": "⤓ 下載 {ext}",
    "podcast.downloadPlain": "⤓ 下載音訊",

    // --- notes
    "notes.head": "筆記",
    "notes.sub":
      "你自己的筆記本。在對話裡用「＋ 存成筆記」保存一個回答，之後把筆記「升級」成來源，後續提問就能引用它。",
    "notes.placeholder": "寫一則筆記…",
    "notes.add": "新增筆記",
    "notes.empty": "還沒有筆記。",
    "notes.promote": "→ 升級成來源",
    "md.urlCopied": "已複製連結網址",
    "notes.promoteHelp":
      "把這則筆記變成真正的來源。只有這樣，後續的提問才引用得到它；筆記本身只是文字，沒有自己的引用。",
    "notes.delete": "刪除",

    // --- run status
    "run.awaitingModelLong": "仍在等待模型第一次回應 · {time} · 在它回覆之前不會有任何進度回報；可以按停止",
    "run.notStoppable": "這個階段無法中斷。",
    "podcast.synthesizing": "正在合成語音…（此階段無法中止）",
    "err.stepsLoad": "⌁ 步驟",
    "err.stepsGone": "⌁ 沒有紀錄",
    "err.stepsGoneNote": "這次執行的紀錄已被清除。紀錄只保留一段時間。",
    "run.stop": "⏹ 停止",
    "run.stopping": "停止中…",
    "trace.start": "啟動",
    "trace.step": "第 {n} 步",
    "trace.stepBare": "步驟",
    "trace.tool": "工具",
    "trace.escalation": "子模型",
    "trace.final": "收尾",
    "trace.result": "結果",
    "trace.done": "完成",
    "trace.failed": "失敗",
    "trace.notFound": "這次執行沒有即時進度",
    "run.logToggle": "{n} 個步驟",
    "run.waiting": "已等待 {time}",
    "run.awaitingModel": "正在等待模型第一次回應 · {time}",
    "run.count.thinking": "步",
    "run.count.tool": "次工具",
    "run.count.escalation": "次求助子模型",

    // --- settings
    "settings.head": "設定",
    "settings.close": "關閉",
    "settings.save": "儲存",
    "settings.useDefault": "使用預設",
    "settings.uiLanguage": "介面語言",
    "settings.uiLanguageHelp": "只影響這個畫面的文字，不影響模型寫出來的內容。",
    "settings.outputLanguage": "輸出語言",
    "settings.outputLanguageHelp":
      "留空的話，每個筆記本會自己從你的瀏覽器、來源和提問推斷。",
    "settings.outputLanguagePlaceholder": "例如：繁體中文",
    "settings.voiceA": "Podcast 嗓音：主持人 A",
    "settings.voiceB": "Podcast 嗓音：主持人 B",
    "settings.voiceHelp":
      "留空的話使用該 TTS 的預設：edge-tts 跟隨筆記本語言，chatterbox 使用內附的 host-a / host-b 嗓音。",
    "settings.pinnedBy": "由 {env} 指定，此處無法修改",
    "studio.noNotebook": "先開啟一個有來源的筆記本，再選擇分頁產生內容。",
    "settings.readError": "設定檔讀取失敗（{error}），顯示的是預設值。",
    "settings.saveFailed": "無法儲存設定：{message}",

    // --- generic errors
    "err.openNotebookFirst": "請先開啟或命名一個筆記本。",
    "err.addSource": "無法加入來源：{message}",
    "err.promoteNote": "無法升級筆記：{message}",
    "err.deleteNote": "無法刪除筆記：{message}",
    "err.saveNote": "無法儲存筆記：{message}",
    "err.generic": "（錯誤）{message}",
    "err.steps": "⌁ {n} 步",
  },
};

const UI_LANG_KEY = "rlmnb-ui-lang";

function normalizeUiLang(raw) {
  if (!raw) return null;
  const value = String(raw).toLowerCase();
  // Traditional Chinese is `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`. Simplified (`zh-CN`, `zh-Hans`)
  // deliberately does NOT match: shipping Traditional text to a Simplified reader would be worse
  // than English, and this project's own audience asked for Traditional specifically.
  if (/^zh(-|_)?(hant|tw|hk|mo)/.test(value)) return "zh-Hant";
  if (value === "zh-hant") return "zh-Hant";
  if (value.startsWith("en")) return "en";
  return null;
}

function uiLang() {
  const stored = localStorage.getItem(UI_LANG_KEY);
  if (stored && STRINGS[stored]) return stored;
  for (const candidate of navigator.languages || [navigator.language]) {
    const found = normalizeUiLang(candidate);
    if (found) return found;
  }
  return "en";
}

function setUiLang(code) {
  if (!STRINGS[code]) return;
  localStorage.setItem(UI_LANG_KEY, code);
  document.documentElement.lang = code;
  applyStaticI18n();
  window.dispatchEvent(new CustomEvent("ui-lang-changed", { detail: { lang: code } }));
}

// `fallback` is the ENGLISH source text, passed at the call site rather than kept in a second
// dictionary: `en` stays empty above, so the English UI is whatever the markup and the code already
// say and can never drift out of sync with a translation table nobody updated.
function t(key, fallback, vars) {
  const table = STRINGS[uiLang()] || {};
  let text = table[key];
  if (text === undefined) text = fallback !== undefined ? fallback : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

// Static markup carries `data-i18n` (text), `data-i18n-title` and `data-i18n-placeholder`. The
// element's EXISTING content is the English fallback, so `index.html` stays readable on its own.
function applyStaticI18n(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    if (el.dataset.i18nSource === undefined) el.dataset.i18nSource = el.textContent.trim();
    el.textContent = t(el.dataset.i18n, el.dataset.i18nSource);
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    if (el.dataset.i18nTitleSource === undefined) el.dataset.i18nTitleSource = el.title;
    el.title = t(el.dataset.i18nTitle, el.dataset.i18nTitleSource);
  });
  scope.querySelectorAll("[data-i18n-tip]").forEach((el) => {
    // `data-tip` drives this project's OWN tooltip (instant, styled, animated with the hover
    // effect) rather than the native `title`, which the browser delays about a second and renders
    // in its own chrome — the delay is what made the siblings' hover help feel snappier than ours.
    if (el.dataset.i18nTipSource === undefined) el.dataset.i18nTipSource = el.dataset.tip || "";
    el.dataset.tip = t(el.dataset.i18nTip, el.dataset.i18nTipSource);
  });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    if (el.dataset.i18nPlaceholderSource === undefined) {
      el.dataset.i18nPlaceholderSource = el.placeholder;
    }
    el.placeholder = t(el.dataset.i18nPlaceholder, el.dataset.i18nPlaceholderSource);
  });
  scope.querySelectorAll("[data-i18n-html]").forEach((el) => {
    // Rich static copy. The body is a plain `textContent` assignment, which would FLATTEN any
    // markup — the route is currently unused (no element in `index.html` carries the attribute) and
    // an earlier comment here described a template-rebuilding mechanism that was never written.
    // Kept because `textContent` is the safe half of that idea (invariant 29); if a translated
    // sentence ever needs inline markup, this has to be built, not assumed.
    if (el.dataset.i18nHtmlSource === undefined) el.dataset.i18nHtmlSource = el.textContent.trim();
    const translated = t(el.dataset.i18nHtml, el.dataset.i18nHtmlSource);
    el.textContent = translated;
  });
}

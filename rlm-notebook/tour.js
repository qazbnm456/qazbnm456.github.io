/* rlm-notebook PLAYGROUND — helpers, tour data, and the extra chrome.
 *
 * Loaded BEFORE `shim.js`, which calls into `window.rlmPlayground` for the four things that need a
 * judgement rather than a route: which recorded run to replay, how to shape a ticker event, what a
 * Guide tab should return, and what the Trajectory drawer reads.
 *
 * Everything the build precomputed with the real Python lives in `fixtures.json`; this file only
 * chooses between those pieces. Nothing here re-derives an answer the product already knows how to
 * compute — that rule is why the playground cannot drift into a mock-up.
 */
(() => {
  "use strict";
  const PG = (window.rlmPlayground = window.rlmPlayground || {});

  // --- which recorded run to replay -------------------------------------------------------------
  //: Traces are keyed by the run id of the run that HAPPENED; the playground's run ids are minted
  //: fresh by `app.js` each time. So the pick is by TASK and notebook, and a miss degrades to a
  //: short synthesised sequence rather than an empty ticker (invariant 29: a missing trace costs
  //: one affordance, never the page).
  const TASK_FOR = {
    ask: "AnswerQuestion",
    overview: "GenerateSummary",
    audio: "GeneratePodcastScript",
    "guide:summary": "GenerateSummary",
    "guide:faq": "GenerateFAQ",
    "guide:timeline": "GenerateTimeline",
    "guide:insight": "GenerateInsight",
  };

  PG.runsFor = (fixtures, nbId, kind) => {
    const want = TASK_FOR[kind] || "";
    return Object.entries(fixtures.runs || {})
      .filter(([id, r]) => id.startsWith(`${nbId}-`) && r.task.endsWith(want))
      .map(([, r]) => r);
  };

  PG.pickTrace = (fixtures, meta, runId) => {
    if (meta) {
      const pool = PG.runsFor(fixtures, meta.nbId, meta.kind);
      if (pool.length) return pool[0].ticker;
      const any = PG.runsFor(fixtures, meta.nbId, "ask");
      if (any.length) return any[0].ticker;
    }
    const first = Object.values(fixtures.runs || {})[0];
    return first ? first.ticker : PG.syntheticTicker();
  };

  PG.syntheticTicker = () => [
    { step: 1, kind: "thinking", primary: "Step 1", detail: "Reading the corpus and locating the source markers.", meta: null },
    { step: 2, kind: "code", primary: "Step 2", detail: "Slicing the blocks this answer will cite.", meta: null },
    { step: 3, kind: "tool", primary: "validate", primary_detail: "", detail: "Validation successful.", meta: null },
  ];

  //: `_translate_trace_event` already produced the shape `app.js` reads (invariant 52's
  //: `{kind, primary, detail, meta}`); it returns `null` for events with nothing to say, and the
  //: stream must not forward those.
  PG.tickerEvent = (raw) => raw || { kind: "thinking", primary: "…", detail: "", meta: null };

  // --- the Trajectory drawer --------------------------------------------------------------------
  PG.trajectory = (run) => run.trajectory;

  // --- Guide tabs -------------------------------------------------------------------------------
  //: Only the overview is persisted onto a notebook (invariant 38), and a Guide artifact is not —
  //: so `summary` and `faq` can be served from what this notebook REALLY produced (the overview is
  //: `GenerateSummary` + `GenerateFAQ`'s output), and `timeline`/`insight` have no recorded
  //: artifact at all.
  //:
  //: They therefore say so. Inventing a timeline would be the one genuinely dishonest thing this
  //: playground could do: every other pixel is either the shipped UI or output a model actually
  //: produced, and a reader has no way to tell a fabricated artifact from a real one.
  PG.guide = (nb, kind) => {
    const ov = nb.overview;
    if (kind === "summary" && ov) {
      return { kind, text: ov.text, citations: ov.citations, run_id: ov.run_id };
    }
    if (kind === "faq" && ov && (ov.starter_questions || []).length) {
      return {
        kind,
        items: ov.starter_questions.map((q) => ({
          question: q,
          answer:
            "Ask this in the Chat panel and you will see it answered with citations you can check. " +
            "The playground replays the questions this notebook really produced.",
          citations: [],
        })),
        run_id: ov.run_id,
      };
    }
    // SHAPED FOR THE REAL RENDERER, one shape per kind. `app.js` is copied verbatim, so the shim
    // has to speak its language rather than the other way round, and its language is different for
    // each tab: `renderGuideContent` reads `data.text` for summary and insight, `data.items` for
    // faq, `data.events` for timeline.
    //
    // The old payload carried a `note` field that `app.js` reads NOWHERE. Two consequences, both
    // live on every notebook: summary and insight reached `renderAnswerWithCitations(undefined)`
    // and died in `mdLines` with "Cannot read properties of undefined (reading 'split')", after a
    // seven-second fake run; and faq and timeline fell to the product's own empty state, which says
    // the sources "didn't produce enough" — a false claim about the reader's own sources, on the
    // one page whose entire premise is that nothing here is fabricated.
    const lang = typeof uiLang === "function" ? uiLang() : "en";
    const note = lang === "zh-Hant"
      ? "這個工作室頁籤會發動一次真實的模型執行，而這個展示頁只重播這本筆記本真正產出過的東西。" +
        "裝起 rlm-notebook、對著你自己的來源跑一次就會有。這裡沒有任何東西是編造的。"
      : "This Studio tab runs a live model call, and the playground only replays artifacts this " +
        "notebook actually produced. Install rlm-notebook and run it against your own sources to " +
        "generate one. Nothing here is fabricated.";
    const heading = lang === "zh-Hant" ? "這本筆記本沒有這一項" : "Not recorded for this notebook";
    if (kind === "faq") {
      return { kind, items: [{ question: heading, answer: note, citations: [] }], run_id: null };
    }
    if (kind === "timeline") {
      return { kind, events: [{ when: heading, description: note, citations: [] }], run_id: null };
    }
    return { kind, text: note, citations: [], run_id: null };
  };

  // --- guided tour ------------------------------------------------------------------------------
  //: witr's playground taught the lesson this copies: a simulated product that does not TELL you
  //: what to try is a screenshot you can click. Each step names one action and what to look for.
  // --- the guided script ------------------------------------------------------------------------
  //: Each step SPOTLIGHTS one real control, says what it is about to do, and then WAITS for the
  //: reader to press it. Nothing advances on a timer: the point is not to play a video at somebody,
  //: it is that they did it, on the product's own controls, and can therefore believe it.
  //:
  //: `done(p)` reads `PG.progress()` — the stage the shim actually reached — rather than a click, so
  //: a reader who explores ahead is never told to press something they already pressed.
  //:
  //: **The instruction lives in ONE place: the popover anchored to the control.** It was in both the
  //: popover and the side panel, and a reader could not tell which one to act on, or whether "Skip
  //: step" was the thing being asked of them. The panel now carries only position and controls.
  //:
  //: Text is bilingual and follows `uiLang()` — the same interface language the product itself uses
  //: (invariant 48), so the page is never half-translated. A language the table has no entry for
  //: falls back to English rather than showing a key.
  const TEXT = {
    // NEVER write a demo limitation in a way that reads as a PRODUCT limitation. This step used to
    // say "you cannot add your own sources here", which on a product page tells a stranger the
    // product cannot take their sources, and then explained itself with "fetching, parses and OCR
    // run on a machine, not a browser tab" — an implementation detail with no referent for someone
    // who does not yet know what they are looking at. It made the product sound worse than it is.
    // Say what the product does; the demo boundary is a one-line aside, not an apology.
    sources: {
      en: ["Add the sources",
           "Press Add source. This notebook's sources arrive one after another.\n\n" +
           "In your own copy this box takes a URL, pasted text or a PDF, and scanned pages are " +
           "read with OCR."],
      "zh-Hant": ["加入來源",
           "按下「加入來源」，這本筆記本的來源會一則一則進來。\n\n" +
           "在你自己裝的版本裡，這個欄位可以貼網址、貼文字、上傳 PDF，掃描檔會自動做 OCR。"],
    },
    overview: {
      // Name the button, do not say "press the button". If the spotlight fails to land the reader
      // still knows what to look for, and the label is the same string the product renders.
      en: ["Open the notebook",
           "Press ✨ Summarise and suggest questions in the middle column.\n\nIt is a real model " +
           "run, and it does both: a summary of the whole corpus, and the questions worth asking " +
           "first. The reasoning in the status line was recorded from the run that produced it."],
      "zh-Hant": ["替筆記本開個場",
           "按中間欄的「✨ 整理重點並建議問題」。\n\n這是真實的模型執行，兩件事一起做：整份語料的" +
           "重點，加上幾個值得先問的問題。狀態列跑過去的推理，是當初產出它時錄下來的。"],
    },
    watch: {
      en: ["Watch it work",
           "This is the live reasoning trace: the model's own words, step by step, as the run " +
           "goes.\n\nThe dot pulses while it is working and Stop is real. The tour waits here " +
           "until the run finishes."],
      "zh-Hant": ["看它跑",
           "這是即時的推理軌跡：模型自己的話，一步一步跟著執行走。\n\n" +
           "圓點在跑的時候會閃，「停止」是真的可以按的。導覽會停在這裡，等這次執行結束。"],
    },
    ask1: {
      en: ["Ask the first question",
           "The question is already typed. Press Enter to send it.\n\nEvery claim in the answer " +
           "gets a numbered mark that points at the passage it came from."],
      "zh-Hant": ["問第一個問題",
           "問題已經填好了，按 Enter 送出。\n\n答案裡每一句話都會帶編號，指向它的出處。"],
    },
    watchAsk: {
      en: ["Watch the answer come back",
           "Same live trace, this time for a question.\n\nWhen it lands, every claim carries a " +
           "numbered mark, and a ⌁ pill appears underneath holding the run that produced it."],
      "zh-Hant": ["看回答跑出來",
           "一樣是即時軌跡，這次是一個問題的。\n\n跑完之後，每一句話都會帶編號，下面還會出現一個 ⌁ " +
           "標記，收著產生這個答案的那次執行。"],
    },
    trace: {
      en: ["Open the reasoning trajectory",
           "Press the ⌁ mark under the answer.\n\nInside: every planner turn in the model's own " +
           "words, a tool timeline scaled to real elapsed time, the token budget, and what the " +
           "validator rejected before it accepted the answer. Esc closes it."],
      "zh-Hant": ["打開推理軌跡",
           "按答案下面的 ⌁ 標記。\n\n裡面看得到：模型每一輪規劃的原話、照實際耗時縮放的工具時間軸、" +
           "token 用量，還有驗證器在放行之前退回過什麼。按 Esc 關掉。"],
    },
    traceClose: {
      en: ["Look around, then close it",
           "The transport replays the run at the speed it really ran, and \u2922 opens the drawer " +
           "full screen.\n\nPress \u2715 or Esc when you have seen enough. The workspace is " +
           "underneath, and the next question needs it back."],
      "zh-Hant": ["看完再關掉",
           "上面的播放列會照這次執行真正的耗時重播，\u2922 可以展開成全螢幕。\n\n看夠了就按 " +
           "\u2715 或 Esc。工作區在下面，下一題要用到。"],
    },
    ask2: {
      en: ["Ask a follow-up",
           "Press Enter again.\n\nEarlier turns are context, not evidence. This question can work " +
           "out what \u201cit\u201d refers to from the conversation, but its citations get checked " +
           "against the sources from scratch."],
      "zh-Hant": ["再問一題",
           "一樣按 Enter。\n\n前面的對話只是脈絡，不算證據。這一題可以從對話推出「它」指的是什麼，" +
           "但引用會重新對著來源查一次。"],
    },
    watchAsk2: {
      en: ["Watch the second answer land",
           "A separate run, with a trace of its own.\n\nThe conversation told it what \u201cit\u201d " +
           "refers to. The sources decide what it is allowed to claim, and every coordinate is " +
           "checked against them again from scratch."],
      "zh-Hant": ["看第二個回答落地",
           "這是另一次執行，有自己的軌跡。\n\n對話告訴它「它」指的是誰，能主張什麼則是來源說了算，" +
           "每一個座標都重新查過一次。"],
    },
    podcastTab: {
      en: ["Open the Podcast tab",
           "Studio is where the artifacts live. Podcast turns the same sources into a two-host " +
           "episode: it writes the script, then speaks it."],
      "zh-Hant": ["切到 Podcast 頁籤",
           "工作室放的是產出物。Podcast 會把同一批來源變成雙主持人的節目，先寫稿，再合成語音。"],
    },
    podcastLength: {
      en: ["Choose a length",
           "Three lengths, counted in turns rather than described with adjectives. Short is 12 to " +
           "18, Default 30 to 45, Long 60 to 90.\n\nYou pick it here, at generation time, because " +
           "this is when you have an opinion about how long you want to listen."],
      "zh-Hant": ["挑一個長度",
           "三種長度，用輪數算，不用形容詞。短是 12 到 18 輪，預設 30 到 45，長 60 到 90。\n\n" +
           "在要產生的時候才問你，是因為這時候你才會對「想聽多久」有意見。"],
    },
    podcastGenerate: {
      en: ["Generate the episode",
           "Press it. The script is written first, then spoken.\n\nStop is available while the " +
           "script is being written; once speech synthesis starts it runs to the end."],
      "zh-Hant": ["產生節目",
           "按下去。先寫稿，再唸出來。\n\n寫稿的階段可以按停止；進到語音合成之後就會一路做完。"],
    },
    watchPodcast: {
      en: ["Watch it write, then speak",
           "Two halves, and only the first can be stopped.\n\nThe script is a grounded run like " +
           "any other, checked against the sources before it is accepted. Synthesis is a separate " +
           "step that reads the finished script aloud."],
      "zh-Hant": ["看它先寫稿，再唸出來",
           "兩個階段，只有前半段停得下來。\n\n寫稿跟其他執行一樣，要對著來源查證過才算數；後面的" +
           "語音合成是另一件事，把寫好的稿子唸出來。"],
    },
    podcastPlay: {
      en: ["Play it, and watch the transcript",
           "Press play. The transcript works like subtitles: it follows the playhead, highlights " +
           "the line being spoken, and jumps to any line you click.\n\nEach line carries its own " +
           "citations, and ↓ Download gives you the file."],
      "zh-Hant": ["播放，順便看逐字稿",
           "按播放。逐字稿的行為跟字幕一樣：跟著播放頭走、標出正在唸的那一行、點哪一行就跳到哪裡。\n\n" +
           "每一行都有自己的引用，「↓ 下載」可以直接把檔案帶走。"],
    },
    compare: {
      en: ["Compare the two languages",
           "The notebook name at the top left is a picker. Six notebooks: three answered in " +
           "English, three in Traditional Chinese, built from the same sources.\n\nOnly the " +
           "output language differs. The writing follows the reader; every quoted passage stays " +
           "in the words of its source."],
      "zh-Hant": ["比一下兩種語言",
           "左上角那個筆記本名字可以點開換一本。六本：三本用英文回答，三本用繁體中文，來源是同一批。" +
           "\n\n差別只在輸出語言。文字跟著讀者走，引文則留在來源自己的用字。"],
    },
  };


  //: English is the fallback, not a "default translation": `zh-Hant` is a complete table and a
  //: missing key would be a bug, not a language choice.
  PG.text = (key) => {
    const lang = typeof uiLang === "function" ? uiLang() : "en";
    const entry = TEXT[key] || {};
    return entry[lang] || entry.en || ["", ""];
  };

  // --- chrome copy ---------------------------------------------------------------------------
  //: The header, the modals and the footer follow `uiLang()` too. Leaving them English inside a
  //: Chinese interface is the same half-translated page the script was just fixed for; a reader
  //: does not care which of these strings the product owns and which the demo added.
  const UI = {
    en: {
      simulated: "SIMULATED",
      simulatedTip: "No server, no model, no network. Real notebooks and real recorded reasoning, " +
        "replayed in your browser.",
      restart: "↺ Restart", restartTip: "Start the walkthrough again from an empty notebook",
      install: "↓ Install", installTip: "How to install and run it for real",
      github: "★ GitHub", githubTip: "Source, documentation and design notes",
      close: "Close",
      footer: "A playground: the rlm-notebook web UI itself, running against recorded data in " +
        "your browser. Nothing is sent anywhere and nothing is kept.",
      footerLink: "See how it is built",
      turnEpisode: (n) => `${n}-turn episode`,
    },
    "zh-Hant": {
      simulated: "示範模式",
      simulatedTip: "沒有伺服器、沒有模型、沒有連線。真實的筆記本與真實的推理紀錄，在你的瀏覽器裡重播。",
      restart: "↺ 重新開始", restartTip: "從空的筆記本重跑一次導覽",
      install: "↓ 安裝", installTip: "怎麼實際裝起來用",
      github: "★ GitHub", githubTip: "原始碼、文件與設計紀錄",
      close: "關閉",
      footer: "這是示範頁：rlm-notebook 的網頁介面本體，跑在你的瀏覽器裡，讀的是預先錄好的資料。" +
        "沒有任何東西被送出，也沒有留下任何東西。",
      footerLink: "看它是怎麼做的",
      turnEpisode: (n) => `${n} 輪的節目`,
    },
  };

  PG.ui = (key, ...args) => {
    const lang = typeof uiLang === "function" ? uiLang() : "en";
    const v = (UI[lang] || UI.en)[key] ?? UI.en[key] ?? "";
    return typeof v === "function" ? v(...args) : v;
  };

  PG.SCRIPT = [
    {
      id: "sources",
      key: "sources",
      fulfil: "sources",
      side: "right", align: "start",
      target: '#add-source-form button[type="submit"]',
      repeat: true,
      done: (p) => p.sources >= p.sourcesTotal,
      progress: (p) => `${p.sources} / ${p.sourcesTotal}`,
    },
    {
      id: "overview",
      key: "overview",
      fulfil: "overview",
      side: "right", align: "start",
      // Built at runtime by `renderChatOverview` (`.chat-starter` wrapping a `.btn`), so the
      // selector has to match what app.js CREATES, not the static markup.
      target: "#chat-overview button.btn, #chat-overview .chat-starter button, .chat-starter button, #chat-overview",
      // Hands over when the run STARTS, not when it finishes. If this waited for the result, the
      // dwell step after it would arrive with the run already over and nothing left to watch.
      done: (p) => p.overview || PG.isRunning("overview"),
    },
    // A step of its OWN, held open for exactly as long as the run lasts. Telling someone to watch
    // the reasoning and then advancing the moment the result lands gives them nothing to watch;
    // `done` reads the shim's in-flight count, so this ends when the run ends rather than after a
    // guessed number of seconds. "Do it for me" still skips it.
    { id: "watch", key: "watch", target: ".run-status, .run-log, #chat-overview",
      side: "right", align: "start", dwell: true, kind: "overview",
      done: () => !PG.isRunning("overview") },
    { id: "ask1", key: "ask1", target: "#ask-submit", side: "top", align: "end", fill: (p) => p.questions[0],
      fulfil: "turn1", done: (p) => p.turns >= 1 || PG.isRunning("ask") },
    { id: "watch-ask", key: "watchAsk", target: ".run-status, .run-log, .chat-history",
      side: "top", align: "start", dwell: true, kind: "ask",
      done: () => !PG.isRunning("ask") },
    // NOT `side: "top"`. The pill sits a little way below a SHORT answer, so the chat scroller has
    // nothing to scroll and there is no room above it; driver fell back to overlaying the popover,
    // which is the placement that draws no arrow at all. The pill is at the LEFT of a wide column,
    // so the room is sideways, which is what `overview` and `watch` already use.
    // `|| PG.isRunning("ask")` like `ask1`, not `p.turns >= 2` alone. Waiting for the finished turn
    // left "press Enter" on screen for the whole run, next to a composer that had already sent it.
    { id: "ask2", key: "ask2", target: "#ask-submit", side: "top", align: "end", fill: (p) => p.questions[1],
      fulfil: "turn2", skipIf: (p) => p.turnsTotal < 2,
      done: (p) => p.turns >= 2 || PG.isRunning("ask") },
    // The mirror of `watch-ask`, which the first question has and the second did not: the run was
    // live with nothing pointing at it. Carries `ask2`'s `skipIf`, or on a one-turn notebook it
    // would find no run in flight and complete on its first tick.
    { id: "watch-ask2", key: "watchAsk2", target: ".run-status, .run-log, .chat-history",
      side: "top", align: "start", dwell: true, kind: "ask",
      skipIf: (p) => p.turnsTotal < 2, done: () => !PG.isRunning("ask") },
    // AFTER the second question, and that ordering is load-bearing. This step points at the ⌁ pill,
    // which `app.js` renders only `if (turn.run_id)`. The tour reveals turn 0 first, and the three
    // English notebooks have no run id on turn 0 (their trace was collected), so at the old
    // position there was no pill to ring on the DEFAULT English landing scenario. All six have a
    // traced turn 1.
    { id: "trace", key: "trace", side: "right", align: "start",
      // The ANSWER's pill, not the overview's. `.ticker-affordance` alone matched whichever
      // rendered first, which is the overview's, so the spotlight landed on a block the step is not
      // talking about.
      // `.ticker-affordance` is a DIV, so it is full-column-width and the spotlight cut a wide
      // strip across the answer instead of ringing the pill. The button inside it is the control.
      // `.ticker-affordance` IS THE DISAMBIGUATOR. `regenerateTurnButton` carries the identical
      // `ticker-toggle trace-face` class ("one row, one weight", app.js:2110), and only the trace
      // pill is wrapped in `.ticker-affordance`. Without it `firstMatch` ringed ↻ Regenerate and
      // the copy said to press ⌁, so pressing the ringed control started another run instead of
      // opening the drawer, and the step could never complete.
      target: ".turn:last-of-type .ticker-affordance .ticker-toggle, .turn .ticker-affordance .ticker-toggle",
      // SKIPS WHEN THERE IS NO PILL, and two of the six demo notebooks are that case: their traces
      // aged out under retention (invariant 34), so `build.py` withholds the run id and `app.js`
      // renders the pill only `if (turn.run_id)`. `nb-d22c2a9a` has no traced turn AND no traced
      // overview, so there is no ⌁ anywhere on its page. Without this the step waits on a control
      // that cannot appear, forever. Read from the DOM rather than from progress, because what
      // decides it is whether the revealed turns happen to carry a run id.
      skipIf: () => !document.querySelector(".turn .ticker-affordance .ticker-toggle"),
      done: () => !document.getElementById("traj-drawer").hidden },
    // The drawer is 80vh of fixed-position panel over the whole workspace, so leaving it open does
    // not merely look untidy: the NEXT step points at the composer's send button, which is behind
    // it. A tour that opens something has to close it again before it asks for anything else.
    // Targets `#traj-close` rather than the drawer, because `.driver-active *` kills pointer events
    // on everything but the spotlit element and its descendants — spotlighting the whole drawer
    // would work too, but the reader is being asked to press ONE control.
    // Skips on the same condition: there is nothing to close if the step that opens it was skipped.
    { id: "trace-close", key: "traceClose", target: "#traj-close, .traj-head", side: "bottom",
      align: "end", skipIf: () => !document.querySelector(".turn .ticker-affordance .ticker-toggle"),
      done: () => document.getElementById("traj-drawer").hidden },
    { id: "podcast-tab", key: "podcastTab", side: "left", align: "start",
      target: '.studio-views [data-view="podcast"], .studio-views button',
      // The BODY, not the button. `#podcast-generate:not([hidden])` matched from the start: the
      // button carries no `hidden` attribute of its own, its Studio view does. So this step reported
      // done before the reader had opened the tab, step 8 (`done: () => true`) fell through too,
      // and step 9 pointed at a button inside a hidden panel.
      done: () => {
        const body = document.querySelector('[data-view-body="podcast"]');
        return !!body && !body.hidden;
      } },
    // Reading a step and moving on IS the action here, so it completes on a click anywhere in the
    // length group — including re-picking the one already active. `done: () => true` made it a
    // subliminal frame nobody could see.
    { id: "podcast-length", key: "podcastLength", target: ".podcast-length", side: "left",
      done: () => !!PG.lengthTouched },
    // Hands over when the run STARTS. `!!p.podcast` alone kept "press this" on screen for the whole
    // of the slowest run in the demo, beside a button that had already been pressed.
    { id: "podcast-generate", key: "podcastGenerate", target: "#podcast-generate", side: "left",
      fulfil: "podcast", kind: "audio",
      done: (p) => !!p.podcast || PG.isRunning("audio") },
    // The podcast's own watch step. Every other run-taking step in the script had one; this is the
    // LONGEST run in the demo and it was the one without. `kind: "audio"` is what Skip needs to end
    // the run it is skipping — the shim registers this run under that name, not under "podcast".
    { id: "watch-podcast", key: "watchPodcast", target: ".run-status, .run-log, #podcast-body",
      side: "left", align: "start", dwell: true, kind: "audio",
      done: () => !PG.isRunning("audio") },
    { id: "podcast-play", key: "podcastPlay", target: "#podcast-body audio", side: "left",
      done: () => {
        const a = document.querySelector("#podcast-body audio");
        return !!a && a.currentTime > 1.5;
      } },
    // The PRODUCT's notebook picker, not a button the playground added. There used to be a second
    // one in the header opening a modal of its own; the dropdown already lists all six with their
    // source and turn counts, and switching is what it is for.
    { id: "compare", key: "compare", target: "#notebook-current", side: "bottom", align: "start",
      done: () => false, last: true },
  ];

  // `PG.INSTALL` is GONE. It was a hand-copy of the README's "Install and run" section, which is
  // the half of this page most certain to drift: a command changes in the README, where the person
  // changing it can see it, and this copy keeps confidently printing the old one. The header button
  // links to that section instead.
})();

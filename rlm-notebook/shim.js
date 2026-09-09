/* rlm-notebook PLAYGROUND — the network shim.
 *
 * `app.js` is the SHIPPED application, copied verbatim and never edited. It reaches the network in
 * exactly three ways, and this file replaces all three before `app.js` is evaluated:
 *
 *   1. `window.fetch`             — every `api()` call (23 call sites, ~18 endpoints)
 *   2. `window.EventSource`       — the live reasoning-trace stream
 *   3. `HTMLMediaElement.src`     — the podcast `<audio>`, which is a browser fetch no shim can see
 *
 * Nothing else touches a server, so nothing else needs faking. That count is the whole reason this
 * approach is maintainable: if it were thirty entry points, forking the UI would be cheaper.
 *
 * SCRIPT ORDER IS THE CONTRACT. `app.js` captures no reference to these globals — it calls them at
 * request time — so replacing them first is sufficient AND necessary. `build.py` injects this file
 * before `i18n.js`/`app.js`; do not reorder them.
 */
(() => {
  "use strict";

  const BASE = new URL(".", document.currentScript ? document.currentScript.src : location.href);
  const asset = (p) => new URL(p, BASE).href;

  // --- fixture load -----------------------------------------------------------------------------
  // Loaded lazily and awaited INSIDE the handlers rather than blocking startup: every intercepted
  // call is already async, and a synchronous XHR to gate boot would stall first paint for a file
  // that only the first request needs.
  let fixturesPromise = null;
  const realFetch = window.fetch.bind(window);
  function fixtures() {
    if (!fixturesPromise) {
      fixturesPromise = realFetch(asset("fixtures.json")).then((r) => r.json());
    }
    return fixturesPromise;
  }

  // --- mutable demo state -----------------------------------------------------------------------
  // A DEEP COPY per scenario, so Reset is `delete state[id]` and the next read rebuilds from the
  // pristine fixture. Mutating the fixture in place would make Reset a no-op after the first edit,
  // which is exactly the bug a "reset" button exists to not have.
  const live = new Map();
  const PG = (window.rlmPlayground = window.rlmPlayground || {});

  //: THE STAGE. A demo that opens with everything already in it demonstrates nothing — the reader
  //: sees a finished screenshot and learns neither what the product does nor that they did it. So
  //: the notebook is revealed a piece at a time, and each piece is revealed by the reader pressing
  //: the product's OWN control. `view()` is the filter; the routes below advance it.
  //:
  //: The underlying fixture is never mutated by staging — `stage` only says how much of it is
  //: visible yet — so Reset is a counter reset, not a reload.
  const stages = new Map();
  const blankStage = () => ({ sources: 0, overview: false, turns: 0, podcast: null });
  //: `view` clamps with `slice(0, n)`, so Infinity means "everything this notebook actually has".
  const fullStage = () => ({ sources: Infinity, overview: true, turns: Infinity, podcast: "default" });

  //: The tour builds ONE notebook up from nothing, and that notebook alone starts empty. Every other
  //: one opens complete, because the reader reaching them has finished the tour and is browsing:
  //: handing them a blank workspace would read as the demo being broken, not as a lesson.
  //:
  //: This is what lets the playground use the PRODUCT's own notebook picker instead of a second one
  //: bolted onto the header. That picker calls `openNotebook(id)` in place, with no reload to
  //: re-stage anything, so an unstaged notebook has to be worth looking at on arrival.
  const tourOwns = new Set();
  PG.beginTour = (id) => {
    tourOwns.add(id);
    stages.set(id, blankStage());
  };

  function stageOf(id) {
    if (!stages.has(id)) stages.set(id, tourOwns.has(id) ? blankStage() : fullStage());
    return stages.get(id);
  }

  //: The reveal is capped by what the notebook really has. Pressing "add source" a fourth time on a
  //: three-source notebook must not invent a fourth.
  function view(nb, st) {
    const podcast = st.podcast && nb.podcast ? { ...nb.podcast, stale: false } : null;
    return {
      ...nb,
      sources: nb.sources.slice(0, st.sources),
      turns: nb.turns.slice(0, st.turns),
      overview: st.overview ? nb.overview : null,
      podcast,
    };
  }

  async function full(id) {
    if (!live.has(id)) {
      const f = await fixtures();
      if (!f.notebooks[id]) return null;
      live.set(id, structuredClone(f.notebooks[id]));
    }
    return live.get(id);
  }

  //: One place both languages are reachable from. `uiLang` is `i18n.js`'s global and this file
  //: loads before it, so the guard is not optional.
  const uiText = (en, zh) => ((typeof uiLang === "function" ? uiLang() : "en") === "zh-Hant" ? zh : en);

  async function notebook(id) {
    const nb = await full(id);
    return nb && view(nb, stageOf(id));
  }

  //: A MUTATING handler gets the live notebook and answers with the view. `notebook()` returns what
  //: `view` built — a NEW object with `sources`/`turns` sliced — so a handler that took it and
  //: spliced an array changed a copy that was thrown away with the response. Every mutation except
  //: notes was lost on the next read (notes survived only because `view` spreads them by reference,
  //: which is what hid the whole class): a deleted source came back, a rename showed in the header
  //: and then reverted the moment `refreshNotebookList` re-fetched, a cleared conversation
  //: reappeared. `openNotebook` runs on the tour's own Next button, so the reader saw it happen.
  //:
  //: Mutate LIVE, respond with the VIEW. The stage's counts stay as they are: they are a reveal
  //: ceiling, and `slice(0, n)` past a shortened array is still the whole array.
  async function mutate(id, apply) {
    const nb = await full(id);
    // A 404, never `null`. Returning nothing made the route resolve to no Response at all, which
    // is not a status a caller can read — the smoke suite hit it as `Cannot read properties of
    // null (reading 'status')` while probing route shapes with a placeholder id.
    if (!nb) return notFound("no such notebook in this playground");
    const refused = apply(nb);
    return refused || json(view(nb, stageOf(id)));
  }

  //: THE DEMO STARTS FROM SCRATCH ON EVERY LOAD. Resetting the shim's stage is not enough: the
  //: workspace persists its own preferences, and this is a teaching page, so anything a reader
  //: changed last visit must not decide what they see this visit. It went wrong exactly there.
  //: `rlmnb-studio-view` survives a reload, so once anyone had reached the Podcast tab the tour's
  //: "open the Podcast tab" step was already satisfied before it was ever shown, and it vanished.
  //: `rlmnb-podcast-length` is the same shape one step later, and a collapsed or hand-narrowed
  //: Studio column would strand both.
  //:
  //: `rlmnb-ui-lang` and `rlmnb-theme` are deliberately NOT here. Those are how the reader is
  //: LOOKING at the page rather than anything the tour teaches, and clearing them would undo the
  //: reader's own toggle every time they refreshed.
  const WORKSPACE_KEYS = [
    "rlmnb-studio-view",
    "rlmnb-studio-collapsed",
    "rlmnb-studio-width",
    "rlmnb-podcast-length",
  ];
  //: At MODULE SCOPE, and that is what makes it work without touching the DOM: `index.html` loads
  //: `shim.js` before `app.js`, so the keys are already gone by the time the workspace reads them
  //: and it initialises from its own defaults. Restart calls `location.reload()`, so it comes back
  //: through here too.
  const resetWorkspacePrefs = () => {
    for (const key of WORKSPACE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* a browser refusing storage is not a reason to fail the load */
      }
    }
  };
  resetWorkspacePrefs();

  PG.reset = async (id) => {
    if (id) {
      live.delete(id);
      stages.delete(id);
    } else {
      live.clear();
      stages.clear();
    }
    resetWorkspacePrefs();
    // A reset re-runs the tour, so whichever notebook it starts on has to go back to empty. The set
    // is kept: `openInitial` re-announces its pick, and a notebook the tour once owned should not
    // silently become a browse-it-whole one on the next pass.
    for (const owned of tourOwns) stages.set(owned, blankStage());
  };
  PG.scenarios = async () => (await fixtures()).scenarios;

  //: Skipping a step must FULFIL it, not step over it. The stage is what every later step reads, so
  //: a skip that only advanced the script left the notebook empty and stranded everything
  //: downstream: with no sources, `renderChatOverview` returns early, `#chat-overview` stays hidden,
  //: and step 2 hunts for a button that was never built. The reader was told to press something
  //: that did not exist because of a button they had pressed one step earlier.
  PG.fulfil = async (id, what) => {
    const nb = await full(id);
    const st = stageOf(id);
    if (what === "sources") st.sources = nb.sources.length;
    else if (what === "overview") st.overview = true;
    else if (what === "turn1") st.turns = Math.max(st.turns, 1);
    else if (what === "turn2") st.turns = Math.max(st.turns, Math.min(2, nb.turns.length));
    else if (what === "podcast") st.podcast = st.podcast || "default";
  };

  //: What the director reads to know whether a step is finished, and how much is left to reveal.
  PG.progress = async (id) => {
    const nb = await full(id);
    const st = stageOf(id);
    if (!nb) return null;
    return {
      sources: st.sources,
      sourcesTotal: nb.sources.length,
      overview: st.overview,
      hasOverview: !!nb.overview,
      turns: st.turns,
      turnsTotal: nb.turns.length,
      podcast: st.podcast,
      hasPodcast: !!nb.podcast,
      questions: nb.turns.map((x) => x.question),
    };
  };

  // --- helpers ----------------------------------------------------------------------------------
  const json = (body, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const notFound = (detail) => json({ detail }, 404);

  //: A source added in the playground has no ingestion behind it, so it is labelled as simulated
  //: rather than dressed up as real. Pretending would be the one dishonest thing here: the reader
  //: would conclude their own URL had been fetched and read, and nothing about the answer would
  //: reflect it.
  function simulatedSource(nb, origin, kind) {
    const n = nb.sources.reduce((m, s) => Math.max(m, parseInt(s.id.slice(1), 10) || 0), 0) + 1;
    return {
      id: `s${n}`,
      kind,
      origin,
      flags: [],
      preview: {
        title: origin,
        description:
          "Added on this demo page, so there is nothing behind it to read. Answers below still " +
          "come from the notebook's own sources.",
      },
    };
  }

  //: Settings are per-browser here. The real `PUT /settings` is a GLOBAL, unauthenticated mutation
  //: (invariant 41); a playground that persisted it across visitors would be that hazard shipped on
  //: purpose, so it lives in memory and dies with the tab.
  let settings = {
    output_language: { value: null, source: "default" },
    tts_voice_host_a: { value: null, source: "default" },
    tts_voice_host_b: { value: null, source: "default" },
    error: null,
  };

  // --- the router -------------------------------------------------------------------------------
  const ROUTES = [];
  const route = (method, pattern, handler) =>
    ROUTES.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const NB = "/notebooks/([^/]+)";

  route("GET", "/notebooks", async () => {
    const f = await fixtures();
    const items = [];
    for (const s of f.scenarios) {
      const nb = await notebook(s.id);
      // Field names are `NotebookSummary`'s, not invented ones: the picker row reads
      // `source_count`/`turn_count`/`updated_at`, and a near-miss here renders "undefined sources"
      // rather than failing — which is why the smoke test asserts the shape and not just the 200.
      items.push({
        id: nb.id,
        title: nb.title,
        derived_title: nb.derived_title,
        source_count: nb.sources.length,
        turn_count: nb.turns.length,
        updated_at: Date.now() / 1000 - f.scenarios.indexOf(s) * 3600,
      });
    }
    return json({ notebooks: items, unreadable: [] });
  });

  route("GET", NB, async (m) => {
    const nb = await notebook(decodeURIComponent(m[1]));
    return nb ? json(nb) : notFound(`notebook ${m[1]} not found`);
  });

  route("GET", `${NB}/sources/([^/]+)`, async (m) => {
    const id = decodeURIComponent(m[1]);
    const f = await fixtures();
    const src = (f.sources[id] || {})[decodeURIComponent(m[2])];
    return src ? json(src) : notFound("source not found");
  });

  //: Pressing Add reveals THE NEXT REAL SOURCE, whatever was typed in the box. The reader gets the
  //: motion of adding a source — the row appearing, the corpus growing — without the playground
  //: pretending it fetched and parsed a URL it never touched. Ingestion is host-side and needs a
  //: network, a parser and an OCR stack (invariant 3); none of that exists in a browser tab.
  //:
  //: Once the real sources run out, a further press falls back to a source labelled as simulated,
  //: so the control never appears broken.
  async function addSource(id) {
    const nb = await full(id);
    // AN ID THIS PAGE HAS NEVER HEARD OF, which the product's own "＋ New notebook" mints in two
    // clicks (`app.js` generates `nb-<uuid8>` and the workspace opens empty). `full` returns null
    // for it and every handler here dereferenced that, so adding a source answered
    // `500 playground shim error: Cannot read properties of null` and `app.js` put it in an alert.
    // A refusal that says why is the honest answer: this page replays recorded notebooks and has
    // nothing to ingest with.
    if (!nb) {
      return json({
        detail: uiText(
          "This is a playground: it replays six recorded notebooks and has no ingestion behind it, "
          + "so a new notebook has nothing to add. Pick one from the notebook menu, or install "
          + "rlm-notebook to use your own sources.",
          "這是展示頁：它重播六本錄好的筆記本，背後沒有真的擷取功能，所以新的筆記本沒有東西可以加。"
          + "從上方的筆記本選單挑一本，或是裝起 rlm-notebook 用你自己的來源。",
        ),
      }, 422);
    }
    const st = stageOf(id);
    if (st.sources < nb.sources.length) st.sources += 1;
    else nb.sources.push(simulatedSource(nb, "added-in-the-playground", "text"));
    return json(view(nb, st));
  }

  route("POST", `${NB}/sources`, async (m) => addSource(decodeURIComponent(m[1])));
  route("POST", `${NB}/sources/upload`, async (m) => addSource(decodeURIComponent(m[1])));

  route("DELETE", `${NB}/sources/([^/]+)`, async (m) => mutate(decodeURIComponent(m[1]), (nb) => {
    const sid = decodeURIComponent(m[2]);
    const i = nb.sources.findIndex((s) => s.id === sid);
    if (i < 0) return notFound("source not found");
    nb.sources.splice(i, 1);
    // Survivors are never renumbered (invariant 50) and the artifacts go stale by set-equality
    // (invariant 38) — the playground shows both, because "why did my overview grey out" is one of
    // the things a reader most needs to understand before installing.
    const ids = new Set(nb.sources.map((s) => s.id));
    for (const art of [nb.overview, nb.podcast]) {
      if (art) art.stale = art.stale || !(art.source_ids || []).every((x) => ids.has(x));
    }
    if (nb.overview) nb.overview.stale = true;
    if (nb.podcast) nb.podcast.stale = true;
  }));

  route("POST", `${NB}/notes`, async (m, req) => {
    const { text } = await req.json();
    return mutate(decodeURIComponent(m[1]), (nb) => {
    // `n{max live numeric suffix + 1}`, never `n{length + 1}` — invariant 32: with length-based
    // ids, deleting a non-last note lets TWO live notes share one, and `delete`/`promote` both act
    // BY id, so either one would silently act on both.
    const max = nb.notes.reduce((mx, n) => Math.max(mx, parseInt(String(n.id).slice(1), 10) || 0), 0);
    nb.notes.push({ id: `n${max + 1}`, text });
    });
  });

  route("DELETE", `${NB}/notes/([^/]+)`, async (m) => mutate(decodeURIComponent(m[1]), (nb) => {
    const i = nb.notes.findIndex((n) => String(n.id) === decodeURIComponent(m[2]));
    if (i < 0) return notFound("note not found");
    nb.notes.splice(i, 1);
  }));

  route("POST", `${NB}/notes/([^/]+)/promote`, async (m) => mutate(decodeURIComponent(m[1]), (nb) => {
    const i = nb.notes.findIndex((n) => String(n.id) === decodeURIComponent(m[2]));
    if (i < 0) return notFound("note not found");
    const [note] = nb.notes.splice(i, 1);
    nb.sources.push(simulatedSource(nb, `note: ${note.text.slice(0, 48)}`, "text"));
    // A promoted source is REVEALED: the stage's ceiling has to rise with it, or the source the
    // reader just created is sliced straight back off the response.
    stageOf(decodeURIComponent(m[1])).sources = nb.sources.length;
  }));

  route("DELETE", `${NB}/turns`, async (m) => mutate(decodeURIComponent(m[1]), (nb) => {
    nb.turns = [];
  }));

  route("PUT", `${NB}/title`, async (m, req) => {
    const title = (await req.json()).title;
    return mutate(decodeURIComponent(m[1]), (nb) => {
      nb.title = title;
      nb.derived_title = title;
    });
  });

  route("POST", `${NB}/title`, async (m) => json(await notebook(decodeURIComponent(m[1]))));

  route("GET", "/settings", async () => json(settings));
  route("PUT", "/settings", async (m, req) => {
    const body = await req.json();
    for (const k of ["output_language", "tts_voice_host_a", "tts_voice_host_b"]) {
      if (k in body) settings[k] = { value: body[k], source: body[k] ? "file" : "default" };
    }
    return json(settings);
  });
  route("GET", "/settings/choices", async () =>
    // `output_languages`, NOT `languages`. `app.js` declares `choicesKey: "output_languages"`, so
    // the wrong name made the Output language row fall back to a free-text input while the two
    // voice rows rendered as dropdowns — a settings page visibly different from the product's, on
    // the page whose whole claim is that this IS the product. `provider` is required too.
    json({
      output_languages: ["Traditional Chinese", "Simplified Chinese", "English", "Japanese", "Korean"],
      voices: ["zh-TW-YunJheNeural", "zh-TW-HsiaoChenNeural", "en-US-AndrewNeural",
               "en-US-AvaNeural", "ja-JP-KeitaNeural", "ja-JP-NanamiNeural"],
      provider: "edge-tts",
    })
  );

  //: STOP HAS TO STOP. This answered `{cancelled: true}` and never touched `during()`, so the run
  //: kept its full seven seconds: `PG.isRunning` stayed true and held the reader on a dwell step
  //: they had just cancelled, and the handler still recorded the artifact in the stage — the shim
  //: remembering something the reader stopped and `app.js` discarded. The tour's own copy says
  //: "Stop is real", and it is the control invariant 47 exists for.
  //:
  //: The real endpoint answers with the run ID, not a boolean.
  route("POST", `${NB}/runs/([^/]+)/cancel`, async (m) => {
    const runId = decodeURIComponent(m[2]);
    if (PG.finishRun) PG.finishRun(null, { cancelled: true });
    return json({ cancelled: runId });
  });

  route("GET", `${NB}/runs/([^/]+)/trajectory`, async (m) => {
    const f = await fixtures();
    // `f.runs`, not `f.traces`. The fixture key was renamed when the build started precomputing the
    // decomposition, and this route was left reading the old one — so it dereferenced `undefined`
    // and every ⌁ pill answered with a 500 instead of the drawer.
    const run = f.runs[decodeURIComponent(m[2])];
    return run ? json(PG.trajectory(run)) : notFound("no trace for this run");
  });

  // --- the run-taking endpoints -----------------------------------------------------------------
  // These are the ones a real deployment pays a model for. Here they replay what the model ACTUALLY
  // produced for this notebook, after a delay long enough that the run status, the Stop button and
  // the live ticker all behave the way they do in the product — a run that returned instantly would
  // hide the entire "watch it think" surface this page exists to show.
  //: Long enough to WATCH. At 2.6s the ticker replayed ten real trace events in 260ms each, which
  //: is faster than anyone can read, and the guided step advanced before the reader had looked at
  //: the thing it had just told them to look at. Real runs here took 57s to 262s; this is not an
  //: attempt to be realistic, just to be legible.
  const RUN_MS = 7000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  //: In-flight runs, so the guided script can hold a step open for exactly as long as the run lasts
  //: instead of guessing at a duration.
  //: Counted PER KIND. A single global counter meant any run made every "is my run going?" check
  //: true at once: while the overview was generating, the ask step reported itself done and the
  //: script fell through it, so one press of Skip jumped two steps.
  const inFlight = new Map();
  PG.isRunning = (kind) =>
    kind ? (inFlight.get(kind) || 0) > 0 : [...inFlight.values()].some((n) => n > 0);

  //: A run can be FINISHED EARLY. Skipping the step that watches a run has to end the run too,
  //: or the tour moves on while the screen is still showing the previous step: a status strip
  //: counting up, and the result the next step needs nowhere in sight.
  //:
  //: `finishRun` resolves the pending wait instead of cancelling the request, so the response still
  //: arrives and the notebook still reaches the state it would have — the reader skipped the WAIT,
  //: not the outcome.
  //:
  //: CANCELLING IS THE OTHER CASE, and it is the opposite one: the reader wants the outcome NOT to
  //: happen. So the resolver carries WHY the wait ended, `during` returns it, and every handler
  //: that records something into the stage checks before recording. Without it, Stop ended nothing:
  //: the run kept its full seven seconds and the shim stored an artifact `app.js` had discarded.
  const pending = new Map();
  PG.finishRun = (kind, outcome) => {
    for (const [k, done] of [...pending]) {
      if (!kind || k === kind) done(outcome || {});
    }
  };

  const during = async (kind, ms) => {
    inFlight.set(kind, (inFlight.get(kind) || 0) + 1);
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({}), ms);
        pending.set(kind, (outcome) => {
          clearTimeout(timer);
          pending.delete(kind);
          resolve(outcome || {});
        });
      });
    } finally {
      pending.delete(kind);
      inFlight.set(kind, (inFlight.get(kind) || 0) - 1);
    }
  };

  route("POST", `${NB}/ask`, async (m, req) => {
    const id = decodeURIComponent(m[1]);
    const nb = await full(id);
    const st = stageOf(id);
    const body = await req.json();
    PG.announce(body.run_id, id, "ask");
    if ((await during("ask", RUN_MS)).cancelled) return json(view(nb, st));
    // The reader is guided to send the question this notebook really asked, so the turn revealed is
    // the NEXT recorded one. A question typed freehand still lands on it — with the recorded
    // question kept, because the recorded ANSWER is the one thing here that cannot be improvised.
    const idx = body.regenerate && st.turns > 0 ? st.turns - 1 : st.turns;
    const pick = nb.turns[idx] || nb.turns[nb.turns.length - 1];
    if (!pick) return json({ detail: "no recorded answer" }, 422);
    if (!body.regenerate) st.turns = Math.min(st.turns + 1, nb.turns.length);
    return json({
      // `text`, matching `AskResponse`. `app.js` happens to `void` this reply and rebuild from the
      // notebook, so the wrong name was inert — and would stop being inert the first time anyone
      // read it, which is exactly the shape of the `/audio` bug that reached a reader.
      text: pick.answer,
      citations: pick.citations,
      follow_ups: pick.follow_ups,
      run_id: pick.run_id || body.run_id,
    });
  });

  route("POST", `${NB}/overview`, async (m, req) => {
    const id = decodeURIComponent(m[1]);
    const nb = await full(id);
    const st = stageOf(id);
    const body = await req.json().catch(() => ({}));
    PG.announce(body.run_id, id, "overview");
    if ((await during("overview", RUN_MS)).cancelled) return json(view(nb, st));
    st.overview = true;
    return json(view(nb, st));
  });

  route("POST", `${NB}/guide/([a-z]+)`, async (m, req) => {
    const nb = await notebook(decodeURIComponent(m[1]));
    const body = await req.json().catch(() => ({}));
    PG.announce(body.run_id, nb.id, `guide:${m[2]}`);
    if ((await during("guide", RUN_MS)).cancelled) return json({ cancelled: true });
    return json(PG.guide(nb, m[2]));
  });

  route("POST", `${NB}/audio`, async (m, req) => {
    const id = decodeURIComponent(m[1]);
    const nb = await full(id);
    const st = stageOf(id);
    const body = await req.json().catch(() => ({}));
    PG.announce(body.run_id, id, "audio");
    // Synthesis is the slow half in the real product (invariant 43: chatterbox measured 33x
    // edge-tts), so generating an episode waits noticeably longer than a chat turn. The wait is
    // part of what the demo is honest about.
    if ((await during("audio", RUN_MS * 1.6)).cancelled) return json(view(nb, st));
    // This notebook holds ONE recorded episode at ONE tier (invariant 42). Whichever length button
    // was pressed, the episode returned is the recorded one — and the page names its real tier
    // rather than implying the button re-generated it.
    st.podcast = body.length || "default";
    const out = view(nb, st);
    // FLAT, matching `api.AudioResponse` — NOT the nested `{podcast}` of `NotebookResponse`. This
    // endpoint is the one place the two shapes differ, and the shim had the wrong one: `app.js`
    // reads `data.utterances.length` straight off the reply, so pressing Generate died with
    // "Cannot read properties of undefined" and the demo's headline artifact never appeared.
    const ep = out.podcast || {};
    return json({
      utterances: ep.utterances || [],
      offsets: ep.offsets || [],
      audio_suffix: ep.audio_suffix || ".mp3",
      // The real endpoint can return the episode inline; here the `<audio>` src is intercepted
      // separately, so there is nothing to inline and the field is honestly null.
      audio_base64: null,
    });
  });

  // --- 1. fetch ---------------------------------------------------------------------------------
  window.fetch = async function (input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, location.href);
    // Anything that is not one of OUR API paths is a real asset request (fixtures, audio) and goes
    // to the network untouched.
    if (!url.pathname.startsWith("/notebooks") && !url.pathname.startsWith("/settings")) {
      return realFetch(input, init);
    }
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const match = url.pathname.match(r.re);
      if (match) {
        try {
          return await r.handler(match, req, url);
        } catch (err) {
          return json({ detail: `playground shim error: ${err && err.message}` }, 500);
        }
      }
    }
    return notFound(`no playground route for ${req.method} ${url.pathname}`);
  };

  // --- 2. EventSource ---------------------------------------------------------------------------
  // Replays the REAL trace recorded for this notebook, paced so the ticker reads like a live run.
  // A run id with no recorded trace still streams — a short synthesised sequence — because a
  // missing trace must degrade one affordance and never the page (invariant 29).
  const announced = new Map();
  PG.announce = (runId, nbId, kind) => runId && announced.set(runId, { nbId, kind });

  class PlaygroundEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 1;
      this._closed = false;
      this.onmessage = null;
      this.onerror = null;
      this._start();
    }
    close() {
      this._closed = true;
      this.readyState = 2;
    }
    _emit(obj) {
      if (this._closed) return;
      const ev = new MessageEvent("message", { data: JSON.stringify(obj) });
      if (this.onmessage) this.onmessage(ev);
      this.dispatchEvent(ev);
    }
    async _start() {
      const m = this.url.match(/\/notebooks\/([^/]+)\/runs\/([^/]+)\/stream/);
      const runId = m ? decodeURIComponent(m[2]) : "";
      const f = await fixtures();
      const meta = announced.get(runId);
      const events = PG.pickTrace(f, meta, runId);
      // Spread across the same window the POST takes, so the ticker finishes with the request
      // rather than long before or after it.
      const gap = Math.max(90, Math.floor(RUN_MS / Math.max(events.length, 1)));
      for (const raw of events) {
        if (this._closed) return;
        // The stream belongs to a run; when that run is finished early the remaining events are
        // history nobody is waiting for. Without this the ticker kept spooling into the next step.
        if (meta && !PG.isRunning(meta.kind === "ask" ? "ask" : meta.kind)) break;
        await sleep(gap);
        this._emit(PG.tickerEvent(raw));
      }
      if (!this._closed) this._emit({ kind: "done", primary: "Finished", detail: "", meta: null });
    }
  }
  window.EventSource = PlaygroundEventSource;

  // --- 3. <audio> -------------------------------------------------------------------------------
  // `player.src = "/notebooks/…/audio/file"` is a browser-issued request, invisible to `fetch`. The
  // property setter is the only seam, and rewriting there keeps `app.js` untouched.
  //: THE DOWNLOAD LINK IS A FOURTH INTERCEPTION POINT. `app.js` sets `download.href = audioSrc`,
  //: an ANCHOR, which the media-element hook below never sees — so `↓ Download` resolved
  //: `/notebooks/{id}/audio/file` against the site root and 404'd, while the tour's own copy says
  //: it gives you the file. A capture-phase listener rewrites the href on the way to the click,
  //: which is late enough that `renderPodcast` has already set it and early enough that the
  //: navigation uses the new value.
  document.addEventListener("click", (event) => {
    const a = event.target && event.target.closest && event.target.closest("a[download][href]");
    if (!a) return;
    const m = a.getAttribute("href").match(/\/notebooks\/([^/]+)\/audio\/file/);
    if (m) a.href = asset(`audio/${decodeURIComponent(m[1])}.mp3`);
  }, true);

  const media = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    configurable: true,
    enumerable: media.enumerable,
    get() {
      return media.get.call(this);
    },
    set(value) {
      const s = String(value);
      const m = s.match(/\/notebooks\/([^/]+)\/audio\/file/);
      media.set.call(this, m ? asset(`audio/${decodeURIComponent(m[1])}.mp3`) : value);
    },
  });
})();

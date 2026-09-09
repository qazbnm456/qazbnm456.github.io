// rlm-notebook web UI — zero-build vanilla JS, no framework, no build step (see DESIGN.md).
//
// State: a small hand-rolled evented store, not a state-management library. Event vocabulary is
// PINNED (blueprint §3.1) so later phases don't invent an incompatible convention:
//   notebook:switched  { notebookId }
//   sources:changed    { sources }
//   chat:turnAdded     { turn }
//   chat:pending       { pending }
//   notes:changed      { notes }
//   notebook:titled    { title, notebookId }
// Each pane subscribes only to what it renders from; no pane writes another pane's state directly.

function createStore() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    emit(event, payload) {
      (listeners.get(event) || new Set()).forEach((handler) => handler(payload));
    },
  };
}

const store = createStore();

const state = {
  notebookId: null,
  // The server-side `notebook.slug(id)`, which is what `_derive_run_id` actually prefixes a run id
  // with. Building run ids from the raw id left every trace link dead for `"my notebook"` or any
  // non-Latin id (invariant 10) — found by an independent audit.
  notebookSlug: null,
  title: null,
  overview: null,
  podcast: null,
  //: The Studio guide artifacts, keyed by kind, as `{result, runId}`. On `state` rather than in a
  //: closure inside `initStudioPanel` because the References view has to collect citations from
  //: them: an independent review found every citation in a summary/FAQ/timeline/insight — and in
  //: the podcast transcript — was clickable and led to a References list that structurally could
  //: not contain it. It only LOOKED like it worked when the same `source_id|locator` happened to
  //: be cited in chat too, which for text/web sources (all locator `"whole"`) is most of the time.
  guides: {},
  sources: [],
  turns: [],
  notes: [],
};

// --- Theme ------------------------------------------------------------------------------------

function initTheme() {
  const toggle = document.getElementById("theme-toggle");
  const stored = localStorage.getItem("rlmnb-theme");
  if (stored) {
    document.documentElement.setAttribute("data-theme", stored);
  }
  updateToggleGlyph();

  toggle.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("rlmnb-theme", next);
    updateToggleGlyph();
  });
}

function updateToggleGlyph() {
  const toggle = document.getElementById("theme-toggle");
  const current =
    document.documentElement.getAttribute("data-theme") ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  // U+FE0E forces TEXT presentation. Without it macOS draws these from the colour-emoji font,
  // which ignores `color` entirely (so the hover tint did nothing) and renders at its own
  // scale (so the glyph looked small however large `font-size` was). That is the whole
  // explanation for "the icon is still too small and the hover has no effect".
  // GEOMETRIC glyphs (U+25D0/U+25D1), not `☀`/`☾`. Those live in the Miscellaneous Symbols block
  // and macOS draws them from the colour-emoji font, which ignores `color` outright and sizes them
  // itself — the reason two rounds of "the icon is small and the hover does nothing" were about the
  // font, not the CSS. U+FE0E asks for text presentation, but a glyph that was never emoji in the
  // first place is one less thing depending on the platform honouring it. Same family
  // one sibling studio uses (`◐`).
  toggle.textContent = current === "dark" ? "\u25d1" : "\u25d0";
}

// --- API helpers --------------------------------------------------------------------------------

async function api(path, options) {
  // Every request carries the interface language the reader PICKED. One choke point rather than a
  // field in five request bodies — `_resolve_language` is reached from every run-taking endpoint,
  // and a header covers them all without a schema change each. See `i18n.js`'s header for why this
  // does not merge the two language settings.
  const opts = { ...(options || {}) };
  opts.headers = { ...(opts.headers || {}), "X-RLM-Interface-Language": uiLangName() };
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      // response wasn't JSON — keep statusText
    }
    throw new Error(`${resp.status}: ${detail}`);
  }
  return resp.status === 204 ? null : resp.json();
}

// --- Reasoning-trace ticker (Phase 3) --------------------------------------------------------
//
// `ask`, each Guide-tab fetch, and the podcast generate call all pick their OWN run id
// client-side (never trust a server-generated one — it would never reach us until the request
// was already over) and open a live SSE ticker against it before/alongside firing the actual
// request. Reasoning-trace fusion is deliberately a SECONDARY, opt-in layer: the request's own
// response remains the sole source of the final answer/result (unchanged from Phase 1/2) — the
// ticker only replaces static "Thinking…"/"Generating…" copy with live-updating copy, and adds a
// small "view reasoning" affordance afterward. Losing the ticker (a network hiccup, the SSE
// connection dropping) never blocks or breaks the actual request.

//: Every event a run's stream has produced this page-session, keyed by run id. `openTicker`
//: accumulates into it and RESOLVES with it, which is what the awaiting caller reads — nothing
//: else does any more. It stopped being a cache when the persisted "⌁ N steps" pill moved from
//: expanding inline to opening the Trajectory drawer, which fetches its own decomposition from the
//: server and so needs no client-side log at all.
const tickerLogs = new Map();

//: Kinds that end a stream. Written down once so the ticker, the tests and any later consumer
//: share one answer — adding a terminal kind and missing a call site leaves a stream open forever.
const TERMINAL_KINDS = new Set(["done", "failed", "not_found"]);

function openTicker(notebookId, runId, onEvent) {
  const events = [];
  tickerLogs.set(runId, events);
  return new Promise((resolve) => {
    let source;
    try {
      source = new EventSource(
        `/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}/stream`
      );
    } catch {
      resolve(events);
      return;
    }
    source.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      events.push(event);
      onEvent(event);
      // EVERY terminal kind, not just the happy one. `failed` was added when the trace mapping
      // grew a failure headline, and a check that only knew `done` would have left the stream open
      // forever on exactly the runs a user most wants to see end. Caught by a test asserting the
      // old vocabulary, which is the whole reason to pin an event vocabulary in the first place.
      if (TERMINAL_KINDS.has(event.kind)) {
        source.close();
        resolve(events);
      }
    };
    source.onerror = () => {
      // A dropped connection ends the TICKER, never the request itself — the POST this ticker is
      // attached to keeps running and its own response is still authoritative.
      source.close();
      resolve(events);
    };
  });
}

// A shared "something is running" surface: a pulsing dot, the live action, a ticking elapsed
// counter, and a Stop button. Same shape a sibling project's own live-status strip uses, and it exists
// because of a real report: a generation takes a minute or more, the only feedback was one line of
// text that ended on "finished" and then sat there, so the natural move is to press the button
// again — which strands the first generation behind a staleness guard and looks like nothing
// happened at all.
//
// `runIds` is a LIST because `/overview` fires two runs; cancelling per run id rather than per
// notebook is what makes Stop actually stop everything (see `cancel_run`'s docstring).
// The server's `summary` is an English convenience; `kind` is the stable thing and `detail` is the
// one specific that differs every run. Translating the KIND and keeping the detail verbatim is what
// makes the status line readable in the interface language without inventing a translation for a
// tool name or a model id.
//: The event headlines, in the interface language. The server sends `primary` in English and
//: `detail`/`meta` as the run's own specifics — a headline is a fixed vocabulary worth translating,
//: a piece of the model's reasoning or a tool's name is not.
const TRACE_HEADLINES = {
  Starting: () => t("trace.start", "Starting"),
  Step: () => t("trace.stepBare", "Step"),
  Tool: () => t("trace.tool", "Tool"),
  "Sub-model": () => t("trace.escalation", "Sub-model"),
  Finalising: () => t("trace.final", "Finalising"),
  Result: () => t("trace.result", "Result"),
  Finished: () => t("trace.done", "Finished"),
  Failed: () => t("trace.failed", "Failed"),
};

function traceHeadline(event) {
  const primary = event.primary || "";
  // `Step 3` -> the `Step` headline plus its number, so the count survives translation.
  // Interpolated, not concatenated: a translation that puts the number in the middle ("第 3 步")
  // cannot be produced by gluing a number onto a translated prefix, and the zh-Hant table had
  // duly rendered "第 3" with the counter missing.
  const numbered = primary.match(/^Step (\d+)$/);
  if (numbered) return t("trace.step", `Step ${numbered[1]}`, { n: numbered[1] });
  const known = TRACE_HEADLINES[primary];
  return known ? known() : primary;
}

// One line, the shape `cve-reverser`/`diff-sentry`'s feeds use: a translated headline, the run's own
// specific, and a compact fact. It used to be a fixed sentence per event type with the payload
// thrown away, which is why ours said so much less than theirs.
function traceLabel(event) {
  if (!event) return "";
  if (event.kind === "not_found") return t("trace.notFound", "No live progress for this run");
  // A kind with no headline at all (an event type this build has no name for): keep whatever is on
  // screen rather than overwriting a meaningful line with an internal event name — which is how
  // `run_start` once reached a user's screen as the literal string `run_start`.
  if (event.kind === "other" && !event.primary) return "";
  const parts = [traceHeadline(event)];
  if (event.detail) parts.push(event.detail);
  return parts.filter(Boolean).join(" \u00b7 ");
}

//: notebook id -> how many runs this TAB currently has in flight against it. Answers "which
//: notebook is generating" in the picker, which is otherwise unknowable once you switch away.
//:
//: Client-side on purpose, and honest about its limit: it counts runs THIS tab started. A run
//: started in another tab (or before a reload) is invisible here. The server's own registries are
//: single-process, in-memory maps (invariant 23) with no endpoint to read them, and adding one is
//: a bigger change than the question needs.
const activeRuns = new Map();

function noteRunStarted(notebookId) {
  activeRuns.set(notebookId, (activeRuns.get(notebookId) || 0) + 1);
  store.emit("runs:changed", { activeRuns });
}

function noteRunFinished(notebookId) {
  const left = (activeRuns.get(notebookId) || 1) - 1;
  if (left > 0) activeRuns.set(notebookId, left);
  else activeRuns.delete(notebookId);
  store.emit("runs:changed", { activeRuns });
}

//: How long a single step may go without news before the wait itself becomes the message. Long
//: enough that an ordinary step never trips it, short enough to answer "is it stuck" before someone
//: has to ask. A model's FIRST response on the Claude-subscription path was measured at four
//: minutes, which is the case this exists for.
const WAITING_AFTER_SECONDS = 20;
//: When "waiting for the model's first response" has itself stopped being news. A user watched that
//: phrase for seven minutes on a subscription model and reported it as looking like a crash.
const LONG_WAIT_AFTER_SECONDS = 90;

function runStatus({ notebookId, runIds, label, onCancel }) {
  noteRunStarted(notebookId);
  const node = document.createElement("div");
  node.className = "run-status";

  const dot = document.createElement("span");
  dot.className = "run-dot";
  node.appendChild(dot);

  const text = document.createElement("span");
  text.className = "run-text";
  text.textContent = label;
  node.appendChild(text);

  const elapsed = document.createElement("span");
  elapsed.className = "run-elapsed";
  elapsed.textContent = "0:00";
  node.appendChild(elapsed);

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn run-stop";
  stop.textContent = t("run.stop", "\u23f9 Stop");
  node.appendChild(stop);

  // The step list still exists — it is what counts the steps for the pill and what tracks which
  // one is current — but it is NEVER shown inside the chat any more. It is built detached and the
  // pill opens the Trajectory drawer instead. Keeping the element (rather than only a counter) is
  // what lets the live "current step" logic below stay exactly as it was.
  const log = document.createElement("div");
  log.className = "run-log";
  log.hidden = true;

  const logToggle = document.createElement("button");
  logToggle.type = "button";
  logToggle.className = "run-log-toggle";
  logToggle.hidden = true;
  // Opens the Trajectory drawer for THIS run rather than unfolding the log in place. The inline
  // version put the planner's own reasoning prose inside the chat bubble, which a user reported as
  // unreadable and space-consuming; the drawer is the same information somewhere a reader opts
  // into, with the tool calls and the real per-turn timing the inline log never had.
  logToggle.addEventListener("click", () => openTrajectory(runIds));

  //: When the previous step landed, so each row can show how long IT took rather than only when it
  //: started. "Where is it stuck" is a question about durations, and a column of absolute stamps
  //: makes the reader subtract.
  let lastStepAt = null;

  function appendLog(event) {
    const headline = traceHeadline(event);
    if (!headline) return;
    const now = Date.now();
    const line = document.createElement("div");
    line.className = `run-log-line kind-${event.kind || "other"}`;

    // Only the newest step is "current": it carries the pulsing node on the rail and shows its
    // detail in full, while everything above it collapses to a clamped line. The shape Cursor and
    // Devin both use for an agent's step list, and the reason is the same — a finished step is a
    // record, the running one is the thing you are watching.
    const previous = log.lastElementChild;
    if (previous) {
      previous.classList.remove("is-current");
      previous.classList.add("is-past");
    }
    line.classList.add("is-current");

    const at = document.createElement("span");
    at.className = "run-log-at";
    at.textContent = formatTimecode((now - started) / 1000);
    line.appendChild(at);

    // VISIBLE, not a tooltip. It was `data-tip` on this element, which lives inside `.run-log`'s
    // own scroller — an independent review measured the tip clipped by that box, the ancestor case
    // `test_no_tooltip_host_clips_its_own_tooltip` states it cannot see. Text needs no hover, works
    // on touch, and can be copied.
    //
    // Measured from `started` for the FIRST row rather than skipped: that gap is the wait for the
    // model's first response, which is the slow one the status line already singles out.
    const gap = (now - (lastStepAt === null ? started : lastStepAt)) / 1000;
    const took = document.createElement("span");
    took.className = "run-log-took";
    // One decimal below ten seconds: most steps in a fast run are sub-second, and `+0s` on every
    // row says nothing at all.
    took.textContent = `+${gap < 10 ? gap.toFixed(1) : Math.round(gap)}s`;
    line.appendChild(took);
    lastStepAt = now;

    const what = document.createElement("span");
    what.className = "run-log-what";
    const primary = document.createElement("b");
    primary.textContent = headline;
    what.appendChild(primary);
    if (event.meta) {
      // Inside `what`, immediately after the label. It used to be a third grid column pinned to the
      // right edge, which on a wide panel left a hand's width of empty box between "啟動" and
      // "GenerateSummary" and read as a broken layout rather than as one log line.
      const meta = document.createElement("span");
      meta.className = "run-log-meta";
      meta.textContent = event.meta;
      what.appendChild(meta);
    }
    if (event.detail) {
      // The model's own words. This is the part that makes the log worth opening — and the part
      // the previous version discarded entirely.
      //
      // Named `reasoningText`, not `detail`: the hidden-toggle tripwire matches variable names
      // across the whole file, and a `detail` here collides with the reference panel's own
      // `detail.hidden = …`. It fails loudly, which is the safe direction — so the fix is the name.
      const reasoningText = document.createElement("span");
      reasoningText.className = "run-log-detail";
      reasoningText.textContent = event.detail;
      what.appendChild(reasoningText);
    }
    line.appendChild(what);
    // A past step opens on click. The detail is clamped rather than dropped, so the log stays
    // readable while a long run accumulates steps and nothing is actually lost.
    if (event.detail) {
      line.classList.add("is-expandable");
      line.addEventListener("click", () => line.classList.toggle("is-expanded"));
    }
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    logToggle.hidden = false;
    logToggle.textContent = t("run.logToggle", `${log.children.length} steps`, {
      n: log.children.length,
    });
  }

  // A typed COUNT per kind of work, not a scrolling log. A sibling project settled on this shape
  // and its own comment says why the framing matters: a raw count climbing forever reads as
  // runaway, while a small set of named counters reads as progress. Three kinds is all our trace
  // has (`_translate_trace_event`), and three is about the ceiling before a status line becomes
  // noise — the thing the user asked to avoid.
  const counts = { tool: 0, escalation: 0 };
  const meter = document.createElement("span");
  meter.className = "run-meter";
  meter.hidden = true;
  node.appendChild(meter);

  // No `thinking` cell: the log toggle right below already says "N steps", and two counters one
  // line apart saying the same number reads as a bug. These are the kinds a step count does NOT
  // cover.
  const COUNT_LABELS = {
    tool: () => t("run.count.tool", "tools"),
    escalation: () => t("run.count.escalation", "sub-model"),
  };

  function renderMeter() {
    meter.textContent = "";
    let any = false;
    Object.entries(counts).forEach(([kind, n]) => {
      if (!n) return;  // a kind that has not happened is not information, it is clutter
      any = true;
      const cell = document.createElement("span");
      cell.className = "run-count";
      const num = document.createElement("b");
      num.textContent = String(n);
      cell.appendChild(num);
      cell.appendChild(document.createTextNode(" " + COUNT_LABELS[kind]()));
      meter.appendChild(cell);
    });
    meter.hidden = !any;
  }

  const started = Date.now();
  node.appendChild(logToggle);
  // NOT appended. `log` stays detached — it is the step bookkeeping, not a panel. Appending it is
  // what put the model's reasoning prose in the chat bubble; the pill above opens the drawer.

  // "Is it stuck?" — a user had to ask, and the honest answer was no: the run finished fine, but
  // the model's FIRST response took four minutes and the trace has nothing to emit until a step
  // completes, so the panel looked identical to a hang for four minutes.
  //
  // The interface has to answer that question itself, and the only fact it has is how long the
  // current step has been running. Below the threshold this says nothing (a step taking six
  // seconds is not news); above it, the wait becomes the message.
  let lastEventAt = started;
  let currentPhrase = label;
  let stepsSeen = 0;
  //: Whether we are still waiting on the model's FIRST reply. Separate from `stepsSeen` because
  //: `setPhase` moves the run to a stage the trace cannot see, where "waiting for the model's first
  //: response" is simply false — and `paint`'s pre-first-step branch REPLACES the phrase rather
  //: than appending to it, so a phase set at second 0 was silently gone by second 20. An
  //: independent review measured it: 26s in, a podcast mid-SYNTHESIS said it was waiting for a
  //: model, and at 2:02 the long-wait tier told the reader Stop was available while Stop was
  //: greyed out — reintroducing, in the same diff, the exact complaint that tier was added for.
  let awaitingFirstReply = true;

  function paint() {
    elapsed.textContent = formatTimecode((Date.now() - started) / 1000);
    const waiting = (Date.now() - lastEventAt) / 1000;
    if (waiting < WAITING_AFTER_SECONDS) {
      text.textContent = currentPhrase;
      node.classList.remove("is-waiting");
      return;
    }
    node.classList.add("is-waiting");
    // BEFORE the first step, "waiting" says nothing a reader did not already know — that stage IS
    // waiting. What they cannot see is WHAT it is waiting for, and that the first model response
    // is the slow one. After a step has landed, the elapsed time is the information: it is the
    // difference between a slow step and a stuck one.
    if (!awaitingFirstReply) {
      text.textContent = `${currentPhrase} \u00b7 ${t("run.waiting", `waiting ${formatTimecode(waiting)}`, { time: formatTimecode(waiting) })}`;
    } else if (waiting < LONG_WAIT_AFTER_SECONDS) {
      text.textContent = t("run.awaitingModel", `waiting for the model's first response \u00b7 ${formatTimecode(waiting)}`, { time: formatTimecode(waiting) });
    } else {
      // A SECOND tier, because the first stopped being informative: a user watched "waiting for the
      // model's first response" for seven minutes and read it as a crash. Nothing more CAN be
      // observed — no trace event exists until the model replies — so the honest move is to say
      // that, and point at Stop, rather than repeat a phrase that has already failed to reassure.
      text.textContent = t(
        "run.awaitingModelLong",
        `still waiting for the model's first response \u00b7 ${formatTimecode(waiting)} \u00b7 nothing is reported until it replies; Stop is available`,
        { time: formatTimecode(waiting) },
      );
    }
  }

  const timer = setInterval(paint, 1000);

  let stopped = false;
  function finish() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    node.classList.add("is-done");
    // Nothing is "current" once the run is over. Without this the last step kept its pulsing rail
    // node and its 12-line detail while the header already said Finished — a status line and a log
    // disagreeing about whether anything is still happening.
    const current = log.querySelector(".run-log-line.is-current");
    if (current) {
      current.classList.remove("is-current");
      current.classList.add("is-past");
    }
    noteRunFinished(notebookId);
  }

  stop.addEventListener("click", async () => {
    stop.disabled = true;
    text.textContent = t("run.stopping", "Stopping\u2026");
    // Cancel every run this action started, not "whatever this notebook is doing" — a notebook-
    // scoped cancel would leave `/overview`'s second run burning a model call to completion.
    await Promise.all(
      runIds.map((runId) =>
        api(
          `/notebooks/${encodeURIComponent(notebookId)}/runs/${encodeURIComponent(runId)}/cancel`,
          { method: "POST" }
        ).catch(() => {})
      )
    );
    finish();
    if (onCancel) onCancel();
  });

  return {
    node,
    //: Rename the phase mid-run, for an action whose later stages the trace cannot see — the
    //: podcast's synthesis half is the only one today. `stoppable: false` DISABLES Stop rather than
    //: hiding it, so the control does not vanish out from under a pointer.
    setPhase(phrase, { stoppable = true } = {}) {
      if (stopped) return;
      currentPhrase = phrase;
      lastEventAt = Date.now();
      // NOT waiting on a first reply any more: this names a stage the trace cannot see.
      awaitingFirstReply = false;
      stop.disabled = !stoppable;
      // Cleared as well as set — otherwise a later stoppable phase re-enables the button while
      // leaving "this stage cannot be interrupted" hanging on it.
      if (stoppable) delete stop.dataset.tip;
      else stop.dataset.tip = t("run.notStoppable", "This stage cannot be interrupted.");
      paint();
    },
    // The whole event, not just its text: the KIND is what the counters are made of, and the
    // summary alone threw it away.
    onEvent(event) {
      if (stopped || !event) return;
      awaitingFirstReply = false;
      if (counts[event.kind] !== undefined) {
        counts[event.kind] += 1;
        renderMeter();
      }
      if (event.kind === "thinking") stepsSeen += 1;
      const phrase = traceLabel(event);
      if (phrase) {
        currentPhrase = phrase;
        lastEventAt = Date.now();
        paint();
        appendLog(event);
      }
    },
    setSummary(summary) {
      if (stopped || !summary) return;
      currentPhrase = summary;
      lastEventAt = Date.now();
      paint();
    },
    finish,
  };
}

function renderTickerAffordance(runId) {
  // The PERSISTED "⌁ N steps" pill under a finished artifact — a chat answer, the overview, a Guide
  // result, the podcast. Distinct from `runStatus`'s LIVE log, which is why moving that one into the
  // Trajectory drawer left this one still expanding the model's reasoning prose inline: a user hard-
  // reloaded, pressed it, and reported the drawer as still missing. It was a different component,
  // and the first diagnosis (a stale cached `app.js`) was wrong.
  //
  // Both open the drawer now. `runId` is all `openTrajectory` needs, and the drawer shows strictly
  // more than this ever did: the code each turn ran, the tool calls, real per-turn timing, search
  // and replay — against the same trace file this used to page through as flat rows.
  const wrapper = document.createElement("div");
  wrapper.className = "ticker-affordance";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ticker-toggle trace-face";
  toggle.textContent = t("err.stepsLoad", "\u2301 steps");
  toggle.dataset.tip = t("traj.open", "Open the run's trajectory");
  toggle.addEventListener("click", () => openTrajectory([runId]));

  wrapper.appendChild(toggle);
  return wrapper;
}

// above. Opened from a citation's list row (always) or a Sources-panel list item (no highlight
// target). Each open aborts any still-in-flight fetch from a PREVIOUS open, so a slower first
// response can never overwrite a faster second one's render — the same class of defect an audit
// once found in the (since-removed) citation-turn panel, guarded against here from the start with
// an AbortController instead, this fetch being worth cancelling at the network level.
let sourceViewerAbort = null;

function closeSourceViewer() {
  document.getElementById("source-viewer-overlay").hidden = true;
  if (sourceViewerAbort) {
    sourceViewerAbort.abort();
    sourceViewerAbort = null;
  }
}

// Highlights AT MOST one quote inside one block's text — deliberately simpler than
// renderAnswerWithCitations's multi-citation overlap handling, since a source block only ever
// needs one highlight per viewer open.
function renderTextWithOptionalHighlight(text, quote) {
  const container = document.createElement("div");
  container.className = "source-block-text";
  if (!quote) {
    container.textContent = text;
    return container;
  }
  const at = text.indexOf(quote);
  if (at === -1) {
    container.textContent = text;
    return container;
  }
  container.appendChild(document.createTextNode(text.slice(0, at)));
  const mark = document.createElement("span");
  mark.className = "citation";
  mark.textContent = text.slice(at, at + quote.length);
  container.appendChild(mark);
  container.appendChild(document.createTextNode(text.slice(at + quote.length)));
  return container;
}

// A source's ORIGIN is a machine string: a URL, or `pasted:<first words>#<hash>` for pasted text.
// Showing it raw as the modal's title produced the thing a user called too rough — a header reading
// `text · pasted:Voyager 1 launched on September 5, 1977. Voyager 2 launched #b2ad719a`.
function sourceDisplayName(source) {
  const origin = source.origin || "";
  if (origin.startsWith("pasted:")) {
    // Everything between the marker and the content hash IS the readable snippet `ingest_pasted_
    // text` deliberately puts there (invariant 30 — a bare hash was found to be a real regression).
    const snippet = origin.slice("pasted:".length).replace(/#[0-9a-f]+$/, "").trim();
    return snippet || t("source.pasted", "Pasted text");
  }
  try {
    const url = new URL(origin);
    // The host is what identifies a page at a glance; the path is detail, and it belongs in the
    // metadata rows below rather than in the title.
    return url.hostname.replace(/^www\./, "");
  } catch {
    return origin;
  }
}

// The metadata block above the text: what this source IS, where it came from, and how big it is.
// Every value goes in through `textContent` — an origin can carry attacker-supplied text from a
// page that was fetched (invariants 6 and 29).
function renderSourceMeta(source) {
  const meta = document.createElement("dl");
  meta.className = "source-meta";

  const rows = [];
  rows.push([t("source.kind", "Kind"), String(source.kind || "").toUpperCase()]);

  const origin = source.origin || "";
  if (/^https?:\/\//.test(origin)) {
    rows.push([t("source.url", "Address"), origin, origin]);
  } else if (origin.startsWith("pasted:")) {
    rows.push([t("source.origin", "Origin"), t("source.pastedIn", "Pasted into this notebook")]);
  } else {
    rows.push([t("source.origin", "Origin"), origin]);
  }

  const chars = (source.blocks || []).reduce((n, b) => n + (b.text ? b.text.length : 0), 0);
  rows.push([
    t("source.size", "Size"),
    t("source.sizeValue", `${source.blocks.length} blocks · ${chars.toLocaleString()} characters`, {
      blocks: source.blocks.length,
      chars: chars.toLocaleString(),
    }),
  ]);

  if (source.flags && source.flags.length) {
    rows.push([t("source.flags", "Flagged"), source.flags.join("; ")]);
  }

  rows.forEach(([term, value, href]) => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    meta.appendChild(dt);
    const dd = document.createElement("dd");
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = value;
      dd.appendChild(link);
    } else {
      dd.textContent = value;
    }
    meta.appendChild(dd);
  });

  return meta;
}

async function showSourceViewer(sourceId, locator, quote) {
  if (sourceViewerAbort) sourceViewerAbort.abort();
  const controller = new AbortController();
  sourceViewerAbort = controller;

  const overlay = document.getElementById("source-viewer-overlay");
  const title = document.getElementById("source-viewer-title");
  const body = document.getElementById("source-viewer-body");
  overlay.hidden = false;
  title.textContent = sourceId;
  body.textContent = t("cite.loading", "Loading…");

  try {
    const source = await api(
      `/notebooks/${encodeURIComponent(state.notebookId)}/sources/${encodeURIComponent(sourceId)}`,
      { signal: controller.signal }
    );
    if (controller.signal.aborted) return;
    title.textContent = sourceDisplayName(source);
    body.innerHTML = "";
    body.appendChild(renderSourceMeta(source));
    let targetSection = null;
    source.blocks.forEach((block) => {
      const section = document.createElement("div");
      section.className = "source-block";
      const label = document.createElement("div");
      label.className = "source-block-locator";
      label.textContent = block.locator;
      section.appendChild(label);
      const matches = locator && block.locator === locator;
      section.appendChild(renderTextWithOptionalHighlight(block.text, matches ? quote : null));
      body.appendChild(section);
      if (matches) targetSection = section;
    });
    if (targetSection) targetSection.scrollIntoView({ block: "center" });
  } catch (err) {
    if (controller.signal.aborted) return;
    body.textContent = t("err.generic", `(error) ${err.message}`, { message: err.message });
  }
}

function initSourceViewer() {
  document.getElementById("source-viewer-close").addEventListener("click", closeSourceViewer);
  document.getElementById("source-viewer-overlay").addEventListener("click", (event) => {
    if (event.target.id === "source-viewer-overlay") closeSourceViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSourceViewer();
  });
  store.on("notebook:switched", closeSourceViewer);
}

// --- Notebook switcher ---------------------------------------------------------------------------

// Notebooks are located by TITLE. The id never appears — it is an internal handle (invariant 37),
// and putting it in front of the name (with `N sources, M turns` beside it) was the whole problem:
// a user could not tell which notebook was which without reading machine metadata.
async function refreshNotebookList() {
  const menu = document.getElementById("notebook-menu");
  let data;
  try {
    data = await api("/notebooks");
  } catch {
    return; // the picker keeps whatever it last showed; opening it will retry
  }
  menu.innerHTML = "";

  data.notebooks.forEach((nb) => {
    menu.appendChild(renderNotebookRow(nb));
  });

  const create = document.createElement("button");
  create.type = "button";
  create.className = "notebook-row notebook-row-new";
  create.textContent = t("app.newNotebookRow", "\uff0b New notebook");
  create.addEventListener("click", () => {
    closeNotebookMenu();
    resetToNewNotebook();
  });
  menu.appendChild(create);

  if (data.unreadable.length) {
    console.warn("unreadable notebook files (flagged, not hidden):", data.unreadable);
  }
}

// Coarse on purpose: the row needs "which of these is recent", not a timestamp. Anything older
// than a week falls back to a real date, because "37 days ago" is not something anyone can place.
function relativeTime(epochSeconds) {
  const seconds = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (seconds < 90) return t("time.justNow", "just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("time.minutes", `${minutes}m ago`, { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", `${hours}h ago`, { n: hours });
  const days = Math.round(hours / 24);
  if (days <= 7) return t("time.days", `${days}d ago`, { n: days });
  return new Date(epochSeconds * 1000).toLocaleDateString(uiLang());
}

function renderNotebookRow(nb) {
  const row = document.createElement("div");
  row.className = "notebook-row";
  if (nb.id === state.notebookId) row.classList.add("is-current");
  if (activeRuns.has(nb.id)) row.classList.add("is-running");

  const open = document.createElement("button");
  open.type = "button";
  open.className = "notebook-row-open";
  open.setAttribute("role", "option");

  if (activeRuns.has(nb.id)) {
    const dot = document.createElement("span");
    dot.className = "run-dot notebook-row-dot";
    dot.dataset.tip = t("app.generating", "Generating something in this notebook");
    open.appendChild(dot);
  }

  const title = document.createElement("span");
  title.className = "notebook-row-title";
  // textContent, never innerHTML: a title is model-authored text derived from source content a
  // prompt-injected source could influence (invariants 6 and 29).
  //
  // `derived_title` is the server's own fallback (from the notebook's origins, no model call), so a
  // notebook someone has only put sources into reads as its subject rather than as "Untitled" —
  // titling is lazy now, so that is the common case, not a rare one.
  title.textContent = nb.title || nb.derived_title || t("app.untitled", "Untitled notebook");
  open.appendChild(title);

  const meta = document.createElement("span");
  meta.className = "notebook-row-meta";
  const parts = [
    t("app.rowMeta", `${nb.source_count} sources · ${nb.turn_count} turns`, {
      sources: nb.source_count,
      turns: nb.turn_count,
    }),
  ];
  // Model-authored titles are NOT unique — a user hit three notebooks with near-identical generated
  // names. With the id no longer shown anywhere, "which did I touch last" is the only thing left to
  // tell them apart, so it goes on the row rather than being something to work out.
  if (nb.updated_at) parts.push(relativeTime(nb.updated_at));
  meta.textContent = parts.join(" \u00b7 ");
  open.appendChild(meta);

  open.addEventListener("click", () => {
    closeNotebookMenu();
    openNotebook(nb.id);
  });
  row.appendChild(open);

  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "notebook-row-rename";
  rename.textContent = "\u270e\ufe0e";
  rename.dataset.tip = t("app.rename", "Rename");
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    startRename(row, nb);
  });
  row.appendChild(rename);

  return row;
}

// Rename in place. A PUT, never the generate endpoint: setting a title is an instant write that
// always succeeds, generating one is a model run that can fail and be superseded.
function startRename(row, nb) {
  row.innerHTML = "";
  const input = document.createElement("input");
  input.className = "notebook-rename-input";
  input.value = nb.title || "";
  input.maxLength = 120;
  row.appendChild(input);

  async function commit() {
    const value = input.value.trim();
    if (!value || value === nb.title) {
      refreshNotebookList();
      return;
    }
    try {
      const updated = await api(`/notebooks/${encodeURIComponent(nb.id)}/title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: value }),
      });
      if (nb.id === state.notebookId) {
        state.title = updated.title;
        store.emit("notebook:titled", { title: state.title, notebookId: nb.id });
      }
    } catch (err) {
      alert(t("err.rename", `Could not rename: ${err.message}`, { message: err.message }));
    }
    refreshNotebookList();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      // Detach the blur handler FIRST. Escape used to call the async refresh with `commit` still
      // listening on a focused input, so any focus change while that request was in flight sent the
      // typed value as a real rename — a cancel that could commit.
      input.removeEventListener("blur", commit);
      refreshNotebookList();
    }
  });
  input.addEventListener("blur", commit);
  input.focus();
  input.select();
}

function closeNotebookMenu() {
  const menu = document.getElementById("notebook-menu");
  const button = document.getElementById("notebook-current");
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

async function openNotebook(notebookId) {
  const trimmed = notebookId.trim();
  if (!trimmed) return;
  let notebook;
  try {
    notebook = await api(`/notebooks/${encodeURIComponent(trimmed)}`);
  } catch {
    // Doesn't exist yet — that's fine, it's created lazily on the first add-source call.
    notebook = { id: trimmed, sources: [], turns: [], notes: [] };
  }
  notebookGeneration += 1;
  state.notebookId = notebook.id;
  state.notebookSlug = notebook.slug || notebook.id;
  state.title = notebook.title || null;
  state.derivedTitle = notebook.derived_title || null;
  state.overview = notebook.overview || null;
  state.podcast = notebook.podcast || null;
  state.sources = notebook.sources;
  state.turns = notebook.turns;
  state.notes = notebook.notes || [];
  store.emit("notebook:switched", { notebookId: notebook.id });
  store.emit("notebook:titled", { title: state.title, notebookId: notebook.id });
  store.emit("sources:changed", { sources: state.sources });
  store.emit("notes:changed", { notes: state.notes });
  state.turns.forEach((turn) => store.emit("chat:turnAdded", { turn, restoring: true }));
  refreshNotebookList();
}

// Everything that mutates a notebook acts on `state.notebookId`, which is set only by
// `openNotebook`. The id box is a REQUEST, not the current state — typing a new name in it and
// pressing "Add source" without pressing Open used to silently write into whatever notebook was
// already open, with the box on screen showing a different name entirely. Reported by a user, who
// hit it as "I can't create a second notebook without reloading the page". Two fixes, together:
// the box is now rewritten from `state` on every switch so it can never disagree with what the app
// is acting on, and the wordmark is a real button that starts an empty one.
// Asks the server to name the notebook from the sources it now holds. Fired after the FIRST
// source lands, never blocking it: ingestion must not wait on (or fail because of) a model call,
// and the source list should render the moment it exists. The generation check drops the result if
// the user has moved to another notebook while it was in flight.
//
// Silent on failure by design — the endpoint already falls back to a deterministic title, and a
// missing title is a cosmetic loss, never worth an alert over a source that was added fine.
// Title on DEMAND. Called by the actions that already run a model, never by adding a source.
// Fire-and-forget on purpose: a title must never delay or fail the thing the user actually asked
// for (the same "never lose what already succeeded" rule invariants 19 and 37 encode).
function ensureTitle() {
  if (!state.notebookId || state.title || !state.sources.length) return;
  void suggestTitle(state.notebookId, notebookGeneration);
}

async function suggestTitle(notebookId, generation) {
  try {
    const notebook = await api(`/notebooks/${encodeURIComponent(notebookId)}/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: crypto.randomUUID() }),
    });
    if (generation !== notebookGeneration) return;
    state.title = notebook.title || null;
    store.emit("notebook:titled", { title: state.title, notebookId });
    refreshNotebookList();
  } catch {
    // keep whatever label is already on screen
  }
}

// --- Settings ---------------------------------------------------------------------------------
//
// PRESENTATION settings only: the language the model writes in, and the voices that read it.
// Trace retention, the upload cap and every model/credential variable are deliberately absent —
// "non-secret" is the wrong filter, since lowering retention DELETES traces holding ingested source
// text and raising the upload cap is a DoS lever. Those are safety bounds, and this API has no
// authentication (invariant 25).
//
// Every row shows where its value comes from. A row pinned by an environment variable is DISABLED
// and says which one: a form that accepts a value and then quietly loses to the env would be a UI
// that lies, which is worse than not having the control.

// A FUNCTION, not a module-level const: the labels go through `t()`, and a const would freeze
// whatever language was active when the script loaded.
function settingRows() {
  const voiceHelp = t(
    "settings.voiceHelp",
    "Leave empty for the provider's default: edge-tts follows the notebook's language, chatterbox uses its shipped host-a / host-b voices."
  );
  return [
    {
      key: "output_language",
      choicesKey: "output_languages",
      label: t("settings.outputLanguage", "Output language"),
      placeholder: t("settings.outputLanguagePlaceholder", "e.g. Traditional Chinese"),
      help: t(
        "settings.outputLanguageHelp",
        "Leave empty to let each notebook resolve its own from your browser, its sources and your questions."
      ),
    },
    // Provider-aware on purpose: with chatterbox `default_voices` returns null for EVERY language,
    // so "empty" means its two shipped clips, not "follow the language" (invariant 43).
    {
      key: "tts_voice_host_a",
      choicesKey: "voices",
      label: t("settings.voiceA", "Podcast voice — host A"),
      placeholder: "e.g. zh-TW-YunJheNeural or host-a",
      help: voiceHelp,
    },
    {
      key: "tts_voice_host_b",
      choicesKey: "voices",
      label: t("settings.voiceB", "Podcast voice — host B"),
      placeholder: "e.g. zh-TW-HsiaoChenNeural or host-b",
      help: voiceHelp,
    },
  ];
}

// The INTERFACE language row. Client-side only — it never reaches the server, because it is not a
// server setting: `RN_OUTPUT_LANGUAGE` decides what the MODEL writes, this decides what the buttons
// say, and a reader who wants a Chinese interface over English papers needs both to be expressible.
function renderUiLanguageRow(body) {
  const wrap = document.createElement("div");
  wrap.className = "setting-row";

  const label = document.createElement("label");
  label.textContent = t("settings.uiLanguage", "Interface language");
  label.htmlFor = "setting-ui-language";
  wrap.appendChild(label);

  const select = document.createElement("select");
  select.id = "setting-ui-language";
  const current = uiLang();
  UI_LANGUAGES.forEach((lang) => {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.label;
    option.selected = lang.code === current;
    select.appendChild(option);
  });
  select.addEventListener("change", () => setUiLang(select.value));
  wrap.appendChild(select);

  const help = document.createElement("div");
  help.className = "setting-help";
  help.textContent = t(
    "settings.uiLanguageHelp",
    "Only affects the text on this screen, never what the model writes."
  );
  wrap.appendChild(help);

  body.appendChild(wrap);
}

//: What the server says each setting may be set to, for the provider actually configured. Empty
//: until `initSettings` fetches it; a row with no choices falls back to a free-text input, so the
//: page still works if this request fails.
let settingsChoices = {};

function renderSettings(state_) {
  const body = document.getElementById("settings-body");
  body.textContent = "";

  if (state_.error) {
    // Surfaced, never swallowed — the reader falls back to defaults on a corrupt file, and the one
    // place that can say so is here (the same "flag, never silently drop" shape the notebook
    // listing already uses for an unparseable file).
    const warn = document.createElement("div");
    warn.className = "setting-source";
    warn.textContent = t(
      "settings.readError",
      `Settings file could not be read (${state_.error}); showing defaults.`,
      { error: state_.error },
    );
    body.appendChild(warn);
  }

  const inputs = new Map();
  renderUiLanguageRow(body);

  settingRows().forEach((row) => {
    const entry = state_[row.key] || { value: null, source: "default", env_var: "" };
    const wrap = document.createElement("div");
    wrap.className = "setting-row";

    const label = document.createElement("label");
    label.textContent = row.label;
    label.htmlFor = `setting-${row.key}`;
    wrap.appendChild(label);

    // A SELECT when the server told us what the valid values are, a text box otherwise. Free text
    // here was a way to typo an env-var value into a setting that then fails at synthesis time —
    // and `config._VOICE_PATTERN` has to refuse a bad one anyway, so offering the choices is both
    // safer and less work for the person. The options come from `GET /settings/choices` rather than
    // a list in this file, because the answer is provider-specific and a second copy would drift.
    const choices = settingsChoices[row.choicesKey] || [];
    const current = entry.source === "default" ? "" : entry.value || "";
    let input;
    if (choices.length) {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = t("settings.useDefault", "Use the default");
      input.appendChild(blank);
      // A value already stored that is NOT in the list (an env var, or a voice from another
      // provider left behind by a switch) still has to be selectable, or opening the page and
      // pressing Save would silently clear it.
      const options = choices.includes(current) || !current ? choices : [current, ...choices];
      options.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === current;
        input.appendChild(option);
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = row.placeholder;
      // textContent/value, never innerHTML — these are server-echoed, caller-writable strings.
      input.value = current;
    }
    input.id = `setting-${row.key}`;
    input.disabled = entry.source === "env";
    wrap.appendChild(input);
    inputs.set(row.key, input);

    const note = document.createElement("div");
    note.className = "setting-source";
    note.textContent =
      entry.source === "env"
        ? t("settings.pinnedBy", `Pinned by ${entry.env_var} — unset it to edit here.`, { env: entry.env_var })
        : row.help;
    wrap.appendChild(note);

    body.appendChild(wrap);
  });

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary";
  save.textContent = t("settings.save", "Save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const payload = {};
    inputs.forEach((input, key) => {
      if (!input.disabled && input.value.trim()) payload[key] = input.value.trim();
    });
    try {
      renderSettings(await api("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }));
    } catch (err) {
      alert(t("settings.saveFailed", `Could not save settings: ${err.message}`, { message: err.message }));
    } finally {
      save.disabled = false;
    }
  });
  body.appendChild(save);
}

function initSettings() {
  const overlay = document.getElementById("settings-overlay");
  const close = () => {
    overlay.hidden = true;
  };

  document.getElementById("settings-open").addEventListener("click", async () => {
    closeSourceViewer(); // one overlay at a time — both carry z-index 1000, so DOM order would decide
    overlay.hidden = false;
    document.getElementById("settings-body").textContent = t("cite.loading", "Loading…");
    try {
      // Fetched alongside the settings themselves, and tolerated failing: a row with no choices
      // falls back to free text, so a page that cannot reach this still works.
      settingsChoices = await api("/settings/choices").catch(() => ({}));
      renderSettings(await api("/settings"));
    } catch (err) {
      document.getElementById("settings-body").textContent = t("err.generic", `(error) ${err.message}`, { message: err.message });
    }
  });
  document.getElementById("settings-close").addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  // The source viewer's Escape handler is its own; without this one Escape would close that and
  // leave this open.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) close();
  });
}

function initNotebookTitle() {
  const el = document.getElementById("notebook-title");
  const button = document.getElementById("notebook-current");
  // The header says whether the notebook you are LOOKING at is busy; the picker says which of the
  // others are. Between them "where is that generation I started" has an answer.
  const runDot = document.getElementById("notebook-run-dot");
  store.on("runs:changed", () => {
    runDot.hidden = !activeRuns.has(state.notebookId);
    const menu = document.getElementById("notebook-menu");
    if (!menu.hidden) refreshNotebookList();
  });
  store.on("notebook:titled", ({ title, notebookId }) => {
    // textContent, never innerHTML — a title is model-authored text derived from source content
    // a prompt-injected source could influence (AGENTS.md invariants 6 and 29).
    // The SAME fallback the picker row uses. They disagreed — the header said "Untitled notebook"
    // while the row showed the server's derived label for the same notebook, which reads as two
    // different notebooks.
    el.textContent = notebookId
      ? title || state.derivedTitle || t("app.untitled", "Untitled notebook")
      : t("app.noNotebook", "No notebook yet");
  });
}

function initNotebookSwitch() {
  const button = document.getElementById("notebook-current");
  const menu = document.getElementById("notebook-menu");

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = menu.hidden;
    menu.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening) refreshNotebookList(); // always fresh: titles change, notebooks appear
  });

  // Click-away and Escape both close it. Without these the panel stays open over the workspace and
  // the only way out is clicking the button again, which reads as broken.
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeNotebookMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) closeNotebookMenu();
  });

  document.getElementById("new-notebook").addEventListener("click", () => {
    closeNotebookMenu();
    resetToNewNotebook();
  });

  refreshNotebookList();
}

// Bumped by EVERY notebook switch (open or reset). Async renders that resolve after a switch must
// check it and drop their result: an independent review found three that didn't, and the new
// one-click wordmark made them trivially reachable — asking a question then switching had the
// answer's follow-up GET build `/notebooks/null`, render `(error) 404 … 'null'` into the fresh
// blank notebook and kill the placeholder; the Guide fetch cached the OLD notebook's artifact
// UNDER the new one (so it reappeared on every later tab switch); and the podcast rendered the old
// episode after clearPlayer() had already run. The existing per-fetch guards (sourceViewerAbort,
// detailArea._requestToken) only protect against a newer request of the SAME kind, not against the
// notebook changing underneath.
let notebookGeneration = 0;

// A blank slate: no notebook selected, every panel cleared. Deliberately does NOT invent an id —
// `state.notebookId` stays null until the user names one (or, once auto-naming lands, until the
// first source is added), and every mutating call already refuses to run without one.
function resetToNewNotebook() {
  notebookGeneration += 1;
  state.notebookId = null;
  state.notebookSlug = null;
  state.title = null;
  state.derivedTitle = null;
  state.overview = null;
  state.podcast = null;
  state.sources = [];
  state.turns = [];
  state.notes = [];
  store.emit("notebook:switched", { notebookId: "" });
  store.emit("notebook:titled", { title: null, notebookId: "" });
  store.emit("sources:changed", { sources: [] });
  store.emit("notes:changed", { notes: [] });
}

// --- Sources panel --------------------------------------------------------------------------------

// Built with createElement/textContent throughout, never innerHTML — `source.origin` is an
// ingested URL/path and, in principle, `source.flags` could one day carry excerpted source text
// (today's injection_scan.py flags don't, but nothing enforces that staying true), so nothing here
// assumes any of it is safe to treat as markup.
// A URL, shortened to what identifies it at a glance once the title is carrying the meaning.
function prettyOrigin(origin) {
  try {
    const url = new URL(origin);
    const path = url.pathname === "/" ? "" : url.pathname;
    return url.hostname.replace(/^www\./, "") + path;
  } catch {
    return origin;
  }
}

function renderSourceItem(source) {
  const li = document.createElement("li");
  li.className = "source-item";
  li.addEventListener("click", () => showSourceViewer(source.id, null, null));

  const kind = document.createElement("div");
  kind.className = "src-kind";
  kind.textContent = source.kind;
  li.appendChild(kind);

  // A PREVIEW CARD when the page told us what it is: its own title, a line of its own description,
  // and its site name. Falls back to the bare origin, which is all a pasted-text or file source
  // has. Every value goes in through `textContent` — a page controls its own `<meta>` tags, so this
  // is attacker-influenceable display text (invariants 6 and 29), and it is never citable: the
  // corpus is built from `blocks` alone. Deliberately NO image: rendering `og:image` would make the
  // reader's browser fetch a URL the page author chose, handing that third party an IP and a
  // request to log, for a thumbnail.
  const preview = source.preview || {};
  if (preview.title) {
    const heading = document.createElement("div");
    heading.className = "src-title";
    heading.textContent = preview.title;
    li.appendChild(heading);
  }

  const origin = document.createElement("div");
  origin.className = "src-origin";
  origin.textContent = preview.title ? prettyOrigin(source.origin) : source.origin;
  li.appendChild(origin);

  if (preview.description) {
    const description = document.createElement("div");
    description.className = "src-description";
    description.textContent = preview.description;
    li.appendChild(description);
  }

  if (source.flags && source.flags.length) {
    const flags = document.createElement("div");
    flags.className = "src-flags";
    // The flag is advisory and gates nothing (invariant 6), so it says what was seen and — via the
    // tooltip — what that means. It used to print the raw regex, which a user reasonably asked
    // about; a warning nobody can act on teaches people to ignore the ones that matter.
    flags.textContent = `\u26a0 ${source.flags.join(", ")}`;
    flags.dataset.tip = t(
      "sources.flagHelp",
      "Found in this source's own text, not in your question. It is not blocked and answers still cite it — this is a heads-up that the source contains something shaped like an instruction to a model."
    );
    li.appendChild(flags);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "src-remove";
  remove.textContent = "\u2715\ufe0e";
  remove.dataset.tip = t("sources.remove", "Remove this source");
  remove.addEventListener("click", async (event) => {
    // The row itself opens the source viewer; without this the remove click would do both.
    event.stopPropagation();
    if (!confirm(t("sources.removeConfirm", `Remove "${source.origin}" from this notebook?`, { origin: source.origin }))) {
      return;
    }
    remove.disabled = true;
    try {
      const notebook = await api(
        `/notebooks/${encodeURIComponent(state.notebookId)}/sources/${encodeURIComponent(source.id)}`,
        { method: "DELETE" }
      );
      state.sources = notebook.sources;
      state.overview = notebook.overview || null;
      state.podcast = notebook.podcast || null;
      // `sources:changed` is what marks the overview and podcast stale and re-offers the Guide
      // tabs — removing a source moves the corpus exactly as adding one does.
      store.emit("sources:changed", { sources: state.sources });
      renderChatOverview();
    } catch (err) {
      remove.disabled = false;
      alert(t("err.removeSource", `Could not remove source: ${err.message}`, { message: err.message }));
    }
  });
  li.appendChild(remove);

  return li;
}

function initSourcesPanel() {
  const tabs = document.querySelectorAll("#source-kind-tabs .tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((tab) => tab.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelectorAll(".tab-body").forEach((kindBody) => {
        kindBody.hidden = kindBody.dataset.kindBody !== tab.dataset.kind;
      });
    });
  });

  const form = document.getElementById("add-source-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // No notebook open? Make one. Demanding a name before the first source made the very first
    // interaction with this product a naming puzzle about a thing that didn't exist yet — the user
    // hit "Open or name a notebook first" and had to invent an id. The id is a handle now, not a
    // label: it is minted here, never shown as the primary name, and `suggestTitle()` below fills
    // in something readable once there is a source to derive it from.
    const isFirstSource = !state.notebookId;
    if (isFirstSource) {
      state.notebookId = `nb-${crypto.randomUUID().slice(0, 8)}`;
      // Already inside the slug whitelist, so it is its own slug until the
      // server confirms one on the next notebook response.
      state.notebookSlug = state.notebookId;
      notebookGeneration += 1;
    }
    const activeKind = document.querySelector("#source-kind-tabs .tab.is-active").dataset.kind;
    const nb = encodeURIComponent(state.notebookId);

    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    // Ingestion is a network fetch, a parse, and possibly OCR — seconds to tens of seconds, with
    // nothing on screen saying so. Disabling one button is not feedback: the panel simply stopped
    // responding, which a user described as feeling stuck. `is-busy` spins the button and dims the
    // form, so the pause reads as work rather than as a hang.
    form.classList.add("is-busy");
    const submitLabel = submitBtn.textContent;
    submitBtn.textContent = t("sources.adding", "Adding\u2026");
    try {
      let notebook;
      if (activeKind === "url") {
        const value = document.getElementById("source-url").value.trim();
        if (!value) return;
        notebook = await api(`/notebooks/${nb}/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sources: [value] }),
        });
        document.getElementById("source-url").value = "";
      } else if (activeKind === "text") {
        const value = document.getElementById("source-text").value.trim();
        if (!value) return;
        notebook = await api(`/notebooks/${nb}/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: [value] }),
        });
        document.getElementById("source-text").value = "";
      } else {
        const fileInput = document.getElementById("source-file");
        const file = fileInput.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);
        // Deliberately no `headers` here — the browser must set its own multipart boundary,
        // which a manually-set Content-Type would break. `api()` never sets one itself (it's a
        // thin `fetch` wrapper; each JSON call site sets its own headers explicitly), so this
        // reuses it exactly as-is rather than needing a second, bespoke fetch call.
        notebook = await api(`/notebooks/${nb}/sources/upload`, {
          method: "POST",
          body: formData,
        });
        fileInput.value = "";
      }
      state.sources = notebook.sources;
      state.title = notebook.title || state.title;
      state.derivedTitle = notebook.derived_title || state.derivedTitle;
      store.emit("sources:changed", { sources: state.sources });
      store.emit("notebook:titled", { title: state.title, notebookId: state.notebookId });
      // Titling used to fire HERE, on the first source. That spent a real model call the moment
      // someone added a source, before they had asked for anything — a user called it too
      // aggressive and they were right. It now runs lazily, from `ensureTitle()`, which the
      // generate actions call: by then the user has already committed to a model run, so the
      // title costs nothing they were not already paying.
    } catch (err) {
      alert(t("err.addSource", `Could not add source: ${err.message}`, { message: err.message }));
    } finally {
      form.classList.remove("is-busy");
      submitBtn.textContent = submitLabel;
      submitBtn.disabled = false;
    }
  });

  store.on("sources:changed", ({ sources }) => {
    const list = document.getElementById("source-list");
    const empty = document.getElementById("sources-empty");
    list.innerHTML = "";
    sources.forEach((source) => list.appendChild(renderSourceItem(source)));
    empty.hidden = sources.length > 0;
  });
}

// --- Chat panel -----------------------------------------------------------------------------------

// The signature interaction (blueprint §2.3): a citation is a highlighter stroke woven into the
// answer text, not a footnote number appended after it.
//
// Built with createElement/textContent/setAttribute throughout, NEVER innerHTML or a raw HTML
// string — `text` is the model's own answer prose and `citation.quote`/`source_id`/`locator` could
// in principle echo attacker-supplied content from a prompt-injected source (AGENTS.md invariant 6:
// a source's content is untrusted, and injection_scan.py's flags are advisory, not a filter). An
// early version of this function built a `<span title="...">` via string interpolation, which a
// `"` character inside `source_id`/`locator` could have broken out of; rewritten before this was
// ever shipped once that was noticed. Same discipline the sibling studios' own `app.js` files
// already enforce for exactly this reason (see rlm_notebook/web/DESIGN.md's Do/Don't).
// `runId` is optional (Phase 1/2 call sites that predate the trace fusion, or a loaded turn saved
// before `ChatTurn.run_id` existed, pass nothing) — when given, each citation span becomes
// clickable and opens the References view at that entry (`focusReference`).
// The "+ Save as note" affordance, as a factory rather than a line inside
// `renderAnswerWithCitations`. NotebookLM's own model is that generated artifacts BECOME notes, and
// this project already has the whole mechanism (Note -> promote_note -> a real citable Source) —
// what it lacked was any way to get an overview into it.
//
// The rule this preserves (blueprint's Notes addendum, audit round 1): the button belongs to a CALL
// SITE that opts in, never to the shared renderer, which Guide tabs and the podcast transcript also
// use. The line is what the user is looking at when they click: things rendered IN the chat thread
// (an answer, the overview) are theirs to curate; a Studio tab's artifact and a podcast transcript
// are not part of that thread.
// A BOOKMARK in the answer's top-right corner, not a labelled button under the text. A full-width
// "+ Save as note" bar under every answer competed with the answer for attention and pushed the
// next turn down; a bookmark is the gesture people already know for "keep this", and it lives where
// they expect to find it. The label survives as the tooltip, so what it does is still one hover
// away — and it still says the part nobody could guess (promotion is what makes a note citable).
function saveAsNoteButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "save-as-note";
  btn.setAttribute("aria-label", t("chat.saveAsNote", "Save as note"));
  btn.textContent = "\u2606";  // U+2606 WHITE STAR — geometric, never emoji (see the theme toggle)
  btn.dataset.tip = t(
    "chat.saveAsNoteHelp",
    "Keep a copy in Notes (Studio, right). A note can later be PROMOTED into a source, which is what makes it citable by a later question."
  );
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await addNote(text);
      btn.classList.add("is-saved");
      btn.textContent = "\u2605";  // filled
      btn.dataset.tip = t("chat.saved", "Saved to Notes");
    } finally {
      setTimeout(() => {
        btn.classList.remove("is-saved");
        btn.textContent = "\u2606";
        btn.disabled = false;
        btn.dataset.tip = t(
          "chat.saveAsNoteHelp",
          "Keep a copy in Notes (Studio, right). A note can later be PROMOTED into a source, which is what makes it citable by a later question."
        );
      }, 1800);
    }
  });
  return btn;
}

// --- Markdown ---------------------------------------------------------------------------------
//
// A deliberately SMALL subset, HAND-WRITTEN, built entirely with `createElement`/`textContent`.
// Answers arrived full of raw `**bold**`, `## headings` and `- lists` because the model writes
// markdown whether or not anyone asked it to, and we were rendering the source text verbatim.
//
// No library, and no `innerHTML` with an interpolated string — the same discipline a sibling
// studio states outright for the same reason: every string here came out of a model that has been
// reading source content an attacker may have written (invariants 6 and 29). The sibling studios
// build markup as HTML strings with an `esc()` helper; one missed `esc()` there is an XSS sink, and
// building nodes removes the failure mode rather than guarding it.
//
// **A link is rendered but NOT navigable**, and that is the one place this diverges from what a
// markdown renderer usually does. Invariant 1 refuses to let the model reach a URL because a
// prompt-injected source could steer it into exfiltrating notebook contents to an address of the
// attacker's choosing; an `<a href>` in an answer is the same hazard with the reader's click as the
// transport, and it would arrive looking exactly like a citation-grounded reference. The URL is
// shown on hover and COPIED on click, so reaching it stays a deliberate act with an address the
// reader has seen. One line to flip if that trade stops being worth it.
//
// Every block callback receives RAW OFFSETS into the original string and appends through `emit`,
// never by creating text nodes itself. That is what keeps the citation strokes exact: `emit` is
// where a highlighted range is split out, so markdown structure and citation ranges compose instead
// of one having to be applied on top of the other's output.

const MD_FENCE = /^\s*(```|~~~)/;
const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const MD_QUOTE = /^\s*>\s?(.*)$/;
const MD_BULLET = /^(\s*)([-*+])\s+(.*)$/;
const MD_ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const MD_TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

//: Inline markers, longest-first so `**` is tried before `*`.
const MD_INLINE = [
  { open: "`", close: "`", tag: "code", className: "md-code" },
  { open: "**", close: "**", tag: "strong" },
  { open: "__", close: "__", tag: "strong" },
  { open: "*", close: "*", tag: "em" },
  { open: "_", close: "_", tag: "em" },
];

function mdLines(text) {
  const out = [];
  let start = 0;
  for (const line of text.split("\n")) {
    out.push({ text: line, start, end: start + line.length });
    start += line.length + 1;
  }
  return out;
}

// `[label](url)` — the label's raw range, plus the url as plain text.
function mdLinkAt(text, at, limit) {
  if (text[at] !== "[") return null;
  const close = text.indexOf("]", at + 1);
  if (close === -1 || close >= limit || text[close + 1] !== "(") return null;
  const end = text.indexOf(")", close + 2);
  if (end === -1 || end >= limit) return null;
  return { labelFrom: at + 1, labelTo: close, url: text.slice(close + 2, end), end: end + 1 };
}

//: A simplified CommonMark "flanking" rule, and it is not pedantry: without it `3 * 4 * 5` becomes
//: `3 <em>4</em> 5` and `my_var and other_var_name` becomes `my<em>var and other</em>var_name`.
//: Multiplication and snake_case identifiers both appear in this project's own subject matter.
//: Backticks are exempt — code spans have no flanking rule in CommonMark either.
const mdIsSpace = (ch) => !ch || /\s/.test(ch);
const mdIsWord = (ch) => !!ch && /[\w\u00c0-\uffff]/.test(ch);

function mdMarkerOpens(text, marker, at) {
  if (marker.tag === "code") return true;
  // An opener must hug its content: `* 4` is a bullet or a multiplication, never emphasis.
  if (mdIsSpace(text[at + marker.open.length])) return false;
  // `_` additionally never opens inside a word, which is what protects `snake_case`.
  if (marker.open.startsWith("_")) return !mdIsWord(text[at - 1]);
  return true;
}

function mdMarkerCloses(text, marker, at) {
  if (marker.tag === "code") return true;
  if (mdIsSpace(text[at - 1])) return false;
  if (marker.close.startsWith("_")) return !mdIsWord(text[at + marker.close.length]);
  return true;
}

//: The first VALID closing marker at or after `from`, or -1.
function mdFindClose(text, marker, from, limit) {
  let at = text.indexOf(marker.close, from);
  while (at !== -1 && at < limit) {
    if (at > from && mdMarkerCloses(text, marker, at)) return at;
    at = text.indexOf(marker.close, at + 1);
  }
  return -1;
}

function renderInline(parent, text, from, to, emit) {
  let cursor = from;
  let plain = from;
  const flush = (upTo) => {
    if (upTo > plain) emit(parent, plain, upTo);
  };

  while (cursor < to) {
    const link = mdLinkAt(text, cursor, to);
    if (link) {
      flush(cursor);
      const span = document.createElement("span");
      span.className = "md-link";
      // Shown, never navigable — see the note at the top of this section.
      span.dataset.tip = link.url;
      // ...and COPYABLE, which the tooltip alone is not: `[data-tip]::after` is CSS generated
      // content, which no browser lets you select, and it only appears on hover — so an
      // independent review found the "see and copy it deliberately" affordance half-missing and
      // unreachable by keyboard or touch entirely. A click copies; `tabindex` makes it reachable.
      // Still not navigable: this writes to the clipboard, it never follows anything.
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      const copyUrl = () => {
        navigator.clipboard?.writeText(link.url).then(
          () => {
            const was = span.dataset.tip;
            span.dataset.tip = t("md.urlCopied", "Link address copied");
            setTimeout(() => {
              span.dataset.tip = was;
            }, 1400);
          },
          () => {},
        );
      };
      span.addEventListener("click", copyUrl);
      span.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          copyUrl();
        }
      });
      renderInline(span, text, link.labelFrom, link.labelTo, emit);
      parent.appendChild(span);
      cursor = plain = link.end;
      continue;
    }

    const marker = MD_INLINE.find(
      (m) =>
        text.startsWith(m.open, cursor)
        && mdMarkerOpens(text, m, cursor)
        && mdFindClose(text, m, cursor + m.open.length, to) !== -1
    );
    if (marker) {
      const innerFrom = cursor + marker.open.length;
      const closeAt = mdFindClose(text, marker, innerFrom, to);
      // A marker whose partner is past this block, or which wraps nothing, is literal text.
      if (closeAt !== -1 && closeAt < to && closeAt > innerFrom) {
        flush(cursor);
        const node = document.createElement(marker.tag);
        if (marker.className) node.className = marker.className;
        if (marker.tag === "code") {
          // Inline code is verbatim by definition: no nested inline parsing, but still emitted
          // through `emit` so a citation stroke can cross it.
          emit(node, innerFrom, closeAt);
        } else {
          renderInline(node, text, innerFrom, closeAt, emit);
        }
        parent.appendChild(node);
        cursor = plain = closeAt + marker.close.length;
        continue;
      }
    }
    cursor += 1;
  }
  flush(to);
}

function mdTableRowCells(line) {
  const trimmed = line.text.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let from = line.start + line.text.indexOf(trimmed);
  for (const piece of trimmed.split("|")) {
    // Each cell's own padding is trimmed OFF THE RANGE rather than off a string, so the offsets
    // still point at the original text and a citation stroke inside a cell lands correctly.
    const lead = piece.length - piece.trimStart().length;
    const tail = piece.length - piece.trimEnd().length;
    cells.push({ from: from + lead, to: from + piece.length - tail });
    from += piece.length + 1;
  }
  return cells;
}

// Renders `text` into `root` as blocks. `emit(parent, from, to)` appends the raw slice, and owns
// citation splitting.
function renderMarkdownInto(root, text, emit) {
  const lines = mdLines(text);
  let i = 0;

  const startsTable = (index) =>
    index + 1 < lines.length
    && lines[index].text.includes("|")
    && MD_TABLE_DIVIDER.test(lines[index + 1].text);

  const isBlockStart = (line, index) =>
    !line.text.trim()
    || MD_FENCE.test(line.text)
    || MD_HEADING.test(line.text)
    || MD_QUOTE.test(line.text)
    || MD_BULLET.test(line.text)
    || MD_ORDERED.test(line.text)
    || MD_RULE.test(line.text)
    // Without this a table written directly under a sentence — no blank line, which is how people
    // actually write one — was swallowed by the paragraph and its pipes shown raw, the exact
    // symptom this renderer exists to remove.
    || startsTable(index);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.text.trim()) {
      i += 1;
      continue;
    }

    if (MD_FENCE.test(line.text)) {
      const fence = line.text.trim().slice(0, 3);
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].text.trim().startsWith(fence)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence, or the end of the text
      const pre = document.createElement("pre");
      pre.className = "md-pre";
      const code = document.createElement("code");
      if (body.length) emit(code, body[0].start, body[body.length - 1].end);
      pre.appendChild(code);
      root.appendChild(pre);
      continue;
    }

    if (MD_RULE.test(line.text)) {
      root.appendChild(document.createElement("hr"));
      i += 1;
      continue;
    }

    const heading = line.text.match(MD_HEADING);
    if (heading) {
      // Shifted down two levels (h1..h6 -> h3..h6): these sit INSIDE a chat bubble, so an `<h1>`
      // would outrank the panel's own heading and read as a page title.
      const level = Math.min(6, 2 + heading[1].length);
      const node = document.createElement(`h${level}`);
      node.className = "md-head";
      const from = line.start + line.text.indexOf(heading[2], heading[1].length);
      renderInline(node, text, from, line.end, emit);
      root.appendChild(node);
      i += 1;
      continue;
    }

    if (MD_QUOTE.test(line.text)) {
      const quote = document.createElement("blockquote");
      quote.className = "md-quote";
      while (i < lines.length && MD_QUOTE.test(lines[i].text)) {
        const inner = lines[i].text.match(MD_QUOTE);
        const para = document.createElement("p");
        const from = lines[i].start + lines[i].text.length - inner[1].length;
        renderInline(para, text, from, lines[i].end, emit);
        quote.appendChild(para);
        i += 1;
      }
      root.appendChild(quote);
      continue;
    }

    if (MD_BULLET.test(line.text) || MD_ORDERED.test(line.text)) {
      i = renderMdList(root, lines, i, text, emit, 0);
      continue;
    }

    // A GitHub pipe table needs its divider row to be a table at all; without it the pipes are
    // ordinary text and rendering a table would invent structure the model did not write.
    if (startsTable(i)) {
      const table = document.createElement("table");
      table.className = "md-table";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      mdTableRowCells(line).forEach((cell) => {
        const th = document.createElement("th");
        renderInline(th, text, cell.from, cell.to, emit);
        headRow.appendChild(th);
      });
      head.appendChild(headRow);
      table.appendChild(head);
      const body = document.createElement("tbody");
      i += 2;
      // A row must LOOK like one: leading pipe, or at least as many separators as the header has
      // columns. Otherwise ordinary prose that happens to contain a pipe was pulled into the table.
      const columns = mdTableRowCells(line).length;
      const leadingPipe = line.text.trim().startsWith("|");
      // Matched against the HEADER's own shape: a header that opens with `|` means every row does,
      // which is what keeps ordinary prose containing a single pipe out of the table.
      const looksLikeRow = (l) =>
        (leadingPipe ? l.text.trim().startsWith("|") : true)
        && (l.text.match(/\|/g) || []).length >= columns - 1;
      while (i < lines.length && lines[i].text.trim() && looksLikeRow(lines[i])) {
        const row = document.createElement("tr");
        mdTableRowCells(lines[i]).forEach((cell) => {
          const td = document.createElement("td");
          renderInline(td, text, cell.from, cell.to, emit);
          row.appendChild(td);
        });
        body.appendChild(row);
        i += 1;
      }
      table.appendChild(body);
      const scroller = document.createElement("div");
      scroller.className = "md-table-wrap";
      scroller.appendChild(table);
      root.appendChild(scroller);
      continue;
    }

    // Paragraph: everything up to a blank line or the next block starter.
    const para = document.createElement("p");
    para.className = "md-p";
    const from = line.start;
    let last = line;
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i], i)) {
      last = lines[i];
      i += 1;
    }
    renderInline(para, text, from, last.end, emit);
    root.appendChild(para);
  }
}

// Lists, one nesting level at a time. `indent` is the column the current level starts at, so a
// deeper item opens a nested list and a shallower one ends this call.
function renderMdList(root, lines, start, text, emit, indent) {
  const ordered = !lines[start].text.match(MD_BULLET);
  const list = document.createElement(ordered ? "ol" : "ul");
  list.className = "md-list";
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.text.match(MD_BULLET) || line.text.match(MD_ORDERED);
    if (!match) break;
    const depth = match[1].length;
    if (depth < indent) break;
    if (depth > indent) {
      // A level whose first item is already indented has no `<li>` to nest under, and appending to
      // the list itself produced `<ul>` directly inside `<ul>` — invalid, and it renders unindented.
      let host = list.lastElementChild;
      if (!host) {
        host = document.createElement("li");
        list.appendChild(host);
      }
      i = renderMdList(host, lines, i, text, emit, depth);
      continue;
    }
    const item = document.createElement("li");
    const body = match[match.length - 1];
    const from = line.start + line.text.length - body.length;
    renderInline(item, text, from, line.end, emit);
    list.appendChild(item);
    i += 1;
  }
  root.appendChild(list);
  return i;
}

function renderAnswerWithCitations(text, citations, runId) {
  const container = document.createElement("div");

  // Numbered from the NOTEBOOK-WIDE reference list, not per artifact. This comment used to claim
  // that "this sentence" and "reference 2" are visibly the same thing while the code counted 1..n
  // within each artifact separately: an overview citing two sources numbered them 1 and 2, the next
  // chat answer numbered ITS first citation 1 again, and the References panel — which numbers the
  // deduped whole — called that one 3. Every artifact after the first disagreed with the panel it
  // points into. `collectReferences` is the single ordering both ends now read.
  const order = new Map(collectReferences().map((ref, i) => [referenceKey(ref), i + 1]));
  // Fallback for a citation not yet in `state` (an artifact rendered before its state assignment).
  // 0 renders no number at all, which is the honest outcome — better than a number that points at
  // the wrong row.
  const referenceNumberFor = (citation) => order.get(referenceKey(citation)) || 0;

  // Locate each citation's quote as a literal substring of the RAW answer text (never
  // pre-escaped — a DOM text node needs no escaping, only innerHTML does). The model may
  // paraphrase around a quote rather than reproducing it verbatim; when a quote can't be located,
  // the citation still surfaces in the citation list below, just not inline.
  const matches = [];
  citations.forEach((citation) => {
    // `answer_span` FIRST: the model's own words, in the reader's language, already confirmed
    // server-side to occur in this exact text (`citations.locate_answer_spans`). `quote` is the
    // fallback for turns saved before that field existed — it only ever matched when the answer and
    // the source shared a language, which stopped being the common case at invariant 39, and that
    // is why the strokes vanished.
    const needle = citation.answer_span || citation.quote;
    if (!needle) return;
    const at = text.indexOf(needle);
    if (at !== -1) matches.push({ start: at, end: at + needle.length, citation });
  });
  matches.sort((a, b) => a.start - b.start);
  // Overlapping spans: keep the first, drop the rest. Done HERE rather than inside `emit`, which
  // walks ranges per text run and would otherwise have to re-decide the same thing every time.
  const ranges = [];
  matches.forEach((match) => {
    if (ranges.length && match.start < ranges[ranges.length - 1].end) return;
    ranges.push(match);
  });

  // Every fragment emitted for a given citation, so the reference number can be stamped on the LAST
  // one after the whole answer is built. Deciding "is this the last fragment" inside `emit` — the
  // first version's `sliceTo === match.end` — is wrong whenever a span's final characters are
  // markdown syntax the renderer DROPS (a closing `**`, a backtick, a link's `](url)`): no emit
  // call ever reaches `match.end`, so no fragment qualified and the stroke got NO number at all,
  // while the References panel numbered it anyway. Found by an independent review fuzzing the
  // renderer; the invariant even reasoned about this line and had the direction backwards, since
  // duplicate numbers were the risk it guarded and zero numbers was the one that happened.
  const fragments = new Map();

  const strokeFor = (match, slice) => {
    const span = document.createElement("span");
    span.className = match.citation.verified ? "citation" : "citation is-unverified";
    // A number, so a stroke can be matched to its entry in the reference list below — and so the
    // page reads as annotated prose rather than as a block of highlighter. Set as a CSS counter
    // rather than injected text, which keeps the answer's own words exactly as the model wrote
    // them (a copy-paste must not pick up UI furniture). Only the LAST fragment carries it: a
    // stroke crossing an inline `**bold**` is emitted as more than one span, and every fragment
    // carrying the number would print it two or three times. Stamped after the render, below.
    const seen = fragments.get(match) || [];
    seen.push(span);
    fragments.set(match, seen);
    // The coordinate this stroke points at, so `focusReference` can light up every stroke sharing
    // it. `.citation.is-focused` has been in the stylesheet promising that since the References
    // view landed, with nothing ever setting it — found by an independent review.
    span.dataset.refKey = referenceKey(match.citation);
    // The SOURCE, not the raw coordinate. It used to read `s1 · whole`, which is the interface's
    // own filing system — a user pointed out that nobody can tell what `s1` is. `sourceLabel` is
    // the same title the reference card shows, so hovering a stroke and reading its row agree.
    // The locator is appended only when it says something a reader can use (a page, a timestamp);
    // `whole` means "this source has one block" and is pure noise here.
    span.title = citationHoverLabel(match.citation);
    span.textContent = slice;
    // The other half of the reciprocal highlight: pointing at a stroke lights up its reference row,
    // exactly as pointing at the row lights up the stroke. Registered whether or not the stroke is
    // clickable — a reader hovering prose is asking "which source is this", and the answer should
    // not depend on whether the turn happens to carry a run id.
    const key = referenceKey(match.citation);
    span.addEventListener("mouseenter", () => linkReference(key, true));
    span.addEventListener("mouseleave", () => linkReference(key, false));
    if (runId) {
      span.classList.add("citation-clickable");
      // Opens the References view and takes the reader to that entry, rather than expanding a
      // panel inside the paragraph they are reading — which pushed the rest of the answer down and
      // made a crowded column worse.
      span.addEventListener("click", () => focusReference(match.citation));
    }
    return span;
  };

  // The ONE place raw text becomes nodes. The markdown renderer hands it raw offsets and never
  // creates a text node itself, which is what lets block structure and citation ranges compose:
  // a stroke that crosses a heading boundary or an inline marker is split here, not lost.
  const emit = (parent, from, to) => {
    if (to <= from) return;
    let cursor = from;
    ranges.forEach((match) => {
      if (match.end <= cursor || match.start >= to) return;
      const sliceFrom = Math.max(match.start, cursor);
      const sliceTo = Math.min(match.end, to);
      if (sliceFrom > cursor) {
        parent.appendChild(document.createTextNode(text.slice(cursor, sliceFrom)));
      }
      parent.appendChild(strokeFor(match, text.slice(sliceFrom, sliceTo)));
      cursor = sliceTo;
    });
    if (cursor < to) parent.appendChild(document.createTextNode(text.slice(cursor, to)));
  };

  renderMarkdownInto(container, text, emit);

  // Exactly one number per citation, on its last fragment — decided here, where every fragment is
  // known, rather than guessed at while emitting.
  fragments.forEach((spans, match) => {
    const n = referenceNumberFor(match.citation);
    // Absent, not "0": `content: attr(data-reference)` renders the literal character, so a 0 puts a
    // superscript zero next to the prose instead of the "no number at all" this fallback claims.
    if (n) spans[spans.length - 1].dataset.reference = String(n);
  });

  if (citations.length) {
    container.appendChild(renderReferenceLink(citations));
  }
  return container;
}

// One line under an answer, not a second copy of the reference list. The list itself lives in the
// References view now, where it is shared across every turn instead of repeating per answer.
function renderReferenceLink(citations) {
  const keys = new Set(citations.map(referenceKey));
  const link = document.createElement("button");
  link.type = "button";
  link.className = "reference-link";
  link.textContent = t("cite.references", `${keys.size} references`, { n: keys.size });
  link.addEventListener("click", () => focusReference(citations[0]));
  return link;
}

// A REFERENCE LIST, the way a paper carries one. It replaced a row of `✓ s3 · whole` repeated once
// per citation — four identical lines carrying no information, because a text or web source has a
// single block whose locator is literally "whole" — with one entry per DISTINCT source span,
// numbered, named, and showing the quoted evidence, which is the thing a reader actually wants to
// check.
//
// **The inline highlighter stroke (blueprint §2) cannot be drawn in cross-language mode, and this
// is the honest fallback rather than a workaround.** That stroke is located by finding the
// citation's `quote` as a substring of the answer. Since invariant 39 the answer follows the
// READER's language while the quote stays verbatim in the SOURCE's, so the two never share a
// substring and no span can be located. Restoring it needs the model to mark which part of its own
// answer each citation supports — a schema and instruction change, not something this renderer can
// recover.
// The readable name for a source, shared by the reference list and the viewer modal.
function sourceLabel(source) {
  const preview = source.preview || {};
  if (preview.title) return preview.title;
  return sourceDisplayName(source);
}

// What a reader should see when they point at a citation: the source's own name, plus a locator
// ONLY when it locates something (`page:3`, `ts:04:10`). `whole` is the locator every single-block
// source gets, so showing it says nothing and crowds out the part that does.
function citationHoverLabel(citation) {
  const source = (state.sources || []).find((s) => s.id === citation.source_id);
  const name = source ? sourceLabel(source) : citation.source_id;
  const locator = citation.locator && citation.locator !== "whole" ? citation.locator : "";
  const label = locator ? `${name} · ${locator}` : name;
  return citation.verified
    ? label
    : t("cite.unverifiedHover", `${label} — coordinate not found in this source`, { label });
}

//: "Ask this again, and replace the answer." A separate factory rather than something
//: `renderAnswerWithCitations` grows, for the reason `saveAsNoteButton` is one: that renderer
//: serves SIX surfaces and a Guide artifact must never sprout a chat action.
function regenerateTurnButton(question) {
  const wrapper = document.createElement("div");
  wrapper.className = "turn-regenerate";
  const button = document.createElement("button");
  button.type = "button";
  // The same `.ticker-toggle` shape as the steps pill beside it: one row, one weight.
  button.className = "ticker-toggle trace-face";
  button.textContent = t("chat.regenerateTurn", "\u21bb Regenerate");
  button.dataset.tip = t(
    "chat.regenerateTurnTip",
    "Ask this question again and replace this answer. Costs a full model run.",
  );
  button.addEventListener("click", () => store.emit("chat:regenerate", { question }));
  wrapper.appendChild(button);
  return wrapper;
}

function renderTurn(turn) {
  const wrapper = document.createElement("div");
  wrapper.className = "turn";

  const question = document.createElement("div");
  question.className = "turn-question";
  question.textContent = turn.question;
  wrapper.appendChild(question);

  const answer = document.createElement("div");
  answer.className = "turn-answer";
  if (turn.run_id) answer.dataset.runId = turn.run_id;
  if (turn.pending) {
    answer.classList.add("is-pending");
    answer.textContent = "Thinking…";
  } else {
    answer.appendChild(renderAnswerWithCitations(turn.answer, turn.citations || [], turn.run_id));
    // `turn.run_id` is `None`/absent for any turn saved before this field existed — degrades
    // gracefully to no affordance rather than a broken link (schema.ChatTurn.run_id's own doc).
    if (turn.run_id) {
      answer.appendChild(renderTickerAffordance(turn.run_id));
    }
    // Regenerate lives in the row this answer's OTHER affordances already occupy — the references
    // link and the steps pill — at the same quiet weight. Deliberately not a primary button:
    // re-answering costs a full model run, so it must not be the loudest thing under an answer the
    // reader may be perfectly happy with. The overview's own control makes the same call.
    //
    // The LAST turn only, hidden by a stylesheet rule rather than a flag passed in, because turns
    // reach the DOM through two paths (`rebuildHistory` and the `chat:turnAdded` replay) and a rule
    // that reads the DOM is right for both — the same reasoning `.turn-followups` already uses. It
    // also handles the pending row for free: a question in flight is not a moment to redo another.
    answer.appendChild(regenerateTurnButton(turn.question));
    // Appended HERE, by renderTurn itself — NOT inside renderAnswerWithCitations, which five OTHER
    // call sites (Guide/Podcast) also use and must never show this button (blueprint's Notes
    // addendum, audit round 1). `generateOverview` appends its own via the same factory, for the
    // same reason: a shared helper the CALL SITE opts into, never a button the shared renderer
    // grows on its own.
    answer.appendChild(saveAsNoteButton(turn.answer));
    // Suggested next questions, from the SAME run that produced the answer — no extra model call.
    // A user found this affordance on the overview and pointed out it appeared exactly once per
    // notebook and never again. Labelled "Ask next" rather than the overview's "Start with":
    // deliberately NOT unified, because the overview's appears before any conversation exists, and
    // "ask next" there would be asking the reader to continue something they have not begun.
    if (turn.follow_ups && turn.follow_ups.length) {
      // Wrapped so the stylesheet can show it on the LAST turn only. Every turn carries its own
      // suggestions (they are persisted per answer), and rendering all of them put a row of chips
      // under every answer in the thread — ten rows in a ten-turn conversation, nine of them
      // offering to continue a conversation that has already continued past them.
      //
      // `:last-child` rather than a flag passed in: turns reach the DOM through TWO paths
      // (`rebuildHistory` and the `chat:turnAdded` replay), and a rule that reads the DOM is right
      // for both without either having to remember. It also handles the pending row for free — a
      // question already in flight is not a moment to suggest another one.
      const block = document.createElement("div");
      block.className = "turn-followups";
      const label = document.createElement("div");
      label.className = "chat-overview-head";
      label.textContent = t("chat.askNext", "Ask next");
      block.appendChild(label);
      block.appendChild(starterQuestionRow(turn.follow_ups));
      answer.appendChild(block);
    }
  }
  wrapper.appendChild(answer);

  return wrapper;
}

// --- The chat overview: the notebook's front page ---------------------------------------------
//
// Adding a source used to leave the screen doing nothing — Chat said "ask a question once you've
// added a source", Studio said "pick a tab to generate it", and both waited on the user to discover
// the next move. The guided feel of a notebook product comes from the artifact appearing IN the
// conversation and being something you ask follow-ups about; a Summary buried in a right-hand tab
// is disconnected from the thread, so even finding it leads nowhere.
//
// THREE states, not two. The first version had only "generated in this page session" vs "not", on a
// DOM flag — so every notebook opened showing the first-run button even mid-conversation (reported
// with a screenshot), and adding a source DELETED the overview and reverted to that same button, so
// "never generated" and "generated but the sources changed" rendered identically. Confiscating an
// overview the user just paid an RLM run for, because they added a source, is worse than showing it
// with a marker: it is still true about the sources it was computed from.
//
//   never generated          ->  the Generate button
//   generated, current       ->  the overview + Save as note
//   generated, sources moved ->  the overview, marked stale, + Regenerate  (+ Save as note: a stale
//                                overview is precisely the one worth keeping before regenerating)
//
// `state.overview` comes from the server, which owns both the artifact and the `stale` verdict.
// Deliberately still an explicit button, NOT auto-generated on open: a guide run is a real RLM loop
// and Phase 2's rule (never spend one nobody asked for) is unchanged.
let overviewToken = 0;

//: True while `generateOverview` owns `#chat-overview` — its pulsing dot, its elapsed counter and
//: its Stop button live there and nowhere else.
//:
//: `renderChatOverview` CLEARS that element, and FIVE things call it for reasons that have nothing
//: to do with the run: `sources:changed`, the source-delete handler, a notebook switch, the rebuild
//: after an `ask`, and an interface-language change. (An earlier version of this comment said three
//: and listed source removal twice; invariant 71 said a DIFFERENT three. The guard is at the TOP of
//: the function, so every caller was covered either way.) So adding a source while an overview
//: generated wiped the progress indicator AND the only Stop — invariant
//: 47's rule broken by a repaint, the same class invariant 60 fixed for the pending chat turn and
//: for exactly the same reason: a repaint must carry the run in flight with it.
//:
//: Worse than it sounds. `sources:changed` deliberately does NOT bump `overviewToken` (stranding a
//: generation the server has already paid for would be the bigger bug), so the run stays live with
//: no way to see or stop it until it lands minutes later.
let overviewRunning = false;

function renderChatOverview() {
  // A run owns this element. It repaints itself when it finishes, cancels or fails, and staleness
  // is recomputed server-side at that point anyway — so there is nothing to lose by deferring.
  if (overviewRunning) return;
  const el = document.getElementById("chat-overview");
  el.textContent = "";
  el.hidden = !state.sources.length;
  if (!state.sources.length) return;

  const overview = state.overview;
  if (!overview) {
    el.appendChild(overviewStarter(t("chat.generateOverview", "\u2728 Summarise and suggest questions"), t("chat.orJustAsk", "\u2026or just ask a question below.")));
    return;
  }

  const head = document.createElement("div");
  head.className = "chat-overview-head";
  head.textContent = overview.stale
    ? t("chat.overviewStale", "Overview \u00b7 sources have changed since this")
    : t("chat.overview", "Overview");
  el.appendChild(head);

  el.appendChild(renderAnswerWithCitations(overview.text, overview.citations || [], overview.run_id));
  // No cache guard: the affordance loads the record from the server when this page has none, which
  // is every run after a reload.
  if (overview.run_id) {
    el.appendChild(renderTickerAffordance(overview.run_id));
  }
  el.appendChild(saveAsNoteButton(overview.text));

  // FOUR states, not three. Invariant 38 named "never generated / current / stale"; an overview
  // that is current but arrived INCOMPLETE is a fourth, because `/overview` runs Summary and FAQ
  // concurrently and persists the summary even when the FAQ half dies. It rendered as nothing, then
  // (worse) as a note telling the reader to regenerate while the regenerate button was still gated
  // behind `stale` — a message naming an action the page did not offer.
  let offerRegenerate = overview.stale;

  // Only before the conversation starts. These are an invitation to BEGIN — that is the whole
  // reason this row says "Start with" while an answer's says "Ask next" (invariant 56) — and once
  // there are turns the live suggestion is the latest answer's, at the bottom of the thread where
  // the reader actually is. Leaving both on screen put two competing rows a scroll apart.
  if (state.turns && state.turns.length) {
    // nothing: the thread's own latest answer carries the suggestions now
  } else if (overview.starter_questions && overview.starter_questions.length) {
    const label = document.createElement("div");
    label.className = "chat-overview-head";
    label.textContent = t("chat.startWith", "Start with");
    el.appendChild(label);
    el.appendChild(starterQuestionRow(overview.starter_questions));
  } else {
    // An overview with NO starter questions is a half-failure, not an empty result: `/overview`
    // fires a Summary and an FAQ concurrently and persists the summary even when the FAQ half dies
    // (invariant 38). It rendered as nothing at all, so a user whose FAQ half had timed out reported
    // the suggestions as having disappeared from the product — the same "a superseded generation
    // says so" lesson invariant 47 records, on a different path. Saying it, with the button that
    // fixes it, costs one line.
    const note = document.createElement("div");
    note.className = "chat-overview-note";
    note.textContent = t(
      "chat.noStarters",
      "No suggested questions came back with this overview \u2014 regenerate to try again.",
    );
    el.appendChild(note);
    offerRegenerate = true;
  }

  // ONE button, whichever state asked for it — a stale overview and an incomplete one both want
  // the same action, and appending it per-branch would have produced two on a notebook that is both.
  //
  // ALWAYS OFFERED once an overview exists, which it was not: it was gated behind `stale` or
  // "incomplete", so an overview that was current and complete but simply WRONG had no way to be
  // regenerated at all. A user hit exactly that — asked how to press a button that was not on the
  // page — while looking at an overview whose five citations had all failed coordinate
  // verification. Nothing about their sources had changed, so nothing ever made it stale. The
  // podcast has offered a quiet Regenerate in this same state since invariant 42; the overview
  // simply never gained it.
  el.appendChild(
    overviewStarter(
      offerRegenerate
        ? t("chat.regenerateOverview", "\u21bb Regenerate overview")
        : t("chat.refreshOverview", "\u21bb Regenerate"),
      "",
      !offerRegenerate,
    )
  );
}

function overviewStarter(labelText, hintText, quiet) {
  //: The first-run label NAMES BOTH HALVES of what this produces, and it is deliberately not
  //: "Generate overview". `/overview` runs two tasks: a summary AND the starter questions, and the
  //: short label mentioned neither. Worse, it sat one column away from Studio's "Generate Summary",
  //: which runs the SAME summary task while keeping nothing (invariant 38 persists the overview and
  //: not the four Studio kinds), so the two read as one feature offered twice. A user asked which
  //: was which. In Chinese the collision was sharper still: 概覽 and 摘要 are near synonyms.
  //:
  //: Only the FIRST-RUN button changed. The artifact keeps its own name in its heading, where it
  //: sits in the chat thread with nothing to be confused with, and the regenerate label with it.
  //:
  //: This comment lives INSIDE the function on purpose. Above it, it fell within the slice
  //: `test_a_message_naming_an_action_ships_with_that_action` takes of `renderChatOverview`, which
  //: counts a key's occurrences to prove there is exactly one regenerate control. Naming the key in
  //: prose made it two.
  const wrap = document.createElement("div");
  wrap.className = "chat-starter";
  const btn = document.createElement("button");
  btn.type = "button";
  // SECONDARY once an overview exists. Regenerating costs two real RLM runs, so it must not be the
  // loudest thing on a panel that already holds what it makes — the same weighting the podcast's
  // own generate button uses (invariant 42), applied to the control that had been missing entirely.
  btn.className = quiet ? "btn" : "btn btn-primary";
  btn.textContent = labelText;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    void generateOverview();
  });
  wrap.appendChild(btn);
  if (hintText) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = hintText;
    wrap.appendChild(hint);
  }
  return wrap;
}

function starterQuestionRow(questions) {
  const row = document.createElement("div");
  row.className = "starter-questions";
  questions.forEach((question) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "starter-question";
    // textContent, never innerHTML — model-authored text derived from source content a
    // prompt-injected source could influence (invariants 6 and 29).
    chip.textContent = question;
    chip.addEventListener("click", () => {
      // `requestSubmit()` submits as if by the form, so a DISABLED submit button never blocks it;
      // the chips live outside the region `chat:pending` disables, so the guard has to be here.
      if (document.getElementById("ask-submit").disabled) return;
      document.getElementById("ask-input").value = question;
      document.getElementById("ask-form").requestSubmit();
    });
    row.appendChild(chip);
  });
  return row;
}

// One POST; the server runs Summary and FAQ concurrently and persists the result, so nothing is
// lost if this tab closes while it runs.
async function generateOverview() {
  const el = document.getElementById("chat-overview");
  const generation = notebookGeneration;
  const token = (overviewToken += 1);
  const notebookId = state.notebookId;
  if (!notebookId) return;
  const live = () => generation === notebookGeneration && token === overviewToken;

  el.hidden = false;
  el.textContent = "";
  overviewRunning = true;
  // FREEZE THE COMPOSER, at the user's request and twice asked for. It is not needed for
  // correctness — the two runs are independent, `mutate_notebook` re-reads under a per-notebook
  // lock so both writes land (invariant 34), and neither repaint can delete the other's run
  // (invariants 60 and 71). It is what the person using it wants: a question asked into a thread
  // whose overview is being rewritten reads as two things fighting, whether or not they are.
  //
  // The composer only — never the thread. Clearing the conversation was offered as an alternative
  // and is the one thing not to do: it would destroy history to signal a transient state.
  store.emit("chat:pending", { pending: true });

  // The server appends `-summary`/`-faq` to the run id it derives, so both targets are predictable:
  // the ticker follows the summary, and Stop cancels BOTH (a notebook-scoped cancel would leave the
  // FAQ run burning a model call to completion).
  ensureTitle();
  const runToken = crypto.randomUUID();
  const base = `${state.notebookSlug || notebookId}-${runToken}`;
  let cancelled = false;
  const status = runStatus({
    notebookId,
    runIds: [`${base}-summary`, `${base}-faq`],
    label: t("chat.readingSources", "Reading your sources\u2026"),
    onCancel: () => {
      cancelled = true;
      overviewToken += 1; // strand this generation's own response
      overviewRunning = false; // release BEFORE the repaint, or the guard above swallows it
      store.emit("chat:pending", { pending: false });
      renderChatOverview(); // straight back to the pre-run state, nothing half-written left behind
    },
  });
  el.appendChild(status.node);

  void openTicker(notebookId, `${base}-summary`, (event) => {
    if (!live()) return;
    // `/overview` runs TWO tasks and this ticker follows only the summary. Forwarding its terminal
    // event made "完成" the whole action's headline while the FAQ half was still running and the
    // POST had not returned — measured: a 63KB summary trace beside a 226-byte FAQ trace, its
    // worker still alive, and no response yet. The panel then sat on "Finished" next to a live Stop
    // button, which is invariant 60's rule ("a status line may not claim something the page is not
    // doing") broken by the second run rather than by a phase.
    //
    // `setPhase` is exactly the seam invariant 60 added for a stage the trace cannot see. STOPPABLE,
    // because it genuinely is: `runIds` carries both ids and Stop cancels each by run id.
    if (TERMINAL_KINDS.has(event.kind)) {
      status.setPhase(t("chat.overviewSecondHalf", "Summary done \u00b7 writing suggested questions\u2026"));
      return;
    }
    status.onEvent(event);
  });

  try {
    const notebook = await api(`/notebooks/${encodeURIComponent(notebookId)}/overview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `fresh` when an overview already exists — i.e. the button said Regenerate. dspy's LM cache
      // is on by default, so without this a Regenerate on an unchanged corpus replays the previous
      // run byte-identically for zero model calls, and a button that returns what you already had
      // is a UI that lies. A FIRST generate keeps the cache, where a hit is a free correct answer.
      body: JSON.stringify({ run_id: runToken, fresh: Boolean(state.overview) }),
    });
    status.finish();
    overviewRunning = false;
    store.emit("chat:pending", { pending: false });
    if (cancelled) return;
    if (!live()) {
      // SUPERSEDED, not lost. Saying nothing here is what made a real report read as "pressed
      // generate, it said Finished, then nothing ever appeared": the response arrived, this guard
      // dropped it silently, and the last ticker line just sat there looking stuck.
      //
      // But `!live()` covers TWO situations and only one of them is this panel's business. If the
      // reader has SWITCHED NOTEBOOKS, `#chat-overview` now belongs to a different notebook and
      // writing here would overwrite ITS overview with a note about a run it never started.
      // Superseding is a same-notebook event: a second press of Generate.
      if (generation === notebookGeneration) supersededNote(el);
      return;
    }
    state.overview = notebook.overview;
    refreshReferenceView();
    renderChatOverview();
    // The thread too: a regenerated overview changes which coordinates come FIRST in the
    // notebook-wide reference order, so every stroke already on screen would keep a number that no
    // longer matches the row it points at. Cheap, and the alternative is a page that is internally
    // inconsistent until the next reload.
    store.emit("chat:rerender", {});
  } catch (err) {
    status.finish();
    overviewRunning = false;
    store.emit("chat:pending", { pending: false });
    if (cancelled) return;
    if (!live()) {
      if (generation === notebookGeneration) supersededNote(el);
      return;
    }
    el.textContent = "";
    const note = document.createElement("div");
    note.textContent = t("chat.overviewFailed", `(could not generate an overview: ${err.message})`, { message: err.message });
    el.appendChild(note);
    el.appendChild(overviewStarter(t("chat.tryAgain", "\u21bb Try again"), ""));
  }
}

// A generation whose result is no longer the current one (the user regenerated, or switched
// notebooks and back). The old code returned silently, which is indistinguishable from a hang.
function supersededNote(el) {
  el.textContent = "";
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = t("chat.overviewSuperseded", "That overview was superseded by a newer one.");
  el.appendChild(note);
  el.appendChild(overviewStarter(t("chat.generateOverview", "\u2728 Summarise and suggest questions"), ""));
}

function initChatPanel() {
  const history = document.getElementById("chat-history");
  const empty = document.getElementById("chat-empty");
  const overviewEl = document.getElementById("chat-overview");

  // ONE rebuild, used by every path that redraws the thread. The overview is the thread's first
  // entry now, so a `history.innerHTML = ""` that forgot to put it back would silently delete it —
  // which is exactly what the old sibling layout was avoiding.
  // The placeholder reads "Ask a question once you've added a source" — which is only TRUE while
  // there is no source. It used to be gated on turns alone, so a notebook with eight sources and no
  // conversation still told the reader to add one; a user reported it as confusing, and it is: the
  // sentence describes a precondition they have already met. Once a source exists the invitation is
  // the overview's own button (or its starter questions), a few lines above.
  const syncEmptyNote = (turns, pending) =>
    (empty.hidden = turns.length > 0 || Boolean(pending) || (state.sources || []).length > 0);

  //: "Clear conversation". Declared up here because the handlers that keep it in sync are the
  //: EXISTING `chat:turnAdded` / `chat:rerender` / `notebook:switched` subscriptions — a second
  //: handler for one event inside one init is what `test_no_event_is_subscribed_twice_inside_one_
  //: init_function` forbids, and rightly: two of them make ordering matter.
  const clearBtn = document.getElementById("chat-clear");
  const syncClearBtn = () => {
    clearBtn.hidden = !state.notebookId || !(state.turns || []).length;
  };


  //: The question currently in flight, if any. `chat:rerender` has to put it back: an independent
  //: review reproduced regenerating the overview mid-question deleting the pending row, its status
  //: and its Stop, leaving a disabled composer with no way to cancel until the answer landed
  //: minutes later — invariant 47's rule broken by a repaint.
  let pendingTurn = null;

  const rebuildHistory = (turns, pending) => {
    history.textContent = "";
    history.appendChild(overviewEl);
    history.appendChild(empty);
    syncEmptyNote(turns, pending);
    turns.forEach((turn) => history.appendChild(renderTurn(turn)));
    if (pending) history.appendChild(renderTurn(pending));
  };
  const form = document.getElementById("ask-form");
  const input = document.getElementById("ask-input");
  const submitBtn = document.getElementById("ask-submit");

  // Enter sends, Shift+Enter breaks a line. The convention every chat composer uses, and the reason
  // the hint row exists at all: without it this is a rule you can only find by accident.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Never steal Enter mid-composition: an IME is still assembling a character, and submitting
    // there would send a half-typed word. `isComposing` is exactly what that flag is for, and this
    // matters far more here than in an English-only UI.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  });

  // The box grows with the question and stops at the CSS ceiling, then scrolls. Driven from the
  // real scrollHeight rather than a line count, so it is right for wrapped text too.
  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    form.classList.toggle("has-text", input.value.trim().length > 0);
  };
  input.addEventListener("input", autoGrow);
  autoGrow();

  store.on("notebook:switched", () => {
    overviewToken += 1; // a notebook switch strands any generation still in flight
    store.emit("chat:pending", { pending: false }); // ...and un-freezes the new notebook's composer
    // ...and releases the panel it owned. Without this the new notebook keeps the OLD run's
    // pulsing dot and Stop, because `renderChatOverview` defers while a run owns the element.
    overviewRunning = false;
    renderChatOverview();
    // The placeholder comes back too: `chat:turnAdded` hides it, and without this a switch FROM a
    // notebook with turns TO an empty one left a blank panel with no "ask a question" prompt at all.
    rebuildHistory([]);
    syncClearBtn();
  });

  // Chat's own reaction to the corpus changing. Re-render only — deliberately NOT a token bump:
  // that would strand a generation the server has already persisted, leaving the user looking at
  // the button after paying for two RLM runs sitting on disk (adding a source while the model works
  // is the exact behaviour invariant 34 documents as real). The re-render flips the overview to
  // stale on its own, because the server's `source_ids` no longer match.
  store.on("sources:changed", () => {
    renderChatOverview();
    // Adding the FIRST source has to retire the placeholder immediately — it is the moment its
    // sentence stops being true, and nothing else redraws the thread at that point.
    syncEmptyNote(state.turns || [], pendingTurn);
  });
  renderChatOverview();

  store.on("chat:turnAdded", ({ turn, restoring }) => {
    empty.hidden = true;
    history.appendChild(renderTurn(turn));
    // Only a NEW turn scrolls to the bottom. Replaying a saved conversation on open used to run
    // this once per turn, so a returning reader landed with the overview — and, on a notebook with
    // turns but no overview yet, the "Generate overview" button — already a thousand pixels above
    // the fold. Invariant 57 says the overview scrolls AWAY as the conversation grows; starting
    // there is a different thing.
    if (!restoring) history.scrollTop = history.scrollHeight;
    syncClearBtn();
  });

  // Something outside the thread changed the notebook-wide reference order (regenerating the
  // overview is the one that does it today), so every turn's stroke numbers have to be recomputed.
  store.on("chat:rerender", () => {
    rebuildHistory(state.turns || [], pendingTurn);
    syncClearBtn();
  });

  store.on("chat:pending", ({ pending }) => {
    submitBtn.disabled = pending;
    input.disabled = pending;
    // Clearing WHILE a question runs is a race with no upside: the server would delete the turns
    // and then `ask`'s own persist would append the answer to the empty list, so the conversation
    // the reader just cleared comes back with one entry. Stop is the control for a run in flight;
    // this one is for a conversation that has finished happening.
    clearBtn.disabled = pending;
  });

  // One flow, two entry points: the composer, and a turn's own "regenerate". Extracted rather than
  // copied — the pending row, the live ticker, the Stop button, the cancel path and the
  // rebuild-from-the-server's-own-record are the parts that would drift, and this file has already
  // paid for a duplicated affordance once (the two "N steps" pills).
  //
  // `regenerate` REPLACES the last turn server-side when the question still matches it. Only the
  // last: every later answer was produced with this one in its `history` (invariant 11), so
  // regenerating mid-thread would leave the answers after it derived from a conversation that no
  // longer exists. The button is offered on the last turn only, and the server re-checks.
  async function askQuestion(question, { regenerate = false } = {}) {
    if (!state.notebookId) {
      alert(t("err.openNotebookFirst", "Open or name a notebook first."));
      return;
    }
    if (!question) return;

    // The CLIENT picks the run id (blueprint P3.1) — a server-generated one would never reach us
    // until the request was already over, too late to open a live ticker against it.
    const generation = notebookGeneration;
    const askedNotebookId = state.notebookId;
    const token = crypto.randomUUID();
    const runId = `${state.notebookSlug || state.notebookId}-${token}`;

    ensureTitle();
    pendingTurn = { question, pending: true, run_id: runId };
    store.emit("chat:turnAdded", { turn: pendingTurn });
    store.emit("chat:pending", { pending: true });

    // The same live surface the Studio actions use, mounted into the pending answer row. Chat had
    // no way to stop a question either, and a question against a large corpus is not quick.
    let cancelled = false;
    const answerEl = history.querySelector(`.turn-answer[data-run-id="${CSS.escape(runId)}"]`);
    const status = runStatus({
      notebookId: askedNotebookId,
      runIds: [runId],
      label: t("chat.thinking", "Thinking\u2026"),
      onCancel: () => {
        cancelled = true;
        // Nothing is in flight any more; a rebuild must not resurrect the row.
        pendingTurn = null;
        store.emit("chat:pending", { pending: false });
        const row = history.querySelector(`.turn-answer[data-run-id="${CSS.escape(runId)}"]`);
        if (row) {
          row.classList.remove("is-pending");
          row.textContent = t("chat.stopped", "(stopped)");
        }
      },
    });
    if (answerEl) {
      answerEl.textContent = "";
      answerEl.appendChild(status.node);
    }

    openTicker(state.notebookId, runId, (evt) => status.onEvent(evt));

    try {
      const result = await api(`/notebooks/${encodeURIComponent(state.notebookId)}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, run_id: token, regenerate }),
      });
      // Re-render the whole history from the server's own record rather than mutating the
      // pending row in place — the server is the source of truth for what actually got persisted.
      // Capture the id BEFORE awaiting: re-reading `state.notebookId` here would build
      // `/notebooks/null` if the user started a new notebook while the answer was in flight.
      status.finish();
      if (cancelled) return;
      if (generation !== notebookGeneration) return;
      const notebook = await api(`/notebooks/${encodeURIComponent(askedNotebookId)}`);
      if (generation !== notebookGeneration) return;
      state.turns = notebook.turns;
      // CLEARED before the rebuild: the turn is in `state.turns` now, so a later `chat:rerender`
      // that still held this object would render the same question twice.
      pendingTurn = null;
      refreshReferenceView();
      rebuildHistory(state.turns);
      void result; // already folded into notebook.turns above
    } catch (err) {
      status.finish();
      // `cancelled` covers Stop; `!pendingTurn` covers every other way the row can have gone away
      // before the request settled. Without it a failing run threw INSIDE its own error handler, so
      // the reader saw no error row and no alert — the question simply stopped.
      if (cancelled || !pendingTurn) return;
      pendingTurn.pending = false;
      pendingTurn.answer = t("err.generic", `(error) ${err.message}`, { message: err.message });
      pendingTurn.citations = [];
      rebuildHistory(state.turns, pendingTurn);
    } finally {
      store.emit("chat:pending", { pending: false });
    }
  }

  // The composer clears itself; `askQuestion` does not, because a regenerate has nothing to clear.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    input.style.height = "auto";
    form.classList.remove("has-text");
    void askQuestion(question);
  });

  // A turn asks to be redone. Exposed on `store` rather than threaded through `renderTurn`'s six
  // call sites: the button is built far from here and this is the one flow that can run it.
  store.on("chat:regenerate", ({ question }) => void askQuestion(question, { regenerate: true }));

  // Starting over. Turns were append-only, so a reader who wanted a fresh start had nowhere to go:
  // a source could be deleted and a note could be deleted, but a conversation could only grow.
  // Regenerate replaces the LAST answer and deliberately cannot reach further back (invariant 11);
  // this is the other end of that same fact, and the only honest way to undo a turn in the middle.
  clearBtn.addEventListener("click", async () => {
    // Irreversible, like every other delete here — and unlike removing ONE source, this discards
    // work that cost real model runs, so the confirmation names what survives as well as what goes.
    //
    // The generation is captured for the same reason every other awaiting flow here captures it
    // (`generateOverview`, `askQuestion`, `fetchKind`, the podcast): this one did not, and a
    // notebook switch during the DELETE applied the result to whichever notebook was open when it
    // landed — wiping the NEW notebook's conversation out of client state and off the screen.
    const generation = notebookGeneration;
    const n = (state.turns || []).length;
    if (
      !confirm(
        t(
          "chat.clearConfirm",
          `Delete all ${n} questions and answers? Sources, notes and the overview are kept.`,
          { n }
        )
      )
    ) {
      return;
    }
    clearBtn.disabled = true;
    try {
      const notebook = await api(`/notebooks/${encodeURIComponent(state.notebookId)}/turns`, {
        method: "DELETE",
      });
      // The notebook that was cleared is not necessarily the one on screen any more.
      if (generation !== notebookGeneration) return;
      // From the server's own record, never from an assumption about what it did.
      state.turns = notebook.turns;
      refreshReferenceView();
      // `pendingTurn` is CARRIED, not dropped. Clearing is disabled while a question runs (below),
      // so this is defence rather than a live path — but `rebuildHistory(state.turns)` alone would
      // delete a running question's row along with its elapsed counter and its only Stop, which is
      // invariant 47 broken by a repaint and exactly what invariant 60 fixed for `chat:rerender`.
      // Nulling it was worse still: `askQuestion`'s own catch then threw on a null, so a run that
      // failed after a clear rendered no error row and raised no alert — it just stopped.
      rebuildHistory(state.turns, pendingTurn);
      // `refreshReferenceView` above already re-stamped every stroke on the page (`renumberStrokes`),
      // so this needs no `chat:rerender` — emitting one would only rebuild the thread a second time,
      // and `chat:rerender` has exactly one emitter for a reason (regenerating the overview is the
      // thing that changes the notebook-wide order from OUTSIDE the thread).
      //
      // The overview's starter questions come back: they are shown only before a conversation
      // exists, and one no longer does.
      renderChatOverview();
      syncClearBtn();
    } catch (err) {
      alert(t("err.generic", `(error) ${err.message}`, { message: err.message }));
    } finally {
      clearBtn.disabled = false;
    }
  });
  syncClearBtn();
}

// --- Studio panel: Guide tabs -----------------------------------------------------------------

// Fetched ONLY on first tab activation or an explicit regenerate click, never on every tab
// switch — a guide run is a real RLM loop (same latency class as `ask`), so re-running it on every
// idle click would burn a model call for nothing. Cached per notebook, keyed by kind; cleared on
// BOTH a notebook switch AND a source being added — a cached result is stale the moment the corpus
// it was computed from changes, not just when the notebook itself changes.
function renderGuideContent(kind, data, runId) {
  const container = document.createElement("div");
  container.className = "guide-prose";

  if (kind === "summary" || kind === "insight") {
    container.appendChild(renderAnswerWithCitations(data.text, data.citations || [], runId));
    return container;
  }

  if (kind === "faq") {
    if (!data.items || !data.items.length) {
      container.textContent = t("studio.noFaq", "(no FAQ items — the sources didn't produce enough to ask about)");
      return container;
    }
    data.items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "guide-item";
      const head = document.createElement("div");
      head.className = "guide-item-head";
      head.textContent = item.question;
      div.appendChild(head);
      div.appendChild(renderAnswerWithCitations(item.answer, item.citations || [], runId));
      container.appendChild(div);
    });
    return container;
  }

  // "timeline"
  if (!data.events || !data.events.length) {
    container.textContent = t("studio.noTimeline", "(no timeline events — the sources didn't produce enough to place in time)");
    return container;
  }
  data.events.forEach((event) => {
    const div = document.createElement("div");
    div.className = "guide-item";
    const when = document.createElement("div");
    when.className = "guide-item-when";
    when.textContent = event.when;
    div.appendChild(when);
    div.appendChild(renderAnswerWithCitations(event.description, event.citations || [], runId));
    container.appendChild(div);
  });
  return container;
}

//: What each Studio tab is FOR. Shown as the tab's own hover title and as the hint beside its
//: generate button, so the panel explains itself without a permanent paragraph of prose taking up
//: rail space — the pattern `toolscout`/`cve-reverser` already use for their own controls.
const GUIDE_LABELS = {
  summary: "summary",
  faq: "FAQ",
  timeline: "timeline",
  insight: "key insight",
};

function guideLabel(kind) {
  return t(`studio.kind.${kind}`, GUIDE_LABELS[kind] || kind);
}

const GUIDE_HINTS = {
  summary: "A few paragraphs covering what all your sources say, with citations you can check.",
  faq: "The questions your sources actually answer, each with its answer and a citation.",
  timeline: "Dated events pulled out of your sources and put in order.",
  insight: "The single most important takeaway, in one sentence.",
};

function guideHint(kind) {
  return t(`studio.tip.${kind}`, GUIDE_HINTS[kind] || "");
}

function initStudioPanel() {
  const tabs = document.querySelectorAll("#guide-tabs .tab");
  const body = document.getElementById("guide-body");
  const regenerateBtn = document.getElementById("guide-regenerate");
  // Cache VALUE widened to {result, runId} — storing the result alone (an earlier draft's shape)
  // would lose the run id the moment a user switches tabs and back, breaking citation-turn lookup
  // for a tab already left (found during this phase's own pre-implementation audit).
  // Keyed by kind, VALUE `{result, runId}` — storing the result alone would lose the run id the
  // moment a user switches tabs and back, breaking citation-turn lookup for a tab already left.
  const cache = {
    has: (kind) => kind in state.guides,
    get: (kind) => state.guides[kind],
    set: (kind, value) => {
      state.guides[kind] = value;
    },
    // `delete` was lost when this moved from a `Map` onto `state`, and `regenerateBtn` calls it —
    // so Studio's ↻ Regenerate threw `TypeError: cache.delete is not a function` and did nothing.

    delete: (kind) => {
      delete state.guides[kind];
    },
    clear: () => {
      state.guides = {};
    },
  };
  let activeKind = "summary";

  function setActiveKind(kind) {
    activeKind = kind;
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.guideKind === kind));
  }

  function renderCached(kind, cached) {
    body.innerHTML = "";
    body.appendChild(renderGuideContent(kind, cached.result, cached.runId));
    body.appendChild(renderTickerAffordance(cached.runId));
  }

  async function fetchKind(kind) {
    if (!state.notebookId) {
      body.innerHTML = "";
      body.classList.remove("is-pending");
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = t("studio.noNotebook", "Open a notebook with sources, then pick a tab to generate it.");
      body.appendChild(note);
      return;
    }
    ensureTitle();
    const generation = notebookGeneration;
    const token = crypto.randomUUID();
    const runId = `${state.notebookSlug || state.notebookId}-${token}`;
    body.classList.add("is-pending");
    body.innerHTML = "";
    let cancelled = false;
    const status = runStatus({
      notebookId: state.notebookId,
      runIds: [runId],
      label: t("studio.generating", `Generating the ${guideLabel(kind)}\u2026`, { kind: guideLabel(kind) }),
      onCancel: () => {
        cancelled = true;
        body.classList.remove("is-pending");
        showKind(kind); // straight back to the offer, nothing half-written left behind
      },
    });
    body.appendChild(status.node);
    openTicker(state.notebookId, runId, (evt) => status.onEvent(evt));
    try {
      const data = await api(`/notebooks/${encodeURIComponent(state.notebookId)}/guide/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: token }),
      });
      status.finish();
      if (cancelled) return;
      if (generation !== notebookGeneration) return;  // switched away — never cache into the new one
      cache.set(kind, { result: data, runId });
      refreshReferenceView();
      body.classList.remove("is-pending");
      showRegenerate(kind);
      renderCached(kind, cache.get(kind));
    } catch (err) {
      status.finish();
      if (cancelled) return;
      body.classList.remove("is-pending");
      body.textContent = t("err.generic", `(error) ${err.message}`, { message: err.message });
    }
  }

  // Selecting a tab SHOWS it; it never starts a run. Switching tabs used to fire a real RLM call
  // immediately, so browsing the four kinds to see what they were cost four model runs and a user
  // could not tell which click had committed them to one. The offer is explicit now, matching the
  // chat overview's own "✨ Generate" affordance.
  //: ↻ Regenerate is shown only where there is something to regenerate. It is static markup and
  //: nothing ever toggled it, so on a tab that had generated nothing it sat above the primary
  //: "Generate the Summary" button doing the identical thing under a label implying otherwise:
  //: `cache.delete` on a key that is not there, then the same `fetchKind`. Two controls, one
  //: action, and the quieter one claiming a result exists. This is invariant 71's rule for the
  //: chat overview (the button's WEIGHT varies, its EXISTENCE follows the artifact) applied to the
  //: panel that was missing it. Hiding is safe here: `.guide-regenerate` declares no `display` of
  //: its own and `.btn` carries its own `[hidden]` guard (invariants 36 and 44).
  function showRegenerate(kind) {
    regenerateBtn.hidden = !cache.has(kind);
  }

  function showKind(kind) {
    setActiveKind(kind);
    showRegenerate(kind);
    if (cache.has(kind)) {
      renderCached(kind, cache.get(kind));
      return;
    }
    body.innerHTML = "";
    if (!state.notebookId || !state.sources.length) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = t("studio.addSourceFirst", "Add a source first, then generate this.");
      body.appendChild(note);
      return;
    }
    const offer = document.createElement("div");
    offer.className = "chat-starter";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary";
    btn.textContent = t("studio.generate", `\u2728 Generate ${guideLabel(kind)}`, { kind: guideLabel(kind) });
    btn.addEventListener("click", () => fetchKind(kind));
    offer.appendChild(btn);
    const hint = document.createElement("p");
    hint.className = "empty-note";
    hint.textContent = guideHint(kind);
    offer.appendChild(hint);
    body.appendChild(offer);
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showKind(tab.dataset.guideKind));
  });

  regenerateBtn.addEventListener("click", () => {
    cache.delete(activeKind);
    // Hidden for the duration: the run has no cached result behind it any more, and `runStatus`
    // owns the panel while it is in flight (invariant 47).
    showRegenerate(activeKind);
    fetchKind(activeKind);
  });

  function invalidateCache() {
    cache.clear();
  }

  // Opening a notebook does NOT auto-fetch a Guide kind — that would burn a model call just from
  // opening a notebook. Neither does SELECTING a tab any more (see `showKind`); every run is an
  // explicit button press.
  store.on("notebook:switched", () => {
    invalidateCache();
    showKind("summary");
  });
  // A source changing invalidates the cache AND re-renders, so the panel goes back to offering a
  // fresh generation rather than silently holding a result computed from a corpus that has moved.
  store.on("sources:changed", () => {
    invalidateCache();
    showKind(activeKind);
  });

  showKind("summary");
}

// --- Studio panel: podcast player ------------------------------------------------------------

function formatTimecode(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const ss = String(total % 60).padStart(2, "0");
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  // An hour component only when there is one, so a three-minute episode stays `2:41` rather than
  // `0:02:41` — but a long one no longer renders `63:05`.
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function renderPodcastUtterance(utterance, runId, { start = null, onSeek = null } = {}) {
  const div = document.createElement("div");
  div.className = "podcast-utterance";

  const speaker = document.createElement("div");
  speaker.className = "podcast-speaker";
  speaker.textContent = utterance.speaker === "host_a" ? "Host A" : "Host B";

  // A timecode only when the provider actually reported one. Without it the line stays a plain
  // transcript entry rather than showing a made-up 0:00 or becoming a seek target that lies.
  if (start !== null) {
    const stamp = document.createElement("button");
    stamp.type = "button";
    stamp.className = "podcast-timecode";
    stamp.textContent = formatTimecode(start);
    stamp.addEventListener("click", () => onSeek && onSeek(start));
    speaker.appendChild(stamp);
    div.classList.add("is-seekable");
    div.addEventListener("click", (event) => {
      // The line itself seeks, but never when the click was meant for something inside it — a
      // citation span opens its reference, the timecode has its own handler, and
      // `.reference-link` is the "N references" button `renderAnswerWithCitations` appends as a
      // SIBLING inside this same utterance. That one was MISSING while two dead classes from the
      // replaced citation-list markup were still listed — found by an independent review, and it
      // meant clicking "2 references" both jumped the player and switched the panel away.
      if (event.target.closest(".citation, .reference-link, .podcast-timecode")) {
        return;
      }
      // `click` also fires on the mouseup that ends a drag-selection, so selecting transcript prose
      // to quote it would otherwise seek and autoplay.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      if (onSeek) onSeek(start);
    });
  }

  div.appendChild(speaker);
  div.appendChild(renderAnswerWithCitations(utterance.text, utterance.citations || [], runId));
  return div;
}

// Renders an episode: player, download, transcript. ONE function for both the just-generated case
// and the reopened-notebook case, so a persisted episode can never render differently from a fresh
// one — the shape the podcast was missing before it was persisted at all.
//
// `audioSrc` is a URL on this server (`GET .../audio/file`), not an object URL: the browser can
// range-request it, so seeking in a long episode doesn't re-download it, and reopening a notebook
// costs no re-synthesis. The `cacheBust` token is what makes REGENERATING visible — the path is
// stable per notebook, so without it the browser would keep serving the previous episode.
function renderPodcast(body, { utterances, runId, audioSrc, stale, suffix, offsets }) {
  body.innerHTML = "";

  if (stale) {
    const note = document.createElement("div");
    note.className = "chat-overview-head";
    note.textContent = t("podcast.stale", "Podcast · sources have changed since this");
    body.appendChild(note);
  }

  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "none"; // don't pull a multi-MB episode on every notebook open
  player.src = audioSrc;
  body.appendChild(player);

  const download = document.createElement("a");
  download.className = "btn podcast-download";
  download.href = audioSrc;
  // A model-authored title reaches a filename here, so it is slugged rather than interpolated:
  // `download` is an attribute the browser turns into a path component.
  const stem = (state.title || state.notebookId || "notebook")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // The extension follows the SERVED file, not a hardcoded guess: chatterbox writes WAV and edge-tts
  // writes MP3, so naming the download `.mp3` unconditionally would mislabel half of them. An audit
  // found this listed among invariant 43's "handled" consequences when it was not.
  const ext = (suffix || "").replace(/^\./, "");
  download.download = ext ? `${stem || "notebook"}.${ext}` : stem || "notebook";
  download.textContent = ext
    ? t("podcast.download", `\u2913 Download ${ext}`, { ext })
    : t("podcast.downloadPlain", "\u2913 Download audio");
  body.appendChild(download);

  if (runId) body.appendChild(renderTickerAffordance(runId));

  const transcript = document.createElement("div");
  transcript.className = "podcast-transcript";

  // Timing is usable only when there is exactly one offset per utterance AND the offsets actually
  // advance. The length check alone is not enough: a provider that reports no boundaries at all
  // yields `[0.0, 0.0, ...]`, which is the RIGHT LENGTH and would stamp every line `0:00`, highlight
  // the second row for the whole episode and seek every click to zero (an independent review
  // simulated exactly that). A persisted episode from before offsets existed has none and falls
  // back here too — mis-aligned subtitles are worse than none, and `schema.Podcast.offsets` says so.
  const timed =
    Array.isArray(offsets) &&
    offsets.length === utterances.length &&
    offsets.every((v, i) => Number.isFinite(v) && v >= 0 && (i === 0 || v > offsets[i - 1]));
  const seek = (seconds) => {
    // `seconds`, not `t`. This parameter was RENAMED from `t` to stop it shadowing the i18n
    // function (an independent review found three such closures and warned that adding a
    // translated string inside one would throw) — and the body was not renamed with it, so every
    // seek assigned the i18n FUNCTION to `currentTime`, coerced to NaN, and did nothing. Clicking a
    // timecode silently stopped working, reported by a user.
    player.currentTime = seconds;
    // The play promise rejects when the media cannot start (the persisted file was cleared and
    // `audio/file` 404s, or autoplay policy blocks it). Seeking still worked; swallow it rather
    // than leaving an unhandled rejection in the console.
    const played = player.play();
    if (played && typeof played.catch === "function") played.catch(() => {});
  };
  const rows = utterances.map((u, i) => {
    const row = renderPodcastUtterance(u, runId, {
      start: timed ? offsets[i] : null,
      onSeek: timed ? seek : null,
    });
    transcript.appendChild(row);
    return row;
  });
  body.appendChild(transcript);

  if (!timed) return;
  // Only a timed transcript becomes its own scroll box; an untimed one has nothing following it and
  // reads better inline.
  transcript.classList.add("is-timed");

  // Subtitle behaviour: the line whose window contains the playhead is current. `timeupdate` fires
  // ~4x a second, so this runs often — it does an O(n) scan over a transcript of a few dozen lines
  // and touches the DOM only when the index actually changes.
  let current = -1;
  player.addEventListener("timeupdate", () => {
    const t = player.currentTime;
    let index = -1;
    for (let i = 0; i < offsets.length; i += 1) {
      if (offsets[i] <= t) index = i;
      else break;
    }
    if (index === current) return;
    if (rows[current]) rows[current].classList.remove("is-speaking");
    current = index;
    const row = rows[current];
    if (!row) return;
    row.classList.add("is-speaking");
    // Scroll the transcript's OWN box (it has `overflow-y: auto`), never `scrollIntoView` — that
    // walks EVERY scrollable ancestor, so a listener who had scrolled the studio column away to
    // read something else got dragged back to the podcast panel every few seconds. Measured with
    // rects rather than `offsetTop`, which is relative to whatever the offsetParent happens to be
    // and would silently mis-scroll if this box ever stops being positioned. Only move when the
    // line is actually outside the box.
    const rowBox = row.getBoundingClientRect();
    const viewBox = transcript.getBoundingClientRect();
    if (rowBox.top < viewBox.top) {
      transcript.scrollTop -= viewBox.top - rowBox.top;
    } else if (rowBox.bottom > viewBox.bottom) {
      transcript.scrollTop += rowBox.bottom - viewBox.bottom;
    }
  });
}

//: The reader's last choice, remembered across reloads. `localStorage` rather than a server
//: setting: it is a per-listen preference, not a property of the notebook, and the settings page is
//: deliberately narrow (invariant 41).
const PODCAST_LENGTH_KEY = "rlmnb-podcast-length";
const PODCAST_LENGTHS = new Set(["short", "default", "long"]);

function podcastLength() {
  const stored = localStorage.getItem(PODCAST_LENGTH_KEY);
  return PODCAST_LENGTHS.has(stored) ? stored : "default";
}

function initPodcastPlayer() {
  const generateBtn = document.getElementById("podcast-generate");
  const body = document.getElementById("podcast-body");

  const lengthOpts = [...document.querySelectorAll(".podcast-length .length-opt")];
  const paintLength = () => {
    const current = podcastLength();
    lengthOpts.forEach((opt) => opt.classList.toggle("is-active", opt.dataset.length === current));
  };
  lengthOpts.forEach((opt) => {
    opt.addEventListener("click", () => {
      localStorage.setItem(PODCAST_LENGTH_KEY, opt.dataset.length);
      paintLength();
    });
  });
  paintLength();

  // No object-URL bookkeeping any more: the audio is a real URL on this server, so there is nothing
  // to revoke and no revocation ORDER to get right (blueprint P2.6's fix is moot rather than wrong).
  function clearPlayer() {
    body.innerHTML = "";
  }

  // THREE states, the same shape the chat overview already has (invariant 38): never generated ->
  // an offer; generated -> the episode, with regeneration a quieter second action; generated but
  // STALE -> the episode, marked, and the same regenerate button reading as the obvious next move.
  // It used to be one permanent primary button sitting above a player that already existed, which
  // put the most prominent control in the panel on the one action a reader with an episode is least
  // likely to want — and made "have I already made one?" a question the button could not answer.
  function syncGenerateButton() {
    const podcast = state.podcast;
    if (!podcast) {
      generateBtn.textContent = t("podcast.generate", "Generate podcast");
      generateBtn.className = "btn btn-primary btn-block";
      return;
    }
    generateBtn.textContent = podcast.stale
      ? t("podcast.regenerateStale", "\u21bb Regenerate \u00b7 sources have changed")
      : t("podcast.regenerate", "\u21bb Regenerate podcast");
    // Secondary once an episode exists: regenerating costs a full model run plus synthesis
    // (invariant 43), so it must not be the loudest thing on a panel that already has what it makes.
    generateBtn.className = "btn btn-block";
  }

  // A persisted episode renders on open, which is the whole point of persisting it.
  store.on("notebook:switched", () => {
    clearPlayer();
    syncGenerateButton();
    const podcast = state.podcast;
    if (!podcast || !state.notebookId) return;
    renderPodcast(body, {
      utterances: podcast.utterances,
      runId: podcast.run_id,
      audioSrc: `/notebooks/${encodeURIComponent(state.notebookId)}/audio/file`,
      suffix: podcast.audio_suffix,
      offsets: podcast.offsets,
      stale: podcast.stale,
    });
  });

  // Adding or removing a source flips `podcast.stale` server-side, and the button's LABEL carries
  // that verdict — so it has to follow. Only the button: re-rendering the panel would rebuild its
  // `<audio>` and interrupt playback, which is the same reason `renumberStrokes` re-stamps rather
  // than re-renders. The stale marker inside the player catches up on the next open.
  store.on("sources:changed", () => syncGenerateButton());

  generateBtn.addEventListener("click", async () => {
    if (!state.notebookId) {
      alert(t("err.openNotebookFirst", "Open or name a notebook first."));
      return;
    }
    generateBtn.disabled = true;
    ensureTitle();
    const generation = notebookGeneration;
    const token = crypto.randomUUID();
    const runId = `${state.notebookSlug || state.notebookId}-${token}`;
    body.classList.add("is-pending");
    body.innerHTML = "";
    let cancelled = false;
    const status = runStatus({
      notebookId: state.notebookId,
      runIds: [runId],
      label: t("podcast.writing", "Writing the script\u2026"),
      onCancel: () => {
        cancelled = true;
        body.classList.remove("is-pending");
        clearPlayer();
        generateBtn.disabled = false;
      },
    });
    body.appendChild(status.node);
    // TWO phases, and only the FIRST is a traced, cancellable subprocess run. When the script run
    // ends the server starts synthesizing in-process (invariant 29) — no trace events, no way to
    // stop it, and up to fifteen minutes on the local provider (invariant 43). The label said
    // "Writing the script" for that whole second stretch, which is not what was happening.
    openTicker(state.notebookId, runId, (evt) => {
      status.onEvent(evt);
      // `done` ONLY, not every terminal kind: announcing a stage that will never start — and
      // greying out Stop — is worse than saying nothing while the HTTP error lands.
      if (evt.kind === "done") {
        status.setPhase(
          t("podcast.synthesizing", "Synthesizing the audio\u2026 (this stage cannot be stopped)"),
          { stoppable: false },
        );
      }
    });
    try {
      const data = await api(`/notebooks/${encodeURIComponent(state.notebookId)}/audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // See generateOverview: `fresh` exactly when this press is a REGENERATE.
        body: JSON.stringify({
          run_id: token,
          length: podcastLength(),
          fresh: Boolean(state.podcast),
        }),
      });
      status.finish();
      if (cancelled) return;
      if (generation !== notebookGeneration) return;  // switched away — the old episode is not theirs
      body.classList.remove("is-pending");
      body.innerHTML = "";

      if (!data.utterances.length) {
        body.textContent = t("podcast.empty", "(no podcast script — the sources didn't produce enough to discuss)");
        return;
      }

      state.podcast = {
        utterances: data.utterances,
        run_id: runId,
        offsets: data.offsets,
        stale: false,
      };
      renderPodcast(body, {
        utterances: data.utterances,
        runId,
        // Cache-busted: the path is stable per notebook, so without this the browser would keep
        // serving the episode it already has and "Regenerate" would look like it did nothing.
        audioSrc: `/notebooks/${encodeURIComponent(state.notebookId)}/audio/file?v=${token}`,
        stale: false,
        suffix: data.audio_suffix,
        offsets: data.offsets,
      });
      // The panel now HAS an episode, so the button stops offering to make one.
      syncGenerateButton();
    } catch (err) {
      status.finish();
      if (cancelled) return;
      body.classList.remove("is-pending");
      body.innerHTML = "";
      body.textContent = t("err.generic", `(error) ${err.message}`, { message: err.message });
    } finally {
      generateBtn.disabled = false;
    }
  });

  // NO second `notebook:switched` subscriber here. There used to be one (`clearPlayer`), registered
  // AFTER the render handler above — and `store.emit` runs subscribers in registration order, so it
  // blanked the panel the render handler had just filled. A persisted episode therefore never
  // appeared on notebook open, which is the entire point of persisting it. The render handler
  // clears first itself.
}

// --- Notes section (Studio panel) ----------------------------------------------------------------
//
// NotebookLM's research-loop closing feature: a manual note, or a Chat answer saved as one
// (`addNote`, wired from `renderTurn`), can later be PROMOTED into a real, independently-
// citable source — the "read a source → note something → the note becomes a source → keep going"
// loop this project had no concept of at all before this. Built with createElement/textContent
// throughout, same discipline every other list in this file already follows — a note's `text` is
// user-authored (or copied from a model answer) and never assumed safe to treat as markup.

function renderNoteItem(note) {
  const li = document.createElement("li");
  li.className = "note-item";

  const text = document.createElement("div");
  text.className = "note-text";
  text.textContent = note.text;
  li.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "note-actions";

  const promoteBtn = document.createElement("button");
  promoteBtn.type = "button";
  promoteBtn.className = "btn note-promote";
  promoteBtn.textContent = t("notes.promote", "→ Promote to source");
  // `data-tip`, not the native `title`: this project's own tooltip is instant and styled, and the
  // native one's ~1s delay is what made hover help feel disconnected from the hover effect.
  promoteBtn.dataset.tip = t(
    "notes.promoteHelp",
    "Turn this note into a real source. Only then can a later question cite it — a note on its own "
    + "is just text, with no citations of its own.",
  );
  promoteBtn.addEventListener("click", async () => {
    promoteBtn.disabled = true;
    try {
      const notebook = await api(
        `/notebooks/${encodeURIComponent(state.notebookId)}/notes/${encodeURIComponent(note.id)}/promote`,
        { method: "POST" }
      );
      state.sources = notebook.sources;
      state.notes = notebook.notes;
      store.emit("sources:changed", { sources: state.sources });
      store.emit("notes:changed", { notes: state.notes });
    } catch (err) {
      alert(t("err.promoteNote", `Could not promote note: ${err.message}`, { message: err.message }));
      promoteBtn.disabled = false;
    }
  });
  actions.appendChild(promoteBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn note-delete";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    try {
      const notebook = await api(
        `/notebooks/${encodeURIComponent(state.notebookId)}/notes/${encodeURIComponent(note.id)}`,
        { method: "DELETE" }
      );
      state.notes = notebook.notes;
      store.emit("notes:changed", { notes: state.notes });
    } catch (err) {
      alert(t("err.deleteNote", `Could not delete note: ${err.message}`, { message: err.message }));
      deleteBtn.disabled = false;
    }
  });
  actions.appendChild(deleteBtn);

  li.appendChild(actions);
  return li;
}

async function addNote(text) {
  if (!state.notebookId) return;
  try {
    const notebook = await api(`/notebooks/${encodeURIComponent(state.notebookId)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    state.notes = notebook.notes;
    store.emit("notes:changed", { notes: state.notes });
  } catch (err) {
    alert(t("err.saveNote", `Could not save note: ${err.message}`, { message: err.message }));
  }
}

function initNotesPanel() {
  const form = document.getElementById("add-note-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.notebookId) {
      alert(t("err.openNotebookFirst", "Open or name a notebook first."));
      return;
    }
    const input = document.getElementById("note-text");
    const value = input.value.trim();
    if (!value) return;
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await addNote(value);
      input.value = "";
    } finally {
      submitBtn.disabled = false;
    }
  });

  store.on("notes:changed", ({ notes }) => {
    const list = document.getElementById("note-list");
    const empty = document.getElementById("notes-empty");
    list.innerHTML = "";
    notes.forEach((note) => list.appendChild(renderNoteItem(note)));
    empty.hidden = notes.length > 0;
  });
}

// --- Studio rail: four views behind one switcher, collapsible ------------------------------------
//
// It used to be three sections stacked in one scrolling column, each with its own heading and body.
// A notebook with a generated guide, an episode and a few notes became a column nobody could find
// anything in — and there was nowhere to put a fourth thing. Views also give References a home.

const STUDIO_VIEW_KEY = "rlmnb-studio-view";
const STUDIO_COLLAPSED_KEY = "rlmnb-studio-collapsed";
const STUDIO_WIDTH_KEY = "rlmnb-studio-width";

//: The panel's size limits. Below `STUDIO_COLLAPSE_AT` a drag means "put it away" rather than "make
//: it very narrow" — a 90px panel is useless, so snapping to the icon rail is what the gesture
//: actually meant.
const STUDIO_MIN_WIDTH = 240;
const STUDIO_MAX_WIDTH = 720;
const STUDIO_COLLAPSE_AT = 170;
//: HYSTERESIS, and the ORDER is the whole point: a two-state toggle driven by one continuous value
//: is stable only while the "open" threshold is at or above the "close" one. An earlier attempt put
//: it BELOW (expand at 90, collapse at 170) to make re-opening from the rail cheap, which turned
//: 90–170 into a band where every single pointermove flipped the state — the panel visibly
//: shuddering between two widths. Expanding at exactly the minimum width is the value that both
//: satisfies the ordering AND opens the panel with no jump at all: at the crossing the pointer and
//: the panel are the same number. The dead band [170, 240) is then precisely the range the panel
//: could not have honoured anyway, and `--studio-rail` below keeps it from feeling dead.
const STUDIO_EXPAND_AT = STUDIO_MIN_WIDTH;
//: 2.9rem, the collapsed track in `style.css`. Repeated here because JS has to clamp against it.
const STUDIO_RAIL_WIDTH = 46;

function initStudioRail() {
  const col = document.getElementById("col-studio");
  const tabs = [...document.querySelectorAll(".studio-view-tab")];
  const bodies = [...document.querySelectorAll("[data-view-body]")];

  function show(view) {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view));
    bodies.forEach((viewBody) => {
      viewBody.hidden = viewBody.dataset.viewBody !== view;
    });
    localStorage.setItem(STUDIO_VIEW_KEY, view);
    // Expanding on selection: picking a view while collapsed can only mean "show me that".
    setCollapsed(false);
    if (view === "references") renderReferenceView();
  }

  // No separate collapse BUTTON any more: the grip resizes and collapses, and a second control for
  // the same thing was eating the width the four labels needed — they were truncating to one
  // character each.
  function setCollapsed(value) {
    // Only on an actual CHANGE: `pointermove` calls this on every event, and an unconditional
    // synchronous `localStorage` write there is 60-120 writes a second during a drag.
    if (col.classList.contains("is-collapsed") === value) return;
    col.classList.toggle("is-collapsed", value);
    localStorage.setItem(STUDIO_COLLAPSED_KEY, value ? "1" : "");
  }

  // APPLYING a width and REMEMBERING one are deliberately separate. Persisting on every pointermove
  // is what made dragging the panel away overwrite the user's own width with the 240px clamp; the
  // previous fix for that (skip `setWidth` below the minimum) then left the CSS variable holding a
  // stale width, so re-opening snapped to the OLD size before catching up to the pointer — the
  // "彈回前一次設置的寬度再快速閃現" half of the report. A drag now always follows the pointer and
  // only commits when it ends.
  let appliedWidth = STUDIO_MIN_WIDTH;

  function applyWidth(px) {
    appliedWidth = Math.min(STUDIO_MAX_WIDTH, Math.max(STUDIO_MIN_WIDTH, px));
    document.documentElement.style.setProperty("--studio-width", `${appliedWidth}px`);
    return appliedWidth;
  }

  function rememberWidth() {
    localStorage.setItem(STUDIO_WIDTH_KEY, String(appliedWidth));
  }

  // Drag the edge to size the panel; drag it past the threshold to put it away. `setPointerCapture`
  // is what keeps the drag alive when the cursor outruns the 6px handle, which it always does.
  const handle = document.getElementById("studio-resize");
  let dragging = false;
  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");  // suppress the width transition and text selection
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    // The panel is on the RIGHT, so its width grows as the pointer moves left.
    const width = window.innerWidth - event.clientX;
    const collapsed = col.classList.contains("is-collapsed");
    if (width < (collapsed ? STUDIO_EXPAND_AT : STUDIO_COLLAPSE_AT)) {
      setCollapsed(true);
      // The panel cannot open below its minimum, but the HANDLE can still follow you: the rail
      // stretches under the pointer through the dead band, so pulling always does something
      // visible. Without it the ordering above costs ~194px of motionless drag before the panel
      // opens, which is the "卡住" this replaced.
      const rail = Math.min(STUDIO_MIN_WIDTH, Math.max(STUDIO_RAIL_WIDTH, width));
      document.documentElement.style.setProperty("--studio-rail", `${rail}px`);
      return;
    }
    setCollapsed(false);
    document.documentElement.style.removeProperty("--studio-rail");
    applyWidth(width);
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // the pointer was already gone; nothing to release
    }
    document.body.classList.remove("is-resizing");
    // The stretch is a drag affordance, never a persisted size.
    document.documentElement.style.removeProperty("--studio-rail");
    // Only a drag that ended OPEN was the user choosing a width. One that ended collapsed passed
    // through the clamp on its way out, and committing that would lose the size they had picked.
    if (!col.classList.contains("is-collapsed")) rememberWidth();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  // Double-click the grip toggles, the shortcut every resizable panel has.
  handle.addEventListener("dblclick", () => setCollapsed(!col.classList.contains("is-collapsed")));
  // Keyboard: the handle is focusable, so it has to be operable without a pointer.
  handle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // Ignored while collapsed: the collapsed track reads `--studio-rail`, not `--studio-width`,
      // so this used to walk the REMEMBERED width down to the 240 clamp with nothing moving on
      // screen — and re-opening then landed at 240 instead of the size the user had chosen.
      // `endDrag` already has the equivalent guard.
      if (col.classList.contains("is-collapsed")) return;
      // No drag to end, so a key press commits immediately.
      applyWidth(appliedWidth + (event.key === "ArrowLeft" ? 24 : -24));
      rememberWidth();
    } else if (event.key === "Enter" || event.key === " ") {
      setCollapsed(!col.classList.contains("is-collapsed"));
    } else return;
    event.preventDefault();
  });

  tabs.forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.view)));

  applyWidth(parseInt(localStorage.getItem(STUDIO_WIDTH_KEY) || "340", 10));
  const stored = localStorage.getItem(STUDIO_VIEW_KEY);
  show(tabs.some((tab) => tab.dataset.view === stored) ? stored : "studio");
  // AFTER `show`, which expands on purpose — restoring a collapsed panel must win over that.
  setCollapsed(localStorage.getItem(STUDIO_COLLAPSED_KEY) === "1");

  // A reference is only interesting while it exists; both of these change what there is to show.
  store.on("chat:turnAdded", () => renderReferenceView());
  store.on("sources:changed", () => renderReferenceView());
  window.addEventListener("ui-lang-changed", () => renderReferenceView());
}

function showStudioView(view) {
  const tab = document.querySelector(`.studio-view-tab[data-view="${view}"]`);
  if (tab) tab.click();
}

// Every passage cited ANYWHERE in this notebook, deduplicated and numbered — the thing a reader
// wants when they are checking work rather than reading it. Collected from the turns and the
// overview, which is everything the client holds that carries citations.
function collectReferences() {
  const byCoordinate = new Map();
  const add = (citation) => {
    const key = referenceKey(citation);
    const existing = byCoordinate.get(key);
    if (!existing) {
      byCoordinate.set(key, { ...citation, quotes: citation.quote ? [citation.quote] : [], uses: 1 });
      return;
    }
    existing.uses += 1;
    if (citation.quote && !existing.quotes.includes(citation.quote)) existing.quotes.push(citation.quote);
    existing.verified = existing.verified && citation.verified;
  };
  (state.overview?.citations || []).forEach(add);
  (state.turns || []).forEach((turn) => (turn.citations || []).forEach(add));
  // Every OTHER surface that renders a clickable citation has to be here too, or clicking one
  // opens a list that cannot contain it — see `state.guides`.
  (state.podcast?.utterances || []).forEach((u) => (u.citations || []).forEach(add));
  Object.values(state.guides || {}).forEach(({ result }) => {
    if (!result) return;
    (result.citations || []).forEach(add);                                   // summary / insight
    (result.items || []).forEach((item) => (item.citations || []).forEach(add));       // faq
    (result.events || []).forEach((event) => (event.citations || []).forEach(add));    // timeline
  });
  return [...byCoordinate.values()];
}

// The References view is built from a snapshot of `state`, so anything that ADDS a citation has to
// ask for a rebuild. Cheap and idempotent; a no-op when the reader is looking at another view.
// Re-stamp every stroke ON THE PAGE from the current notebook-wide order. `collectReferences`
// orders overview -> turns -> podcast -> guides, so adding one chat turn shifts the number of every
// podcast and guide coordinate — and those panels do not re-render. An independent review measured
// a podcast stroke still saying 1 while the panel called that coordinate 2.
//
// Re-stamping rather than re-rendering, deliberately: re-rendering the podcast rebuilds its
// `<audio>` and would interrupt playback, and it is the NUMBER that went stale, nothing else.
function renumberStrokes() {
  const order = new Map(collectReferences().map((ref, i) => [referenceKey(ref), i + 1]));
  document.querySelectorAll(".citation[data-ref-key]").forEach((span) => {
    const n = order.get(span.dataset.refKey);
    // No attribute rather than "0": `content: attr(data-reference)` renders a literal 0, which is
    // the opposite of the "no number at all" the fallback claims.
    if (n) span.dataset.reference = String(n);
    else delete span.dataset.reference;
  });
}

function refreshReferenceView() {
  const host = document.getElementById("reference-view");
  if (host && !host.closest("[data-view-body]")?.hidden) renderReferenceView();
  // Every OTHER surface's strokes are numbered from the same order, and none of them re-renders.
  renumberStrokes();
}

//: The coordinate key, and the SEPARATOR is load-bearing. It used to be U+0000, which meant every
//: `[data-ref-key="…"]` selector built from it matched NOTHING: `CSS.escape` maps U+0000 to U+FFFD
//: by spec, and so does the CSS tokenizer when it parses a selector, so there is no spelling of that
//: selector that could ever match. The reciprocal highlight was dead on arrival and `focusReference`
//: had never once focused a card — found by an independent review measuring it in a real browser
//: rather than by reading. U+001F round-trips through `CSS.escape` and is just as impossible inside
//: a source id or a locator.
const REFERENCE_KEY_SEP = "\u001f";

function referenceKey(citation) {
  return `${citation.source_id}${REFERENCE_KEY_SEP}${citation.locator}`;
}

//: A source's HOST or kind, the small grey chip Kagi and Google both put beside a reference title
//: so a row's provenance reads at a glance without opening anything.
function referenceOrigin(source) {
  if (!source) return "";
  if (source.kind === "web" || source.kind === "youtube") {
    try {
      return new URL(source.origin).hostname.replace(/^www\./, "");
    } catch {
      return source.kind;
    }
  }
  return source.kind;
}

// Reciprocal highlight: pointing at a reference lights up the strokes it backs, and pointing at a
// stroke lights up its reference. The thing the user pointed at in Kagi's assistant — without it a
// numbered stroke and a numbered row are two lists the reader has to join up by eye.
function linkReference(key, on) {
  document
    .querySelectorAll(`.citation[data-ref-key="${CSS.escape(key)}"], .ref-card[data-ref-key="${CSS.escape(key)}"]`)
    .forEach((el) => el.classList.toggle("is-linked", on));
}

function renderReferenceView() {
  const host = document.getElementById("reference-view");
  const empty = document.getElementById("references-empty");
  if (!host) return;
  const references = collectReferences();
  host.textContent = "";
  empty.hidden = references.length > 0;

  references.forEach((reference, index) => {
    const source = (state.sources || []).find((s) => s.id === reference.source_id);
    const item = document.createElement("div");
    item.className = reference.verified ? "ref-card" : "ref-card is-unverified";
    item.dataset.refKey = referenceKey(reference);
    item.addEventListener("mouseenter", () => linkReference(item.dataset.refKey, true));
    item.addEventListener("mouseleave", () => linkReference(item.dataset.refKey, false));

    const head = document.createElement("button");
    head.type = "button";
    head.className = "ref-card-head";

    const number = document.createElement("span");
    number.className = "reference-number";
    number.textContent = String(index + 1);
    head.appendChild(number);

    // Title on the first line, provenance on the second — one ROW, not a card full of quotes. The
    // previous version rendered every quote as a full blockquote, always open, so a source cited
    // eight times filled the whole column and the list stopped being scannable at all.
    const main = document.createElement("span");
    main.className = "ref-card-main";

    const name = document.createElement("span");
    name.className = "ref-card-name";
    name.textContent = source ? sourceLabel(source) : reference.source_id;
    main.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "ref-card-meta";
    const origin = referenceOrigin(source);
    if (origin) {
      const chip = document.createElement("span");
      chip.className = "ref-card-chip";
      chip.textContent = origin;
      meta.appendChild(chip);
    }
    if (reference.locator && reference.locator !== "whole") {
      const locator = document.createElement("span");
      locator.className = "reference-locator";
      locator.textContent = reference.locator;
      meta.appendChild(locator);
    }
    // NOTE the locator above is model output and can be arbitrarily long. A run was observed
    // writing a whole section heading into it, which stretched this flex row until the rest of the
    // meta line was pushed out of the card — the "broken render" half of the same report the
    // pre-SUBMIT coordinate check now prevents at the source. `.reference-locator` clamps it, so a
    // future bad value is ugly in one chip instead of destroying the row.
    const uses = document.createElement("span");
    uses.className = "ref-card-uses";
    uses.textContent = t("references.uses", `${reference.uses}\u00d7`, { n: reference.uses });
    meta.appendChild(uses);
    if (!reference.verified) {
      const badge = document.createElement("span");
      badge.className = "ref-card-unverified";
      badge.textContent = t("cite.unverifiedShort", "unverified");
      meta.appendChild(badge);
    }
    main.appendChild(meta);
    head.appendChild(main);

    const caret = document.createElement("span");
    caret.className = "ref-card-caret";
    caret.textContent = "\u203a";
    head.appendChild(caret);
    item.appendChild(head);

    // One clamped line of the passage, so a row says what it is without being opened. Kagi's
    // popover and Google's card both lead with a snippet for the same reason.
    if (reference.quotes.length) {
      const snippet = document.createElement("div");
      snippet.className = "ref-card-snippet";
      snippet.textContent = reference.quotes[0];
      item.appendChild(snippet);
    }

    const cardBody = document.createElement("div");
    cardBody.className = "ref-card-body";
    cardBody.hidden = true;

    // Opening the row reveals every passage cited from this coordinate, then the original text with
    // the relevant one highlighted — the whole loop, still inside this view rather than over the
    // page. `wanted` is the quote the reader actually clicked, when they arrived by clicking a
    // stroke: a source cited eight times has eight quotes here, and landing on the card without
    // being told WHICH one was meant is the "還是得自己點開並慢慢追" a user reported.
    const openCard = async (wanted) => {
      item.classList.add("is-open");
      cardBody.hidden = false;
      const target = reference.quotes.includes(wanted) ? wanted : reference.quotes[0] || null;
      if (cardBody.dataset.loaded) {
        markWantedQuote(cardBody, target);
        return;
      }
      cardBody.textContent = "";
      // An unverified reference explains ITSELF, here, in the one place a reader who wants to know
      // is already looking. The badge in the row above says only "unverified", which a user
      // reasonably asked the meaning of — and the answer matters, because it is narrow: the
      // COORDINATE could not be found (invariant 5 verifies coordinates, never faithfulness), so
      // the quote below may still be a perfectly good quote that was filed under the wrong address.
      if (!reference.verified) {
        const why = document.createElement("p");
        why.className = "ref-card-why";
        why.textContent = t(
          "cite.unverifiedWhy",
          "This citation points at a place that does not exist in this source, so we could not " +
            "check it. The passage below may still be accurate — what failed is the address, not " +
            "necessarily the claim.",
        );
        cardBody.appendChild(why);
        if (reference.reason) {
          const detail = document.createElement("p");
          detail.className = "ref-card-why-detail";
          detail.textContent = reference.reason;
          cardBody.appendChild(detail);
        }
      }
      reference.quotes.forEach((quote) => {
        const blockquote = document.createElement("blockquote");
        blockquote.className = "reference-quote";
        blockquote.dataset.quote = quote;
        blockquote.textContent = quote;
        cardBody.appendChild(blockquote);
      });
      const passage = document.createElement("div");
      passage.className = "ref-card-passage";
      passage.textContent = t("cite.loading", "Loading\u2026");
      cardBody.appendChild(passage);
      markWantedQuote(cardBody, target);
      try {
        const data = await api(
          `/notebooks/${encodeURIComponent(state.notebookId)}/sources/${encodeURIComponent(reference.source_id)}`
        );
        passage.textContent = "";
        passage.appendChild(renderSourceMeta(data));
        const blocks = (data.blocks || []).filter((block) => block.locator === reference.locator);
        // An unverified coordinate matches NO block, so filtering by it would render the source
        // meta and then nothing at all — the reader gets an empty box for the citation they most
        // wanted to inspect. Fall back to the whole source and let the quote highlight find itself.
        (blocks.length ? blocks : data.blocks || []).forEach((block) => {
          passage.appendChild(renderTextWithOptionalHighlight(block.text, target));
        });
        cardBody.dataset.loaded = "1";
      } catch (err) {
        passage.textContent = t("err.generic", `(error) ${err.message}`, { message: err.message });
      }
    };
    item._openCard = openCard;

    head.addEventListener("click", () => {
      if (!cardBody.hidden) {
        cardBody.hidden = true;
        item.classList.remove("is-open");
        return;
      }
      openCard(null);
    });

    item.appendChild(cardBody);
    host.appendChild(item);
  });
}

// Clicking a citation in the chat opens the References view and takes the reader to that entry,
// rather than expanding a panel inside the answer they are reading.
// Which of a card's quotes the reader asked about. A card is re-openable and already-loaded, so
// this is a separate re-stampable step rather than something decided while building the list.
function markWantedQuote(cardBody, quote) {
  cardBody.querySelectorAll(".reference-quote").forEach((el) => {
    el.classList.toggle("is-wanted", quote != null && el.dataset.quote === quote);
  });
}

function focusReference(citation) {
  showStudioView("references");
  const key = referenceKey(citation);
  const card = document.querySelector(`.ref-card[data-ref-key="${CSS.escape(key)}"]`);
  if (!card) return;
  // OPEN it, rather than only scrolling to it. Arriving at a collapsed row still left the reader
  // to click it and then work out which of its quotes was theirs.
  if (card._openCard) card._openCard(citation.quote || null);
  document.querySelectorAll(".ref-card.is-focused, .citation.is-focused")
    .forEach((el) => el.classList.remove("is-focused"));
  card.classList.add("is-focused");
  // ...and every stroke pointing at the SAME coordinate lights up with it. `.citation.is-focused`
  // has always existed in the stylesheet promising exactly this; nothing ever set it.
  document.querySelectorAll(`.citation[data-ref-key="${CSS.escape(key)}"]`)
    .forEach((el) => el.classList.add("is-focused"));
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// --- Boot -------------------------------------------------------------------------------------

// Static markup FIRST, before any panel renders: every `init*` below writes copy of its own, and a
// panel that rendered against the English strings would keep them until something re-rendered it.
document.documentElement.lang = uiLang();
applyStaticI18n();

// A language change re-applies the static markup (in `setUiLang`) and re-renders every panel that
// holds generated copy. Cheaper and far less error-prone than threading a language argument through
// each renderer — and it means a renderer added later is translated by construction rather than by
// somebody remembering to subscribe.
window.addEventListener("ui-lang-changed", () => {
  renderChatOverview();
  store.emit("sources:changed", { sources: state.sources });
  store.emit("notes:changed", { notes: state.notes });
  const settingsOverlay = document.getElementById("settings-overlay");
  if (settingsOverlay && !settingsOverlay.hidden) {
    document.getElementById("settings-open").click();
  }
});

initTheme();
initSettings();
initNotebookTitle();
initNotebookSwitch();
initSourcesPanel();
initChatPanel();
initStudioPanel();
initPodcastPlayer();
initSourceViewer();
initNotesPanel();
initStudioRail();

// --- Trajectory drawer ---------------------------------------------------------------------------
//
// A bottom sheet that replays one RLM run: a sibling project's own shape, brought here
// because the inline step log put the planner's own reasoning PROSE inside the chat bubble, where a
// user reported it as unreadable and space-consuming ("文鄒鄒的看不懂"). Reasoning belongs somewhere
// a reader opts into, not in the middle of the answer they came for.
//
// TWO views on the run's two clocks (`trajectory.py` explains why they are different): the left nav
// walks the planner's REPL turns, the top strip is the tool timeline where segment width is
// proportional to real elapsed time — so a slow call is visibly wide rather than a number to
// compare. Works on a RUNNING trace as well as a finished one, which is the point for a `long`
// podcast that takes minutes.

const TRAJ_SPEEDS = [1, 2, 4, 8, 16, 32, 64];
const TRAJ_DWELL_FLOOR_MS = 50;    // a stop never dwells less than this, so a tiny turn still shows
const TRAJ_NOMINAL_MS = 1500;      // a stop with no live timing gets a brief nominal length

let trajData = null;      // the fetched decomposition
let trajRunIds = [];      // every run id this drawer was opened for (an overview fires two)
let trajSel = null;       // {kind: "init"|"turn"|"tool", index}
let trajSpeed = 2;
let trajPlayTimer = null;
let trajPoll = null;      // while the run is live, re-fetch so the drawer keeps up
let trajMatches = [];
let trajMatchCur = -1;
let trajCloseTimer = null;

const trajEl = {};

function trajInit() {
  [
    "backdrop", "drawer", "name", "stat", "run", "note", "budget", "timeline", "axis-end", "search",
    "search-count", "prev", "play", "next", "speed", "steps", "detail", "expand", "close",
    "progress",
  ].forEach((name) => {
    trajEl[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = document.getElementById(`traj-${name}`);
  });
  if (!trajEl.drawer) return;
  trajEl.close.addEventListener("click", closeTrajectory);
  trajEl.backdrop.addEventListener("click", closeTrajectory);
  trajEl.expand.addEventListener("click", () => {
    const full = trajEl.drawer.classList.toggle("is-full");
    trajEl.expand.textContent = full ? "⤡" : "⤢";
  });
  trajEl.prev.addEventListener("click", () => trajStep(-1));
  trajEl.next.addEventListener("click", () => trajStep(1));
  trajEl.play.addEventListener("click", trajTogglePlay);
  trajEl.speed.addEventListener("click", () => {
    trajSpeed = TRAJ_SPEEDS[(TRAJ_SPEEDS.indexOf(trajSpeed) + 1) % TRAJ_SPEEDS.length];
    trajEl.speed.textContent = `${trajSpeed}×`;
  });
  trajEl.run.addEventListener("change", () => openTrajectory(trajRunIds, trajEl.run.value));
  trajEl.search.addEventListener("input", () => trajSearch(trajEl.search.value));
  trajEl.search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") trajCycleMatch();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !trajEl.drawer.hidden) closeTrajectory();
  });
}

async function openTrajectory(runIds, wanted) {
  if (!trajEl.drawer || !state.notebookId) return;
  trajRunIds = (runIds || []).filter(Boolean);
  const runId = wanted || trajRunIds[0];
  if (!runId) return;
  try {
    trajData = await api(
      `/notebooks/${encodeURIComponent(state.notebookId)}/runs/${encodeURIComponent(runId)}/trajectory`
    );
  } catch (err) {
    // A trace is only as durable as retention keeps it (invariant 34). Losing one must degrade
    // THIS affordance, never the page.
    //
    // TWO situations, and they want opposite things. Opening the drawer from a steps pill on a run
    // with no trace should NOT open it at all: a transport, a search box and an empty timeline
    // wrapped around one sentence reads as a broken drawer rather than a missing trace, and the
    // reader asked for a trajectory that does not exist. Say so the way every other unfulfillable
    // click here does — `alert`, as rename/save-settings/add-source already use — and leave the
    // page alone. But SWITCHING runs inside an already-open drawer cannot close it under the
    // reader, so that one clears every pane instead; leaving them would show the previous run's
    // task, notes and timeline beside a "no trajectory" line, reading as facts about this one.
    trajData = null;
    const message = t("traj.missing", `No trajectory for this run (${err.message})`, {
      message: err.message,
    });
    if (trajEl.drawer.hidden) {
      alert(message);
      return;
    }
    trajEl.stat.textContent = message;
    trajEl.steps.textContent = "";
    trajEl.detail.textContent = "";
    trajEl.timeline.textContent = "";
    trajEl.name.textContent = "";
    trajEl.axisEnd.textContent = "";
    trajEl.note.textContent = "";
    trajEl.note.hidden = true;
    if (trajEl.budget) {
      trajEl.budget.textContent = "";
      trajEl.budget.hidden = true;
    }
  }
  // A drawer left open on a run with no trajectory does not need 80vh for one line.
  trajEl.drawer.classList.toggle("is-empty", !trajData);
  trajShowDrawer();
  if (trajData) renderTrajectory(runId);
}

function trajShowDrawer() {
  clearTimeout(trajCloseTimer);
  trajEl.backdrop.hidden = false;
  trajEl.drawer.hidden = false;
  // Flush the unhide before animating: coming from `display: none`, a transition has no start
  // frame and would jump straight to its end.
  void trajEl.drawer.offsetHeight;
  trajEl.backdrop.classList.add("is-shown");
  trajEl.drawer.classList.add("is-open");
}

function closeTrajectory() {
  trajStopPlay();
  clearInterval(trajPoll);
  trajPoll = null;
  trajEl.drawer.classList.remove("is-open", "is-full");
  trajEl.backdrop.classList.remove("is-shown");
  trajEl.expand.textContent = "⤢";
  // ≥ the drawer's own transform transition, so the slide-out is never cut short by `hidden`.
  trajCloseTimer = setTimeout(() => {
    trajEl.drawer.hidden = true;
    trajEl.backdrop.hidden = true;
  }, 280);
}

//: Family colour + glyph per timeline segment. `--fam` is what the `.seg` rules tint themselves
//: from, so one assignment drives border, background, hover and the current-state ring together.
//: A segment never narrows past this, whatever its share of the run — the strip scrolls instead.
//: Squashing every call into a sliver is what made the first version unreadable.
const TRAJ_SEG_MIN_PX = 108;

const TRAJ_FAMILIES = {
  skill: { color: "var(--accent)", glyph: "\u25a4" },
  validate: { color: "var(--ok)", glyph: "\u2713" },
  lifeline: { color: "var(--warn)", glyph: "\u21d7" },
};

//: Chip labels for `run_start`'s meta. A raw key is the wire format, not a name a reader chose —
//: and `source_chars` in particular means nothing until it says what it counts.
const TRAJ_META_LABELS = {
  main_model: "planner",
  sub_model: "sub-LM",
  max_iterations: "max turns",
  max_tokens: "max tokens",
  max_retries: "retries",
  source_chars: "corpus chars",
  output_language: "language",
  language: "language",   // `naming.SuggestTitle` names it this way
  target_length: "length",
  question: "question",
  accept_language: "Accept-Language",
  interface_language: "interface",
};

function trajFamily(entry) {
  if (entry.ok === false || entry.passed === false) return { color: "var(--bad)", glyph: "\u2715" };
  return TRAJ_FAMILIES[entry.label] || { color: "var(--text-dim)", glyph: "\u25c6" };
}

// The generation caps the run actually ran under, and what it used against them. Built with
// createElement/textContent like every other model-adjacent string here (invariants 29 and 55).
//
// THREE states, and the third is the one that matters: `budget === null` means the trace predates
// rlm-harness 1.10.0 and simply does not carry the fields. That must read "not recorded" and never
// "no truncation" — reading an absent field as a zero is how a corpus boundary gets mistaken for a
// property of the code (CHANGELOG.md forbids averaging any rate across that upgrade).
function renderTrajBudget(budget) {
  if (!trajEl.budget) return;
  trajEl.budget.textContent = "";
  const tag = document.createElement("span");
  tag.className = "note-tag";
  const body = document.createElement("span");
  body.className = "note-body";
  let tone;

  if (!budget) {
    tag.textContent = t("traj.budgetTagNone", "\u24d8 budget");
    body.textContent = t(
      "traj.budgetNone",
      "Token budgets aren't recorded for this trace \u2014 it predates the field. Not the same as \"nothing was truncated\".",
    );
    tone = "is-info";
  } else if (budget.truncated) {
    tag.textContent = t("traj.budgetTagCut", "\u26a0 truncated");
    body.textContent = t(
      "traj.budgetCut",
      "A turn hit the generation cap: {used} tokens against a cap of {cap}. A truncated code cell is usually repaired by the planner's next turn; a truncated final answer ends the run.",
      { used: budget.peak_completion, cap: budget.cap },
    );
    tone = "is-cut";
  } else if (budget.cap != null && budget.peak_completion != null) {
    tag.textContent = t("traj.budgetTag", "\u25cf budget");
    body.textContent = t(
      "traj.budgetOk",
      "Busiest turn used {used} of {cap} tokens ({pct}%).",
      { used: budget.peak_completion, cap: budget.cap, pct: Math.round(budget.ratio * 100) },
    );
    tone = "is-live";
  } else if (budget.cap != null) {
    // A cap WITH no usage is its own state, not "no cap": not every provider returns a usage
    // block. Collapsing the two said a cap of 16384 had never been reported.
    tag.textContent = t("traj.budgetTagNone", "\u24d8 budget");
    body.textContent = t(
      "traj.budgetNoUsage",
      "The generation cap was {cap} tokens; this run recorded no token usage to compare against it.",
      { cap: budget.cap },
    );
    tone = "is-info";
  } else {
    tag.textContent = t("traj.budgetTagNone", "\u24d8 budget");
    body.textContent = t("traj.budgetPartial", "No generation cap was reported for this run.");
    tone = "is-info";
  }

  trajEl.budget.appendChild(tag);
  trajEl.budget.appendChild(body);

  // `dropped` means dspy rejected the budget kwargs outright and every cap reverted to its own
  // default — so the numbers above were NOT the ones applied. APPENDED, never a replacement: a run
  // can both hit the cap and have its step budgets rejected, and an earlier version overwrote the
  // truncation colour here, which is the one thing the colours exist to keep separable.
  if (budget && budget.iterations && budget.iterations.dropped) {
    const warn = document.createElement("span");
    warn.className = "note-body";
    warn.textContent = t(
      "traj.budgetDropped",
      "The step budgets were rejected and reverted to the library's defaults, so the configured caps did not apply.",
    );
    trajEl.budget.appendChild(warn);
    tone = tone === "is-cut" ? "is-cut" : "is-info";
  }
  trajEl.budget.className = `traj-note ${tone}`;
  trajEl.budget.hidden = false;
}

function renderTrajectory(runId) {
  const turns = trajData.iterations || [];
  const line = trajData.timeline || [];

  // The run's own NAME, not a slug: the reader started this action and knows it by what it makes.
  trajEl.name.textContent = trajTaskLabel(trajData.initial?.task);
  trajEl.stat.textContent = t(
    "traj.stat",
    `${turns.length} turns \u00b7 ${line.length} tool calls${
      trajData.total_s != null ? ` \u00b7 ${formatTimecode(trajData.total_s)}` : ""
    }`,
    { turns: turns.length, tools: line.length }
  );

  // The run picker only earns its space when there IS more than one — an overview fires a summary
  // run and an FAQ run, and landing in one with no way to reach the other is the same
  // "which one did I just watch" problem the notebook picker has.
  trajEl.run.hidden = trajRunIds.length < 2;
  trajEl.run.textContent = "";
  trajRunIds.forEach((id) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id.split("-").slice(-1)[0];
    option.selected = id === runId;
    trajEl.run.appendChild(option);
  });

  // Built from the BOOLEAN, not from the server's sentence. `timing_note` is English prose written
  // in `trajectory.py`, and rendering it verbatim put an English line in the middle of a Chinese
  // drawer — interface copy belongs to the interface (invariant 48), and the server's job here is
  // to say WHICH case holds.
  trajEl.note.hidden = false;
  trajEl.note.textContent = "";
  const tag = document.createElement("span");
  tag.className = "note-tag";
  tag.textContent = trajData.per_turn_timing
    ? t("traj.timingTag", "\u25cf per-turn timing")
    : t("traj.timingTagOff", "\u24d8 timing");
  const noteBody = document.createElement("span");
  noteBody.className = "note-body";
  noteBody.textContent = trajData.per_turn_timing
    ? t("traj.timingLive", "Per-turn timing is live \u2014 captured as each turn was parsed.")
    : t(
        "traj.timingStale",
        "Per-turn timing isn't available for this trace; the tool timeline still carries real times.",
      );
  trajEl.note.appendChild(tag);
  trajEl.note.appendChild(noteBody);
  trajEl.note.className = `traj-note ${trajData.per_turn_timing ? "is-live" : "is-info"}`;
  renderTrajBudget(trajData.budget);
  trajEl.axisEnd.textContent = trajData.total_s != null ? formatTimecode(trajData.total_s) : "";

  // A LIVE run re-renders every few seconds, so the rebuild must not throw away where the reader
  // is. Resetting unconditionally sent someone watching a long podcast back to "Start" with an
  // empty search box every 4 seconds — in the one case the live read exists to serve.
  const priorSel = trajSel;
  const priorQuery = trajEl.search.value;
  renderTrajTimeline(line, turns);
  renderTrajSteps(turns);
  trajSearch(priorQuery);
  const stillThere =
    priorSel &&
    (priorSel.kind === "init" ||
      (priorSel.kind === "turn" && priorSel.index < turns.length) ||
      (priorSel.kind === "tool" && priorSel.index < line.length));
  trajSelect(stillThere ? priorSel.kind : "init", stillThere ? priorSel.index : 0);
  trajRefreshTransport();

  clearInterval(trajPoll);
  trajPoll = trajData.running
    ? setInterval(() => {
        if (trajEl.drawer.hidden) return;
        openTrajectory(trajRunIds, runId);
      }, 4000)
    : null;
}

// `rlm_notebook.guide:GenerateSummary` -> `GenerateSummary`. The dotted path is how the worker is
// addressed, not what the reader asked for.
function trajTaskLabel(task) {
  if (!task) return "";
  return String(task).split(":").pop();
}

function renderTrajTimeline(line, turns) {
  trajEl.timeline.textContent = "";
  if (!line.length) {
    const empty = document.createElement("div");
    empty.className = "traj-empty";
    // Says WHICH empty it is (invariant 70): the model never called the pre-SUBMIT validator its
    // own instructions ask for. This used to appear on every run for a different reason — the
    // validator did not record a `tool_call` event at all — so an empty strip meant nothing.
    empty.textContent = t(
      "traj.noTools",
      "This run called no tools \u2014 including the validator its instructions ask it to run before SUBMIT.",
    );
    trajEl.timeline.appendChild(empty);
    return;
  }
  const total = line.reduce((sum, e) => sum + (e.duration_s || 0), 0) || 1;
  // **`flex-grow` must SUM to at least 1 or the strip does not fill.** CSS distributes free space
  // in proportion to the grow values and stops at their sum: four millisecond calls floored to
  // 0.01 each sum to 0.04, so 96% of the strip stayed empty (reported, with a screenshot).
  // Normalising by the total makes the sum exactly 1 — the free space is fully distributed and the
  // RATIOS between segments are unchanged, which is the half that has to survive.
  const weight = (entry) => Math.max(entry.duration_s || 0, 0.01);
  const weightTotal = line.reduce((sum, e) => sum + weight(e), 0) || 1;
  let markedTurn = -1;
  line.forEach((entry) => {
    // A "from here = Turn N" marker wherever the owning turn changes, so the strip and the nav are
    // one story rather than two lists to correlate by eye.
    if (entry.turn_index != null && entry.turn_index !== markedTurn) {
      markedTurn = entry.turn_index;
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "turn-mark";
      const markLabel = document.createElement("span");
      markLabel.className = "tm-lab";
      // `+ 1`, because every OTHER surface counts turns from one — the nav rail says "Turn 3" and
      // the detail head says "Turn 3" for the call this mark sits on. The trace data stays
      // 0-indexed; only the label is human. Without it the strip said T2 for what the two panes
      // beside it both called turn 3.
      markLabel.textContent = `T${entry.turn_index + 1}`;
      mark.appendChild(markLabel);
      const markArrow = document.createElement("span");
      markArrow.className = "tm-arrow";
      markArrow.textContent = "\u25b8";
      mark.appendChild(markArrow);
      mark.addEventListener("click", () => {
        trajStopPlay();
        trajSelect("turn", entry.turn_index);
      });
      trajEl.timeline.appendChild(mark);
    }

    const family = trajFamily(entry);
    const seg = document.createElement("button");
    seg.type = "button";
    seg.className = "seg";
    seg.style.setProperty("--fam", family.color);
    // `flex: <duration> 0 <floor>px`, which is the sibling's own sizing and the part a first pass
    // reimplemented from scratch and got wrong twice. GROW is what makes a run with one tool call
    // fill the strip instead of sitting at a fixed width beside empty space (reported), and the
    // basis is a floor so a fast call stays readable rather than collapsing to a sliver (also
    // reported, from the version before that, which grew against the strip's total with no basis).
    const dur = Math.max(entry.duration_s || 0, 0);
    const basis = Math.max(TRAJ_SEG_MIN_PX, Math.round((dur / total) * 720));
    seg.style.flex = `${(weight(entry) / weightTotal).toFixed(4)} 0 ${basis}px`;

    const icon = document.createElement("span");
    icon.className = "seg-ic";
    icon.textContent = family.glyph;
    seg.appendChild(icon);

    const label = document.createElement("span");
    label.className = "seg-lab";
    // The TARGET is the name a reader recognises — `corpus-navigation`, not `skill
    // corpus-navigation`. The family is already carried by the icon and the segment's own colour,
    // so repeating it in words is the redundancy a user asked about. It falls back to the family
    // for a call that has no target, and the tooltip keeps both.
    label.textContent = entry.target || entry.label;
    seg.appendChild(label);

    const durEl = document.createElement("span");
    durEl.className = "seg-dur";
    durEl.textContent = trajSecs(entry.duration_s);
    seg.appendChild(durEl);

    seg.addEventListener("click", () => {
      trajStopPlay();
      trajSelect("tool", entry.seq);
    });
    trajEl.timeline.appendChild(seg);
  });
}

function trajSecs(s) {
  if (s == null) return "";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  return s < 60 ? `${s.toFixed(1)}s` : formatTimecode(s);
}

function renderTrajSteps(turns) {
  trajEl.steps.textContent = "";
  trajEl.steps.appendChild(
    trajStepRow("init", 0, t("traj.init", "Init"), t("traj.initSub", "input + env"), null, 1)
  );
  const longest = turns.reduce((m, tn) => Math.max(m, tn.duration_s || 0), 0) || 1;
  turns.forEach((turn) => {
    trajEl.steps.appendChild(
      trajStepRow(
        "turn",
        turn.index,
        t("traj.turn", `Turn ${turn.index + 1}`, { n: turn.index + 1 }),
        turn.reasoning || turn.code || "",
        trajSecs(turn.duration_s),
        (turn.duration_s || 0) / longest
      )
    );
  });
}

function trajStepRow(kind, index, name, preview, duration, share) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tstep";
  row.dataset.kind = kind;
  row.dataset.index = String(index);

  const title = document.createElement("span");
  title.className = "tstep-name";
  title.textContent = name;
  row.appendChild(title);

  if (preview) {
    const line = document.createElement("span");
    line.className = "tstep-preview";
    line.textContent = preview;
    row.appendChild(line);
  }
  if (duration) {
    const dur = document.createElement("span");
    dur.className = "tstep-dur";
    dur.textContent = duration;
    row.appendChild(dur);
    // The bar is the point: a column of numbers makes the reader compare, a bar makes the slow turn
    // findable at a glance. Only where there IS a duration — an untimed trace gets no fake bars.
    const bar = document.createElement("span");
    bar.className = "tstep-bar";
    bar.style.width = `${Math.max(4, Math.round((share || 0) * 100))}%`;
    row.appendChild(bar);
  }

  row.addEventListener("click", () => {
    trajStopPlay();
    trajSelect(kind, index);
  });
  return row;
}

function trajSelect(kind, index) {
  trajSel = { kind, index };
  trajEl.steps.querySelectorAll(".tstep").forEach((row) => {
    row.classList.toggle(
      "is-current",
      row.dataset.kind === kind && Number(row.dataset.index) === index
    );
  });
  let seen = -1;
  trajEl.timeline.querySelectorAll(".seg").forEach((seg) => {
    seen += 1;
    seg.classList.toggle("is-current", kind === "tool" && seen === index);
  });
  const current = trajEl.steps.querySelector(".tstep.is-current");
  if (current) current.scrollIntoView({ block: "nearest" });
  renderTrajDetail();
}

function renderTrajDetail() {
  const host = trajEl.detail;
  host.textContent = "";
  if (!trajData || !trajSel) return;

  if (trajSel.kind === "init") {
    trajDetailHead(host, t("traj.initTitle", "Initial state"), t("traj.initSub", "input + env"));
    const chips = document.createElement("div");
    chips.className = "ini-chips";
    Object.entries((trajData.initial || {}).meta || {}).forEach(([key, value]) => {
      // `task` is already the drawer's headline. A chip repeating it is the whole reason this panel
      // read as empty when it was the only key there was.
      if (key === "task") return;
      const chip = document.createElement("span");
      chip.className = "ini-chip";
      const name = document.createElement("b");
      name.textContent = TRAJ_META_LABELS[key] || key;
      chip.appendChild(name);
      chip.appendChild(
        document.createTextNode(
          key === "source_chars" ? ` ${Number(value).toLocaleString()}` : ` ${value}`
        )
      );
      chips.appendChild(chip);
    });
    if (chips.children.length) {
      host.appendChild(chips);
    } else {
      // An empty panel reads as broken, so the empty STATE says which one this is. Two live causes,
      // and neither of them is "an old trace" — that was only the first one anybody hit:
      //
      //  - NOTHING WRITTEN YET. `_run_isolated` reserves `traces/{run_id}.jsonl` exclusively BEFORE
      //    spawning (invariant 29), and `run_trajectory` stops at a torn final line because the
      //    writer is mid-flush. So a run opened in its first moments, or one whose spawn failed, or
      //    one killed instantly, has a real file with zero events. `traces._is_ours` accepts an
      //    empty file for exactly this reason.
      //  - NO CONFIGURATION RECORDED. A trace written by an older build of this project, which
      //    stamped only `task`.
      //
      // An earlier wording named only the second and dated it, and a user asked what it meant;
      // deleting the old traces would have made it a sentence describing a cause nobody could hit
      // any more while the branch stayed reachable through the first.
      const note = document.createElement("div");
      note.className = "det-sub";
      note.textContent = trajData.started_at
        ? t("traj.noMeta", "No configuration was recorded for this run.")
        : t(
            "traj.notStarted",
            "Nothing has been recorded for this run yet \u2014 it may still be starting, or it " +
              "never got going.",
          );
      host.appendChild(note);
    }
    if (trajData.error) trajField(host, t("traj.error", "Error"), trajData.error);
    return;
  }

  if (trajSel.kind === "turn") {
    const turn = (trajData.iterations || [])[trajSel.index];
    if (!turn) return;
    trajDetailHead(
      host,
      t("traj.turn", `Turn ${turn.index + 1}`, { n: turn.index + 1 }),
      trajSecs(turn.duration_s)
    );
    if (turn.reasoning) {
      const reason = document.createElement("div");
      reason.className = "det-reason";
      reason.textContent = turn.reasoning;
      host.appendChild(reason);
    }
    trajField(host, t("traj.code", "Code"), turn.code);
    trajField(host, t("traj.output", "Output"), turn.output);
    return;
  }

  const entry = (trajData.timeline || [])[trajSel.index];
  if (!entry) return;
  // The facts a tooltip would have carried live HERE — a `.seg` clips its own tip and sits inside
  // an `overflow-x` scroller besides (invariant 54), and clicking one lands on this pane anyway.
  trajDetailHead(
    host,
    entry.target ? `${entry.label} \u00b7 ${entry.target}` : entry.label,
    [
      entry.rel_s != null ? `+${trajSecs(entry.rel_s)}` : "",
      trajSecs(entry.duration_s),
      entry.turn_index != null
        ? t("traj.turn", `Turn ${entry.turn_index + 1}`, { n: entry.turn_index + 1 })
        : "",
    ]
      .filter(Boolean)
      .join(" \u00b7 ")
  );
  if (entry.verdict) trajField(host, t("traj.verdict", "Verdict"), entry.verdict);
  if (entry.content) trajField(host, t("traj.result", "Result"), entry.content);
  if (entry.input) trajField(host, t("traj.input", "Input"), entry.input);
  if (entry.output) trajField(host, t("traj.output", "Output"), entry.output);
  if (entry.error) trajField(host, t("traj.error", "Error"), entry.error);
  Object.entries(entry.fields || {}).forEach(([key, value]) => trajField(host, key, String(value)));
  // A way BACK to the turn whose code made this call. The head already names it, and naming a turn
  // a reader then has to find in the nav by eye is the two-lists-to-correlate problem the strip's
  // own turn marks exist to remove. On EVERY attributed segment, not only a failed one: "why was
  // this called" is the same question whether or not it worked. Absent when the trace has no live
  // per-turn timing, since nothing is attributed then and a button reading "open turn null" is
  // worse than no button.
  if (entry.turn_index != null) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "btn det-jump";
    jump.textContent = t("traj.openTurn", `\u2191 Open turn ${entry.turn_index + 1}`, {
      n: entry.turn_index + 1,
    });
    jump.addEventListener("click", () => {
      trajStopPlay();
      trajSelect("turn", entry.turn_index);
    });
    host.appendChild(jump);
  }
}

function trajDetailHead(host, title, sub) {
  const head = document.createElement("div");
  head.className = "det-head";
  const h = document.createElement("h3");
  h.textContent = title;
  head.appendChild(h);
  if (sub) {
    const s = document.createElement("span");
    s.className = "det-sub";
    s.textContent = sub;
    head.appendChild(s);
  }
  host.appendChild(head);
}

function trajField(host, label, value) {
  if (value == null || value === "") return;
  const wrap = document.createElement("div");
  wrap.className = "det-field";
  const name = document.createElement("div");
  name.className = "det-field-name";
  name.textContent = label;
  wrap.appendChild(name);
  const body = document.createElement("div");
  // `textContent`, always — every string here came out of a model that has been reading source
  // content an attacker may have written (invariant 29's rule, at the surface it matters most).
  body.className = "det-field-body";
  body.textContent = value;
  wrap.appendChild(body);
  host.appendChild(wrap);
}

// ---- replay transport ----------------------------------------------------------------------
// Dwell on each stop for the time it REALLY took, divided by the speed — so watching at 1× is
// watching the run happen. A stop with no live timing gets a brief nominal length rather than
// being skipped, which would silently drop every turn of a finalize-flushed trace.

function trajStops() {
  return [{ kind: "init", index: 0 }].concat(
    (trajData?.iterations || []).map((turn) => ({ kind: "turn", index: turn.index }))
  );
}

function trajRealMs(stop) {
  if (stop.kind === "turn" && trajData?.per_turn_timing) {
    const turn = (trajData.iterations || [])[stop.index];
    return Math.max(0, (turn?.duration_s || 0) * 1000);
  }
  return TRAJ_NOMINAL_MS;
}

function trajStep(direction) {
  trajStopPlay();
  const stops = trajStops();
  // A TOOL selection is not a walkable stop, so stepping from one starts at its own turn — the
  // reader keeps moving through the run instead of being bounced back to the start.
  const from = trajSel && trajSel.kind === "tool"
    ? stops.findIndex((s) => s.kind === "turn" && s.index === trajToolTurn(trajSel.index))
    : stops.findIndex((s) => trajSel && s.kind === trajSel.kind && s.index === trajSel.index);
  const at = from < 0 ? 0 : from;
  const next = stops[Math.min(stops.length - 1, Math.max(0, at + direction))];
  if (next) trajSelect(next.kind, next.index);
}

function trajToolTurn(seq) {
  const entry = (trajData?.timeline || [])[seq];
  return entry && entry.turn_index != null ? entry.turn_index : 0;
}

function trajTogglePlay() {
  if (trajPlayTimer) return trajStopPlay();
  trajEl.play.textContent = "⏸";
  trajAdvance(true);
}

function trajAdvance(first) {
  const stops = trajStops();
  let at = stops.findIndex((s) => trajSel && s.kind === trajSel.kind && s.index === trajSel.index);
  if (at < 0) at = 0;
  if (!first) at += 1;
  if (at >= stops.length) return trajStopPlay();
  trajSelect(stops[at].kind, stops[at].index);
  const dwell = Math.max(TRAJ_DWELL_FLOOR_MS, trajRealMs(stops[at]) / Math.max(1e-9, trajSpeed));
  trajShowProgress(stops[at], dwell);
  trajPlayTimer = setTimeout(() => trajAdvance(false), dwell);
}

function trajStopPlay() {
  clearTimeout(trajPlayTimer);
  trajPlayTimer = null;
  if (trajEl.play) trajEl.play.textContent = "▶";
  if (trajEl.progress) trajEl.progress.hidden = true;
}

// The replay dwells on each stop for the time it REALLY took divided by the speed, and without a
// bar that is indistinguishable from a frozen panel — a reader watching a 7-second turn has no way
// to tell playback from a hang, which is the same complaint the run ticker's long-wait tier exists
// to answer. Names the stop as well as drawing the bar, because a bar alone says how long is left
// and not what it is waiting for.
function trajShowProgress(stop, dwell) {
  // `bar`, not `row`: `test_every_hidden_toggled_class_still_honours_the_hidden_attribute` matches
  // `<var>.hidden =` across the WHOLE file, and three other functions here build `const row =
  // document.createElement(...)`. Its documented answer to that collision is to rename the local
  // rather than loosen the tripwire, and it duly failed the build naming `notebook-row`,
  // `starter-questions` and `tstep`.
  const bar = trajEl.progress;
  if (!bar) return;
  const label = bar.querySelector(".tp-label");
  const fill = bar.querySelector(".tp-fill");
  if (!label || !fill) return;
  bar.hidden = false;
  const name =
    stop.kind === "init"
      ? t("traj.init", "Init")
      : t("traj.turn", `Turn ${stop.index + 1}`, { n: stop.index + 1 });
  label.textContent = `\u25b6 ${name} \u00b7 ${trajSecs(dwell / 1000)}`;
  // RESTART the transition rather than letting it continue: clear it, snap to zero, force a
  // reflow, then run it. Without the reflow the browser coalesces both writes into one style
  // recalculation and the bar jumps straight to 100% with no animation at all.
  fill.style.transition = "none";
  fill.style.width = "0%";
  void fill.offsetWidth;
  fill.style.transition = `width ${dwell}ms linear`;
  fill.style.width = "100%";
}

function trajRefreshTransport() {
  const off = trajStops().length <= 1;
  [trajEl.prev, trajEl.play, trajEl.next].forEach((b) => {
    if (b) b.disabled = off;
  });
  if (off) trajStopPlay();
}

// ---- search --------------------------------------------------------------------------------

function trajSearch(query) {
  const needle = (query || "").trim().toLowerCase();
  trajMatches = [];
  trajMatchCur = -1;
  trajEl.steps.querySelectorAll(".tstep").forEach((row) => {
    const kind = row.dataset.kind;
    const index = Number(row.dataset.index);
    let hay = "";
    if (kind === "turn") {
      const turn = (trajData?.iterations || [])[index] || {};
      hay = `${turn.reasoning || ""}\n${turn.code || ""}\n${turn.output || ""}`;
    } else {
      hay = JSON.stringify(trajData?.initial || {});
    }
    const hit = needle !== "" && hay.toLowerCase().includes(needle);
    row.classList.toggle("is-match", hit);
    if (hit) trajMatches.push({ kind, index });
  });
  trajEl.searchCount.textContent = needle === ""
    ? ""
    : t("traj.matches", `${trajMatches.length} matches`, { n: trajMatches.length });
}

function trajCycleMatch() {
  if (!trajMatches.length) return;
  trajMatchCur = (trajMatchCur + 1) % trajMatches.length;
  const target = trajMatches[trajMatchCur];
  trajStopPlay();
  trajSelect(target.kind, target.index);
}

trajInit();

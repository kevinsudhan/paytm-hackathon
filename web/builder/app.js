/*
 * Araxys Builder — the page.
 *
 * Plain JS, no build step. Everything a model produced (labels, reasons, file contents)
 * is untrusted and goes through esc() before it touches innerHTML.
 */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const S = {
  mode: "fork",
  status: null,
  template: null,
  run: null,
  extendRun: null,
  tab: "overview",
  file: null,
  pollTimer: null,
  statusTimer: null,
  sessionTokens: {},
  extendBusy: false,
  build: null,
  buildTab: "lifecycle",
  apps: {},
  // "simple" | "detailed". Both views render the same S.run, so switching
  // during a build is a repaint rather than a restart.
  view: (() => { try { return localStorage.getItem("araxys.view") || "simple"; } catch { return "simple"; } })(),
};

const RUNNING = new Set(["REQUEST_RECEIVED", "READING_TEMPLATE", "DRAFTING"]);

const EXAMPLES = {
  fork: [
    ["Dental clinic", "A dental clinic in Chennai. Patients phone in to book, reschedule or cancel appointments with a dentist; the clinic sends reminders the day before and follows up after treatment. Some treatments need a lab (crowns, dentures)."],
    ["Physiotherapy centre", "A physiotherapy centre. Patients call to book a first assessment, then a course of sessions with a therapist; missed sessions are followed up, and insurance pre-approval is needed for some courses."],
    ["Hair salon", "A hair and beauty salon. Customers book by phone with a stylist for a service; the salon confirms the day before, takes a deposit for colour treatments, and sends a rebooking reminder six weeks later."],
    ["Vet clinic", "A veterinary clinic. Pet owners phone to book consultations and vaccinations; the clinic tracks each pet's vaccination schedule, sends reminders when a booster is due, and refers some cases to a specialist hospital."],
  ],
  extend: [
    ["Delay alerts", "Alert the customer automatically when a shipment is delayed more than three days past its sailing date."],
    ["Volume rebate", "Add a rebate for customers based on the shipment volume they book each quarter."],
  ],
};

// ------------------------------------------------------------------------ helpers

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/*
 * Where the builder's server is. Empty when this page is served by it; the builder's URL
 * when the page is hosted elsewhere (Netlify) — config.js is written at deploy time
 * from BUILDER_API_URL (scripts/netlify-config.mjs).
 */
const API = String(window.ARAXYS_API || "").replace(/\/$/, "");

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
  return body;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

function shortModel(id) {
  if (!id) return "";
  return String(id).split("/").pop().replace(/:free$/, "");
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function since(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

// -------------------------------------------------------------------- model label

async function loadStatus(refresh = false) {
  try {
    S.status = await api(`/api/status${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    S.status = { error: e.message };
  }
  renderModel();
}

function renderModel() {
  const st = S.status;
  const dot = $("#model-dot");
  const name = $("#model-name");
  const via = $("#model-via");
  const tag = $("#model-tag");
  dot.className = "dot";

  if (!st || st.error) {
    dot.classList.add("bad");
    name.textContent = "builder offline";
    via.textContent = "";
    tag.hidden = true;
    return;
  }

  const reachable = st.gatewayUp && st.gatewayAuthorised;
  const gw = st.gatewayName === "kilo" ? "Kilo" : st.gatewayName === "omniroute" ? "OmniRoute" : st.gatewayName;
  const isFree = (id) => /(:free|\/free)$/.test(id || "") && !(st.notFree || []).includes(id);

  if (st.inFlight) {
    dot.classList.add("busy");
    name.textContent = shortModel(st.inFlight.model);
    via.textContent = `via ${gw}`;
    tag.hidden = !isFree(st.inFlight.model);
  } else if (st.last) {
    dot.classList.add(reachable ? "ok" : "bad");
    name.textContent = shortModel(st.last.resolvedModel);
    via.textContent = `via ${st.last.backend === "anthropic" ? "Anthropic (paid)" : gw}`;
    tag.hidden = !(st.last.backend !== "anthropic" && isFree(st.last.usedModel));
  } else {
    dot.classList.add(reachable ? "ok" : "bad");
    name.textContent = st.ladder && st.ladder[0] ? shortModel(st.ladder[0]) : "none";
    via.textContent = reachable ? `ready · ${gw}` : `${gw} unreachable`;
    tag.hidden = !isFree(st.ladder && st.ladder[0]);
  }
  $("#model-pill").title = reachable ? "" : "The model gateway is not answering or rejects the key";

  // Popover
  $("#pop-gateway").textContent = `${gw} · ${st.gateway} · ${reachable ? "reachable" : st.gatewayUp ? "rejects the key" : "unreachable"}`;
  const current = st.inFlight ? st.inFlight.model : st.last ? st.last.usedModel : null;
  $("#pop-ladder").innerHTML = (st.ladder || [])
    .map((m, i) => `<li class="${m === current ? "current" : ""}"><span class="n">${i + 1}</span><span class="grow">${esc(m)}</span>${isFree(m) ? '<span class="tag">free</span>' : '<span class="badge warn">not free</span>'}</li>`)
    .join("");
  const foot = [];
  foot.push(st.paidFallback ? "Paid fallback is ON — Anthropic is used if every free model fails." : "Free models only — no paid fallback.");
  if (st.last) foot.push(`Last call: ${shortModel(st.last.resolvedModel)}, ${fmt(st.last.usage.input)} in / ${fmt(st.last.usage.output)} out.`);
  if ((st.notFree || []).length) foot.push(`Not listed as free right now: ${st.notFree.join(", ")}.`);
  $("#pop-foot").textContent = foot.join(" ");
}

function toggleModelPopover(show) {
  const pop = $("#model-popover");
  const open = show ?? pop.hidden;
  pop.hidden = !open;
  $("#model-pill").setAttribute("aria-expanded", String(open));
}

// ------------------------------------------------------------------------ template

async function loadTemplate(refresh = false) {
  try {
    S.template = await api(`/api/template${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    $("#tpl-live").className = "badge bad";
    $("#tpl-live").textContent = "unreadable";
    $("#tpl-body").innerHTML = `<div class="callout bad small">${esc(e.message)}</div>`;
    return;
  }
  const t = S.template;
  const seen = Object.values(t.observed).filter(Boolean).length;
  $("#tpl-live").className = `badge ${seen === 4 ? "ok" : "warn"}`;
  $("#tpl-live").textContent = seen === 4 ? "live" : `${seen}/4 live`;
  $("#tpl-label").textContent = "Araxys Logistics";

  const onOff = (v) => (v === null ? '<span class="dot" title="not read"></span>' : `<span class="dot ${v ? "ok" : ""}" title="${v ? "on" : "off"}"></span>`);
  $("#tpl-body").innerHTML = `
    <div class="tpl-section">
      <h4><span>Lifecycle</span><span>${t.lifecycle.length}</span></h4>
      <div class="flow">${t.lifecycle.map((s, i) => `${i ? '<span class="arrow">›</span>' : ""}<span class="st">${esc(s)}</span>`).join("")}</div>
    </div>
    <div class="tpl-section">
      <h4><span>CRM tables</span><span>${t.observed.schema ? t.tables.length : "?"}</span></h4>
      <ul class="tpl-list">${t.tables.map((x) => `<li title="${esc(x.note)}"><span class="name">${esc(x.name)}</span><span class="grow"></span><span class="muted">${x.columns} cols</span></li>`).join("")}</ul>
    </div>
    <div class="tpl-section">
      <h4><span>Voice agents</span><span>${t.agents.length}</span></h4>
      <ul class="tpl-list">${t.agents.map((a) => `<li title="${esc(a.role)}">${onOff(a.wired)}<span class="name">${esc(a.name)}</span><span class="grow"></span><span class="muted">${a.knowledgeSources ?? "?"} KB</span></li>`).join("")}</ul>
    </div>
    <div class="tpl-section">
      <h4><span>n8n workflows</span><span>${t.workflows.filter((w) => w.active).length}/${t.workflows.length} on</span></h4>
      <ul class="tpl-list">${t.workflows.map((w) => `<li title="${esc(w.trigger)}">${onOff(w.active)}<span class="name">${esc(w.name.replace(/^SHIPMATE /, ""))}</span></li>`).join("")}</ul>
    </div>
    <div class="tpl-section">
      <h4><span>Memory</span></h4>
      <ul class="tpl-list"><li>${onOff(t.memory.reachable)}<span class="name">${esc(t.memory.dataset)}</span><span class="grow"></span><span class="muted">Cognee</span></li></ul>
    </div>
    <div class="muted small">Read ${new Date(t.readAt).toLocaleTimeString()} · <a href="#" id="tpl-refresh">refresh</a></div>`;
  $("#tpl-refresh").addEventListener("click", (e) => { e.preventDefault(); loadTemplate(true); });
}

// ---------------------------------------------------------------------------- runs

async function loadRuns() {
  let runs = [];
  try { runs = await api("/api/runs"); } catch { return; }
  const el = $("#runs");
  if (!runs.length) {
    el.innerHTML = '<li class="muted small">None yet.</li>';
    return;
  }
  el.innerHTML = runs
    .map((r) => `<li><button type="button" data-run="${esc(r.runId)}" class="${S.run && S.run.runId === r.runId ? "active" : ""}">
      <span class="r-title">${esc(r.label || r.request.slice(0, 60))}</span>
      <span class="r-meta">${stateBadge(r.state)}<span>${new Date(r.startedAt).toLocaleTimeString()}</span></span>
    </button></li>`)
    .join("");
}

function stateBadge(state) {
  const cls = { BUILT: "ok", WAITING_FOR_APPROVAL: "accent", APPROVED: "accent", FAILED: "bad", REJECTED: "", CLARIFICATION_REQUIRED: "warn", ANALYSIS_FAILED: "bad" }[state] ?? "warn";
  const text = { WAITING_FOR_APPROVAL: "awaiting approval", CLARIFICATION_REQUIRED: "needs answers", ANALYSIS_FAILED: "failed" }[state] ?? state.toLowerCase().replace(/_/g, " ");
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

async function openRun(id) {
  S.build = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  try {
    S.run = await api(`/api/runs/${encodeURIComponent(id)}`);
  } catch (e) {
    return toast(e.message);
  }
  if (S.run.mode === "extend") {
    S.extendRun = S.run;
    S.run = null;
    setMode("extend", false);
    renderExtend();
    return;
  }
  setMode("fork", false);
  S.tab = "overview";
  S.file = null;
  render();
  if (RUNNING.has(S.run.state)) startPolling();
  loadRuns();
}

function startPolling() {
  stopPolling();
  S.pollTimer = setInterval(async () => {
    if (!S.run) return stopPolling();
    try {
      S.run = await api(`/api/runs/${encodeURIComponent(S.run.runId)}`);
    } catch { return; }
    await loadStatus();
    render();
    if (!RUNNING.has(S.run.state)) {
      stopPolling();
      loadRuns();
    }
  }, 1500);
}

function stopPolling() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = null;
}

// ------------------------------------------------------------------------- views

/**
 * Simple and detailed are two renderings of one run, not two flows.
 *
 * Everything that mutates state — startFork, the poller, approve, build —
 * finishes by calling render(), which paints whichever view is showing. That is
 * what makes switching mid-build free: there is no per-view run to reconcile,
 * and the other view was never rendering in the first place.
 */
function setView(view, remember = true) {
  S.view = view;
  if (remember) { try { localStorage.setItem("araxys.view", view); } catch { /* private mode */ } }
  $$(".view-switch button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.body.classList.toggle("is-simple", view === "simple");
  document.body.classList.toggle("is-detailed", view === "detailed");
  syncBackdrop();
  render();
}

/**
 * The simple view's video plays only while that view is on screen, so the
 * detailed view never pays for decoding it. For prefers-reduced-motion it never
 * plays; the first frame stays as a still background.
 */
function backdropShouldPlay() {
  return (
    S.view === "simple" &&
    document.visibilityState === "visible" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function syncBackdrop() {
  const v = $("#backdrop-video");
  if (!v) return;
  if (backdropShouldPlay()) v.play().catch(() => { /* autoplay refused: the still frame stays */ });
  else v.pause();
}

/**
 * Start the loop again after the device stopped it.
 *
 * iOS pauses a playing video whenever it likes \u2014 Low Power Mode, an incoming call, the
 * screen locking, the tab going to the back, the phone simply getting warm \u2014 and nothing
 * here ever asked it to start again: syncBackdrop ran only when the view changed. So on
 * an iPhone or iPad left open on the simple page the backdrop stopped after a minute or
 * two and stayed stopped for the rest of the session.
 *
 * The run poller had the same hole from the other side. Safari suspends timers in a
 * backgrounded tab and does not promise to resume them, so a build watched on a phone
 * could sit at "Drafting" long after it had finished.
 *
 * retries is there because the fix must not turn into a fight: if the device is refusing
 * to play (Low Power Mode does refuse), asking once per pause forever would keep the
 * radio and the decoder awake to no purpose. A few attempts, then leave the poster up.
 */
let backdropRetries = 0;

function resumeAfterSuspend() {
  if (document.visibilityState !== "visible") return;
  backdropRetries = 0;
  syncBackdrop();
  // A poll that was suspended mid-run is restarted; one that finished is not.
  if (S.run && RUNNING.has(S.run.state) && !S.pollTimer) startPolling();
  // The run may well have moved on while the screen was off.
  if (S.run) refreshRun();
}

/** Re-read the current run once, outside the polling loop. */
async function refreshRun() {
  try {
    S.run = await api(`/api/runs/${encodeURIComponent(S.run.runId)}`);
  } catch { return; }
  await loadStatus();
  render();
}

function watchBackdrop() {
  const v = $("#backdrop-video");
  if (!v) return;
  v.addEventListener("pause", () => {
    // Only when it should be running: switching to the detailed view pauses it on purpose.
    if (!backdropShouldPlay() || backdropRetries >= 3) return;
    backdropRetries += 1;
    setTimeout(() => { if (backdropShouldPlay()) v.play().catch(() => {}); }, 400);
  });
  v.addEventListener("playing", () => { backdropRetries = 0; });
}

/** Paints the active view. The only render entry point anything else should call. */
function render() {
  if (S.view === "simple") renderSimple();
  else if (S.mode === "fork") { if (S.build) renderBuild(); else renderRun(); }
  else renderExtend();
}

/* The states a person actually cares about, in the words they would use.
   The machine's own names (READING_TEMPLATE, BLUEPRINT_READY) are exact and
   are what the detailed view shows; here they would only be noise. */
const SIMPLE_PHASES = [
  { key: "read",     label: "Laying the foundations",        short: "Reading" },
  { key: "draft",    label: "Drafting the blueprint",        short: "Drafting" },
  { key: "check",    label: "Checking it against the kernel", short: "Checking" },
  { key: "ready",    label: "Ready for your decision",       short: "Ready" },
];

const PHASE_OF = {
  REQUEST_RECEIVED: 0, READING_TEMPLATE: 0,
  DRAFTING: 1,
  CLARIFICATION_REQUIRED: 2,
  BLUEPRINT_READY: 3, WAITING_FOR_APPROVAL: 3,
  APPROVED: 4, BUILT: 4,
};

/**
 * Which phase the run is at, and on a failure which phase it died in.
 *
 * A terminal FAILED carries no phase of its own, so the phase comes from the
 * last state that had one. Without this every row renders as never-started and
 * the reader is told a run that clearly got as far as drafting never began —
 * which is worse than saying nothing, because it is wrong about where to look.
 */
function simplePhase(run) {
  const direct = PHASE_OF[run.state];
  if (direct !== undefined) return direct;
  const last = [...(run.history || [])].reverse().find((h) => PHASE_OF[h.state] !== undefined);
  if (!last) return 0;
  // A draft that fails validation died in "checking", not in "drafting".
  return last.state === "DRAFTING" ? 2 : PHASE_OF[last.state];
}

function renderSimple() {
  const run = S.run;
  const head = $("#simple-head"), ask = $("#ask"), ex = $("#ask-examples"), foot = $("#ask-foot");
  const el = $("#simple-run");
  const busy = run && RUNNING.has(run.state);

  // The composer stays put until there is something to show under it.
  const showAsk = !run;
  $("#simple").classList.toggle("idle", showAsk);
  head.hidden = !showAsk;
  ex.hidden = !showAsk;
  foot.hidden = !showAsk;
  ask.classList.toggle("compact", !showAsk);

  if (!run) { el.hidden = true; return; }
  el.hidden = false;

  const phase = simplePhase(run);
  const failed = run.state === "FAILED" || run.state === "ANALYSIS_FAILED";

  const steps = SIMPLE_PHASES.map((p, i) => {
    // Arrived-but-not-running counts as reached: at WAITING_FOR_APPROVAL the
    // last row IS the state you are in, and leaving it blank reads as "never
    // got there" while the decision sits right below it.
    const done = !failed && (phase > i || (phase === i && !busy));
    const now = phase === i && busy;
    const cls = failed && phase === i ? "bad" : done ? "done" : now ? "now" : "";
    return `<li class="${cls}">
      <span class="tick">${done ? "&#10003;" : now ? '<span class="spinner"></span>' : failed && phase === i ? "&times;" : ""}</span>
      <span class="grow">${esc(p.label)}</span>
    </li>`;
  }).join("");

  const parts = [`<div class="said">${esc(run.request)}</div>`];

  // One word for what is happening, and a clock that moves.
  //
  // The phase list below already says this in full sentences, but it is four static
  // rows: nothing in it changes for the ninety seconds a draft takes, and a screen
  // that does not move reads as a screen that has hung. The seconds are the part that
  // earns its place — they are the only thing on the page that proves it is still alive.
  if (busy) {
    const word = (SIMPLE_PHASES[phase] || {}).short || "Working";
    const started = run.history && run.history.length ? run.history[0].at : null;
    parts.push(`<div class="live" role="status" aria-live="polite">
      <span class="spinner"></span>
      <span class="live-word">${esc(word)}<span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>
      ${started ? `<span class="live-meta mono">${esc(since(started))}</span>` : ""}
    </div>`);
  }

  parts.push(`<ol class="phases">${steps}</ol>`);

  if (failed) {
    parts.push(`<div class="callout bad"><div class="callout-title">It stopped</div><div>${esc(run.error || "The run failed.")}</div></div>`);
  } else if (run.state === "CLARIFICATION_REQUIRED") {
    const qs = (run.draft && run.draft.questions || []).filter((q) => q.blocks === "structure");
    parts.push(`<div class="outcome">
      <h3>A few things change what gets built</h3>
      <ul class="qlist">${qs.map((q) => `<li><span class="badge warn">structure</span><span>${esc(q.question)}</span></li>`).join("")}</ul>
      <div class="act"><button class="btn ghost" data-goto="detailed">Answer them</button></div>
    </div>`);
  } else if (run.blueprint) {
    // The vertical lives on the draft's spec, not on the blueprint — the
    // blueprint carries the file list, tally and warnings.
    const bp = run.blueprint, v = run.draft && run.draft.spec && run.draft.spec.vertical;
    if (!v) { el.innerHTML = parts.join(""); return; }
    const built = run.state === "BUILT";
    parts.push(`<div class="outcome">
      <div class="outcome-top">
        <div>
          <h3>${esc(v.label)}</h3>
          <div class="muted small">${esc(v.business.name)} · ${esc(v.business.currency)} · ${esc(v.business.timezone)}</div>
        </div>
        ${built ? '<span class="badge ok">built</span>' : '<span class="badge warn">awaiting approval</span>'}
      </div>
      <div class="figures">
        <div><b>${v.lifecycle.order.length}</b><span>stages</span></div>
        <div><b>${bp.tally.REUSE}</b><span>reused</span></div>
        <div><b>${bp.tally.CLONE}</b><span>cloned</span></div>
        <div><b>${bp.tally.NEEDS_PERSON || 0}</b><span>need a person</span></div>
      </div>
      <div class="chain">${v.lifecycle.order.map((x, i) => `${i ? '<span class="arrow">&rsaquo;</span>' : ""}<span class="st">${esc(x)}</span>`).join("")}</div>
      ${(() => {
        const qs = (run.draft && run.draft.questions) || [];
        const warn = (bp.warnings || []).length;
        if (!qs.length && !warn) return "";
        const bits = [];
        if (qs.length) bits.push(`${qs.length} question${qs.length === 1 ? "" : "s"} carried as assumptions`);
        if (warn) bits.push(`${warn} thing${warn === 1 ? "" : "s"} to read before approving`);
        return `<button class="carried" data-goto="detailed">${esc(bits.join(" · "))}<span class="arrow">&rsaquo;</span></button>`;
      })()}
      ${built
        ? `<div class="act">
             ${appControl(run.buildDir ? run.buildDir.split("/").pop() : "")}
             <button class="btn ghost" data-goto="detailed">See everything it wrote</button>
           </div>`
        : `<div class="act">
             <input type="text" id="s-approver" placeholder="Your name" />
             <button class="btn primary" id="s-approve">Approve &amp; build</button>
             <button class="btn ghost" data-goto="detailed">Review it first</button>
           </div>`}
    </div>`);
  }

  parts.push(`<div class="restart"><button class="btn ghost small" id="s-new">Start something else</button></div>`);
  el.innerHTML = parts.join("");

  $$("#simple-run [data-goto]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.goto)));
  const ap = $("#s-approve");
  if (ap) ap.addEventListener("click", () => {
    const name = ($("#s-approver").value || "").trim();
    if (!name) return toast("Put your name on the approval — it goes in the ledger.");
    decide(true, name);
  });
  const nu = $("#s-new");
  if (nu) nu.addEventListener("click", () => { S.run = null; S.build = null; stopPolling(); $("#ask-input").value = ""; render(); $("#ask-input").focus(); });
  bindAppControls(render);
}

// ---------------------------------------------------------------------- fork run

async function startFork(requestArg, forceArg) {
  S.build = null;
  // Either composer can start a run; the run itself is identical.
  const request = (requestArg ?? $("#request").value).trim();
  if (request.length < 10) return toast("Describe the business in at least a sentence.");
  // The simple view always carries open questions as assumptions. Sending someone
  // to another screen to answer fifteen clarifications is the opposite of what
  // that view is for — and the assumptions are still listed on the result, so
  // nothing is hidden, only deferred.
  const force = forceArg ?? $("#force").checked;
  const btn = $("#go");
  btn.disabled = true;
  try {
    S.run = await post("/api/fork", { request, force });
    S.tab = "overview";
    S.file = null;
    render();
    startPolling();
    loadRuns();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

const STEPS = ["Read template", "Draft", "Blueprint", "Approve", "Build"];
const STEP_OF = { REQUEST_RECEIVED: 0, READING_TEMPLATE: 0, DRAFTING: 1, CLARIFICATION_REQUIRED: 2, BLUEPRINT_READY: 2, WAITING_FOR_APPROVAL: 3, APPROVED: 4, BUILT: 5 };

function stepper(run) {
  let cur = STEP_OF[run.state];
  let failedAt = -1;
  if (cur === undefined) {
    // FAILED / REJECTED: the step that was running when it stopped.
    const lastGood = [...run.history].reverse().find((h) => STEP_OF[h.state] !== undefined);
    failedAt = lastGood ? Math.min(STEP_OF[lastGood.state] + (lastGood.state === "READING_TEMPLATE" || lastGood.state === "DRAFTING" ? 0 : 1), 4) : 0;
    cur = failedAt;
  }
  const d = run.draft;
  const bp = run.blueprint;
  const drafting = run.history.find((h) => h.state === "DRAFTING");
  const liveModel = S.status && S.status.inFlight ? shortModel(S.status.inFlight.model) : "";
  const subs = [
    run.template ? `${Object.values(run.template.observed).filter(Boolean).length}/4 sources live` : "",
    run.state === "DRAFTING"
      ? `${liveModel || "drafting"} · ${drafting ? since(drafting.at) : ""}`
      : d ? (d.cached ? "cache · 0 tokens" : `${fmt(d.usage.input + d.usage.output)} tokens`) : "",
    bp ? `${bp.tally.CLONE} cloned · ${bp.tally.REUSE} reused` : run.state === "CLARIFICATION_REQUIRED" ? "questions first" : "",
    run.approval ? `by ${run.approval.by}` : run.state === "WAITING_FOR_APPROVAL" ? "your decision" : "",
    run.buildDir ? run.buildDir : "",
  ];
  return `<div class="stepper">${STEPS.map((label, i) => {
    let cls = "";
    if (failedAt === i) cls = run.state === "FAILED" ? "failed" : "";
    else if (i < cur) cls = "done";
    else if (i === cur && RUNNING.has(run.state)) cls = "active";
    else if (i === cur && run.state !== "BUILT") cls = "active";
    return `<div class="step ${cls}"><div class="bar"></div><div class="label">${label}</div><div class="sub" title="${esc(subs[i])}">${esc(subs[i])}</div></div>`;
  }).join("")}</div>`;
}

function renderRun() {
  const el = $("#run");
  const run = S.run;
  if (!run) { el.hidden = true; return; }
  el.hidden = false;

  const parts = [`<div class="card">${stepper(run)}</div>`];

  if (RUNNING.has(run.state)) {
    const what = run.state === "DRAFTING"
      ? "Drafting the new business from the template. This usually takes a minute or two."
      : "Reading the logistics system — schema, workflows, agents and memory.";
    parts.push(`<div class="callout info"><div style="display:flex;gap:10px;align-items:center"><span class="spinner"></span><span>${esc(what)}</span></div></div>`);
  }

  if (run.state === "FAILED") {
    const d = run.draft;
    parts.push(`<div class="callout bad">
      <div class="callout-title">This run stopped</div>
      <div>${esc(run.error)}</div>
      ${d && d.problems && d.problems.length ? `<ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${d && d.calls && d.calls.length ? `<div class="small muted">${d.calls.map((c) => `${esc(c.purpose)}: ${esc(shortModel(c.resolvedModel))} (${fmt(c.usage.input)} in / ${fmt(c.usage.output)} out)`).join(" · ")}</div>` : ""}
      ${d && d.raw ? `<details><summary>What the model returned</summary><pre class="code">${esc(d.raw)}</pre></details>` : ""}
    </div>`);
  }

  if (run.state === "CLARIFICATION_REQUIRED" && run.draft && run.draft.spec) {
    const qs = run.draft.spec.openQuestions;
    parts.push(`<div class="card">
      <div class="card-head"><div><div class="eyebrow">Before anything is planned</div><h2>These change what gets built</h2></div></div>
      <ul class="qlist">${qs.filter((q) => q.blocks === "structure").map((q) => `<li><span class="badge warn">structure</span><span>${esc(q.question)}</span></li>`).join("")}</ul>
      <textarea id="answers" rows="3" style="margin-top:12px" placeholder="Answer in your own words — one line per question is fine."></textarea>
      <div class="composer-foot" style="margin-top:10px">
        <span class="muted small">Answers are folded into the request and drafted again. Unchanged requests come from cache for free.</span>
        <div class="grow"></div>
        <button class="btn" id="clarify-skip" type="button">Proceed with assumptions</button>
        <button class="btn primary" id="clarify-go" type="button">Answer and re-draft</button>
      </div>
    </div>`);
  }

  if (run.blueprint) parts.push(renderBlueprint(run));

  el.innerHTML = parts.join("");
  bindRun();
  bindAppControls(renderRun);

  // Session token tally: count each fresh draft once.
  if (run.draft && !run.draft.cached && !(run.runId in S.sessionTokens)) {
    S.sessionTokens[run.runId] = run.draft.usage.input + run.draft.usage.output;
    $("#session-tokens-n").textContent = fmt(Object.values(S.sessionTokens).reduce((a, b) => a + b, 0));
  }
}

function renderBlueprint(run) {
  const bp = run.blueprint;
  const d = run.draft;
  const spec = d.spec;
  const v = spec.vertical;
  const models = [...new Set(d.calls.map((c) => shortModel(c.resolvedModel)))].join(" → ");
  const tokens = d.usage.input + d.usage.output;

  const tabs = [
    ["overview", "Overview", bp.items.length],
    ["lifecycle", "Lifecycle & policy", v.lifecycle.order.length],
    ["data", "Data", spec.entities.length],
    ["agents", "Agents", spec.agents.length],
    ["workflows", "Workflows", bp.items.filter((i) => i.area === "workflow" && i.verdict === "CLONE").length],
    ["files", run.buildDir ? "Built files" : "Files", bp.files.length],
  ];

  let panel = "";
  if (S.tab === "overview") panel = overviewPanel(run);
  else if (S.tab === "lifecycle") panel = lifecyclePanel(spec);
  else if (S.tab === "data") panel = dataPanel(run);
  else if (S.tab === "agents") panel = agentsPanel(run);
  else if (S.tab === "workflows") panel = workflowsPanel(run);
  else panel = filesPanel(run);

  return `<section class="card hero">
    <div class="hero-top">
      <div>
        <div class="eyebrow">Blueprint · ${esc(v.id)}</div>
        <h2>${esc(v.label)}</h2>
        <div class="muted small">${esc(v.business.name)} · ${esc(v.business.currency)} · ${esc(v.business.timezone)} · built from the Araxys Logistics template</div>
      </div>
      ${stateBadge(run.state)}
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${bp.tally.REUSE}</div><div class="l">Reused</div></div>
      <div class="stat"><div class="v">${bp.tally.CLONE}</div><div class="l">Cloned</div></div>
      <div class="stat"><div class="v">${bp.tally.NEW}</div><div class="l">New</div></div>
      <div class="stat"><div class="v">${bp.tally.NEEDS_PERSON}</div><div class="l">Needs a person</div></div>
      <div class="stat"><div class="v">${d.cached ? "0" : fmt(tokens)}</div><div class="l">${d.cached ? "Tokens · draft cached" : `${fmt(d.usage.input)} in${d.usage.cacheRead ? ` (${fmt(d.usage.cacheRead)} cached)` : ""} / ${fmt(d.usage.output)} out`}</div></div>
      <div class="stat wide"><div class="model">${esc(models || "cache")}</div><div class="l">${d.cached ? "Drafted earlier, served from cache" : `Drafted in ${d.calls.length} call${d.calls.length === 1 ? "" : "s"} · free`}</div></div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([id, label, n]) => `<button role="tab" data-tab="${id}" aria-selected="${S.tab === id}">${label}<span class="count">${n}</span></button>`).join("")}</div>
    <div class="tab-panel">${panel}</div>
  </section>
  ${approvalBar(run)}`;
}

function item(i) {
  const from = i.from ? `<span class="from">${esc(i.from)}</span><span class="muted">→</span>` : "";
  const changes = (i.changes || []).length ? `<div class="changes">${i.changes.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : "";
  return `<div class="item"><span class="v-badge v-${esc(i.verdict)}">${esc(i.verdict.replace("_", " "))}</span>
    <div><div class="map">${from}<b>${esc(i.to)}</b></div><div class="why">${esc(i.why)}</div>${changes}</div></div>`;
}

function group(title, list) {
  if (!list.length) return "";
  return `<div class="group"><h3>${esc(title)}</h3><div class="items">${list.map(item).join("")}</div></div>`;
}

function overviewPanel(run) {
  const bp = run.blueprint;
  const d = run.draft;
  const q = d.spec.openQuestions;
  const out = [];
  if (bp.warnings.length) {
    out.push(`<div class="callout warn"><div class="callout-title">Read before approving</div><ul>${bp.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`);
  }
  if (q.length) {
    out.push(`<div class="callout info"><div class="callout-title">Still open</div><ul class="qlist">${q.map((x) => `<li><span class="badge ${x.blocks === "structure" ? "warn" : ""}">${esc(x.blocks)}</span><span>${esc(x.question)}</span></li>`).join("")}</ul></div>`);
  }
  out.push(group("Kernel — reused unchanged", bp.items.filter((i) => i.area === "kernel")));
  out.push(group("Engines", bp.items.filter((i) => i.area === "engine")));
  out.push(group("Memory", bp.items.filter((i) => i.area === "memory")));
  if (d.repaired && d.repaired.length) {
    out.push(`<details><summary>Needed one repair call — what the first answer got wrong</summary><ul class="small">${d.repaired.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`);
  }
  if (d.normalised && d.normalised.length) {
    out.push(`<details><summary>${d.normalised.length} slip${d.normalised.length === 1 ? "" : "s"} fixed in code, at zero tokens</summary><ul class="small">${d.normalised.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`);
  }
  return out.join("");
}

function lifecyclePanel(spec) {
  const v = spec.vertical;
  const held = v.policy.alwaysApprove || {};
  const order = v.lifecycle.order;
  const back = [];
  const states = order.map((s, i) => {
    const st = v.lifecycle.states[s] || { label: s, requirements: [], actions: [], next: [] };
    for (const n of st.next) if (order.indexOf(n) < i) back.push(`${s} → ${n}`);
    return `<div class="state ${s === v.lifecycle.initial ? "initial" : ""}">
      <span class="s-step">${i + 1}</span>
      <div class="s-name">${esc(s)}</div>
      <div class="s-label">${esc(st.label)}</div>
      ${st.requirements.length ? `<ul class="req">${st.requirements.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <div class="acts">${st.actions.map((a) => `<span class="act ${a in held ? "held" : ""}" title="${a in held ? "always needs a person" : ""}">${esc(a)}</span>`).join("")}</div>
      <div class="next">${st.next.length ? `→ ${st.next.map(esc).join(", ")}` : "terminal"}</div>
    </div>`;
  }).join("");

  const always = Object.entries(held).map(([a, r]) => `<li><span class="act held">${esc(a)}</span> — ${esc(r.why)} <span class="badge">${esc(r.approver)}</span></li>`).join("");
  const thresholds = (v.policy.thresholds || []).map((t) => `<li><span class="act">${t.actions.map(esc).join(" / ")}</span> — ${t.measure === "amount" ? `${esc(v.business.currencySymbol)}${fmt(t.limit)}` : `${fmt(t.limit)}% discount`} ${t.trigger === "atOrAbove" ? "or more" : "exceeded"} needs <span class="badge">${esc(t.approver)}</span></li>`).join("");

  return `<div class="group"><h3>Lifecycle — the twin runs this</h3><div class="lifecycle">${states}</div>
      ${back.length ? `<div class="muted small" style="margin-top:8px">Backward edges: ${back.map(esc).join(", ")}</div>` : ""}</div>
    <div class="group"><h3>Policy gate</h3>
      <ul class="policy">${always || '<li class="muted">No action is always held.</li>'}${thresholds}</ul>
    </div>`;
}

function fileContent(run, path) {
  const f = run.blueprint.files.find((x) => x.path === path);
  return f ? f.content : "";
}

function dataPanel(run) {
  const bp = run.blueprint;
  return `${group("Tables", bp.items.filter((i) => i.area === "entity"))}
    <div class="group"><h3>schema.sql</h3>${codeBlock(fileContent(run, "schema.sql"), "sql")}</div>`;
}

function agentsPanel(run) {
  const bp = run.blueprint;
  const prompts = bp.files.filter((f) => f.path.endsWith(".prompt.md"));
  return `${group("Voice agents", bp.items.filter((i) => i.area === "agent"))}
    <div class="callout info small">Once built, deploying creates each agent on SnapServe as a draft, named for the build, with no phone number — a new agent never answers a real caller until someone gives it one.</div>
    ${prompts.map((f) => `<div class="group"><h3>${esc(f.path)}</h3>${codeBlock(f.content, "md")}</div>`).join("")}`;
}

function workflowsPanel(run) {
  const bp = run.blueprint;
  return `${group("n8n workflows", bp.items.filter((i) => i.area === "workflow"))}
    <div class="muted small">Cloned workflows listen on their own webhook paths, so they can never answer the template's calls. They are written switched off.</div>`;
}

function filesPanel(run) {
  return filesView(run.blueprint.files, run.buildDir);
}

function filesView(files, buildDir) {
  if (!S.file || !files.some((f) => f.path === S.file)) S.file = files[0] && files[0].path;
  const f = files.find((x) => x.path === S.file);
  const kind = { config: "cfg", sql: "sql", agent: "agent", workflow: "n8n", memory: "mem", doc: "doc" };
  const ext = (p) => (p.endsWith(".sql") ? "sql" : p.endsWith(".json") ? "json" : p.endsWith(".md") ? "md" : "ts");
  const bname = buildDir ? buildDir.split("/").pop() : "";
  return `${buildDir ? `<div class="callout ok"><div class="callout-title">Written to ${esc(buildDir)}/</div><div class="small">Nothing was applied to a live system. BUILD.md lists the deploy steps in order. The business also runs as its own app:</div><div>${appControl(bname)}</div></div>` : `<div class="muted small">A preview — nothing is written until the blueprint is approved.</div>`}
    <div class="files">
      <div class="file-list">${files.map((x) => `<button type="button" data-file="${esc(x.path)}" class="${x.path === S.file ? "active" : ""}"><span class="file-kind">${kind[x.kind] || x.kind}</span><span>${esc(x.path)}</span></button>`).join("")}</div>
      <div class="viewer">
        <div class="viewer-head"><span class="grow">${esc(f ? f.path : "")}</span><span class="muted">${f ? fmt(f.content.split("\n").length) : 0} lines</span><button class="btn ghost small" id="copy-file" type="button">Copy</button></div>
        ${f ? codeBlock(f.content, ext(f.path), true) : ""}
      </div>
    </div>`;
}

/** Light highlighting, applied after escaping so it can only add spans to safe text. */
function codeBlock(text, lang, tall = false) {
  let html = esc(text);
  if (lang === "sql") {
    html = html.replace(/^(--.*)$/gm, '<span class="c">$1</span>')
      .replace(/\b(create table if not exists|alter table|enable row level security|primary key|not null|default|generated always as identity)\b/g, '<span class="k">$1</span>');
  } else if (lang === "json") {
    html = html.replace(/(&quot;[^&\n]*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2');
  } else if (lang === "md") {
    html = html.replace(/^(#{1,3} .*)$/gm, '<span class="k">$1</span>');
  } else {
    html = html.replace(/^(\s*(?:\/\*\*|\*|\/\/).*)$/gm, '<span class="c">$1</span>');
  }
  return `<pre class="code"${tall ? ' style="max-height:none;height:100%"' : ""}>${html}</pre>`;
}

function approvalBar(run) {
  if (run.state === "WAITING_FOR_APPROVAL") {
    const name = store("builder.approver") || "";
    return `<div class="approval">
      <div class="grow"><b>Approve this blueprint?</b><div class="note">Approving writes the files to builds/. Nothing reaches a live database, phone line or workflow.</div></div>
      <input type="text" id="approver" placeholder="Your name" value="${esc(name)}" aria-label="Approver name" />
      <button class="btn danger" id="reject" type="button">Reject</button>
      <button class="btn primary" id="approve" type="button">Approve & build</button>
    </div>`;
  }
  if (run.state === "APPROVED") {
    return `<div class="approval"><div class="grow"><b>Approved by ${esc(run.approval.by)}</b><div class="note">Not built yet.</div></div><button class="btn primary" id="build" type="button">Build files</button></div>`;
  }
  return "";
}

function bindRun() {
  $$("#run [data-tab]").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; renderRun(); }));
  $$("#run [data-file]").forEach((b) => b.addEventListener("click", () => { S.file = b.dataset.file; renderRun(); }));
  const copy = $("#copy-file");
  if (copy) copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(fileContent(S.run, S.file)); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
  });
  const approve = $("#approve");
  if (approve) approve.addEventListener("click", () => decide(true));
  const reject = $("#reject");
  if (reject) reject.addEventListener("click", () => decide(false));
  const build = $("#build");
  if (build) build.addEventListener("click", buildRun);
  const go = $("#clarify-go");
  if (go) go.addEventListener("click", () => clarify(false));
  const skip = $("#clarify-skip");
  if (skip) skip.addEventListener("click", () => clarify(true));
}

async function decide(approve, byArg) {
  // The approver may come from either view's field. It is recorded either way:
  // the ledger entry is the point of the gate.
  const by = (byArg || ($("#approver") && $("#approver").value.trim()) || "").trim();
  if (!by) return toast("Add your name — approval is recorded with it.");
  store("builder.approver", by);
  try {
    S.run = await post(`/api/fork/${encodeURIComponent(S.run.runId)}/decide`, { approve, by });
    if (approve) return buildRun();
    render();
    loadRuns();
  } catch (e) { toast(e.message); }
}

async function buildRun() {
  try {
    S.run = await post(`/api/fork/${encodeURIComponent(S.run.runId)}/build`, {});
    S.tab = "files";
    S.file = "BUILD.md";
    await loadApps();
    render();
    loadRuns();
    loadBuilds();
  } catch (e) { toast(e.message); }
}

async function clarify(force) {
  const answers = ($("#answers") && $("#answers").value) || "";
  if (!force && !answers.trim()) return toast("Answer the questions, or proceed with assumptions.");
  try {
    S.run = await post(`/api/fork/${encodeURIComponent(S.run.runId)}/clarify`, { answers, force: force || undefined });
    renderRun();
    startPolling();
    loadRuns();
  } catch (e) { toast(e.message); }
}

// -------------------------------------------------------------------------- builds

async function loadApps() {
  try { S.apps = await api("/api/apps"); } catch { S.apps = {}; }
}

/**
 * Launch / open for one build's app. The app is its own process on its own port — the
 * builder starts it and links to it, and never shows it inside this page.
 */
/**
 * An app's address as this browser reaches it. A hosted builder serves apps itself, at a
 * path on its own address. A local one runs each on its own port, on the host this page
 * came from — 127.0.0.1 on the laptop, the laptop's address on a tablet.
 */
function appUrl(a) {
  if (a.path) return `${API || location.origin}${a.path}`;
  return `${location.protocol}//${location.hostname}:${a.port}/`;
}

function appControl(name) {
  const a = S.apps[name] || {};
  if (a.running && (a.path || a.port)) {
    const url = appUrl(a);
    return `<span class="app-ctl"><a class="btn primary small" href="${esc(url)}" target="_blank" rel="noopener">Open app ↗</a><span class="mono small muted">${esc(url)}</span></span>`;
  }
  if (a.hasApp === false) {
    return `<span class="muted small">Built before apps existed — rebuild to get a runnable app.</span>`;
  }
  return `<button class="btn primary small" type="button" data-launch="${esc(name)}">Launch app</button>`;
}

function bindAppControls(rerender) {
  $$("[data-launch]").forEach((b) => b.addEventListener("click", async () => {
    const name = b.dataset.launch;
    // Opened now, inside the tap, and pointed at the app once it is up. Safari (and so
    // every browser on an iPad) blocks a tab opened after an await as a popup.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span> Starting…';
    try {
      const st = await post(`/api/builds/${encodeURIComponent(name)}/launch`, {});
      S.apps[name] = { ...(S.apps[name] || {}), ...st, hasApp: true };
      if ((st.path || st.port) && tab) tab.location.href = appUrl(st);
      else if (tab) tab.close();
    } catch (e) {
      if (tab) tab.close();
      toast(e.message);
    }
    rerender();
    loadBuilds();
  }));
}

async function loadBuilds() {
  let builds = [];
  try { builds = await api("/api/builds"); } catch { return; }
  await loadApps();
  const el = $("#builds");
  if (!builds.length) {
    el.innerHTML = '<li class="muted small">Nothing built yet.</li>';
    return;
  }
  el.innerHTML = builds
    .map((b) => `<li><button type="button" data-build="${esc(b.name)}" class="${S.build && S.build.name === b.name ? "active" : ""}">
      <span class="r-title">${esc(b.business || b.label)}</span>
      <span class="r-meta"><span class="badge ok">${esc(b.id)}</span>${S.apps[b.name] && S.apps[b.name].running ? `<span class="badge accent">live${S.apps[b.name].port ? ` :${S.apps[b.name].port}` : ""}</span>` : ""}<span>${b.states ?? "?"} states</span><span>${new Date(b.builtAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></span>
    </button></li>`)
    .join("");
}

async function openBuild(name) {
  try {
    S.build = await api(`/api/builds/${encodeURIComponent(name)}`);
    await loadApps();
  } catch (e) {
    return toast(e.message);
  }
  stopPolling();
  S.run = null;
  S.extendRun = null;
  S.buildTab = "lifecycle";
  S.file = null;
  if (location.hash !== `#build/${name}`) history.replaceState(null, "", `#build/${name}`);
  setMode("fork", false);
  renderBuild();
  loadBuilds();
  $("#run").scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildFile(path) {
  const f = S.build.files.find((x) => x.path === path);
  return f ? f.content : "";
}

function workflowRow(f) {
  let wf = { name: f.path, nodes: [] };
  try { wf = JSON.parse(f.content); } catch { /* shown by path */ }
  const nodes = wf.nodes || [];
  const hooks = nodes.filter((n) => String(n.type).endsWith(".webhook")).map((n) => `/webhook/${n.parameters && n.parameters.path}`);
  const trig = nodes.find((n) => /webhook$|Trigger$/.test(String(n.type)));
  const from = wf.meta && wf.meta.builtFrom ? ` · from ${esc(wf.meta.builtFrom)}` : "";
  return `<div class="item"><span class="v-badge v-CLONE">CLONE</span><div>
    <div class="map"><b>${esc(wf.name)}</b></div>
    <div class="why">${esc(trig ? String(trig.type).split(".").pop() : "manual")} · ${nodes.length} nodes${from}</div>
    ${hooks.length ? `<div class="changes">${hooks.map((h) => `<span>${esc(h)}</span>`).join("")}</div>` : ""}
  </div></div>`;
}

function agentBlock(f) {
  let cfg = {};
  try { cfg = JSON.parse(buildFile(f.path.replace(/\.prompt\.md$/, ".agent.json"))); } catch { /* optional */ }
  return `<div class="group"><h3>${esc(cfg.name || f.path)}${cfg.clonedFrom ? ` <span class="muted">· cloned from ${esc(cfg.clonedFrom)}</span>` : ""}</h3>
    ${cfg.greeting ? `<div class="callout info small"><b>Greeting</b> — ${esc(cfg.greeting)}</div>` : ""}
    ${codeBlock(f.content, "md")}</div>`;
}

function renderBuild() {
  const b = S.build;
  const el = $("#run");
  el.hidden = false;
  const v = b.vertical;
  if (!v) {
    el.innerHTML = `<div class="callout bad">${esc(b.buildDir)} has no readable vertical.json.</div>`;
    return;
  }
  const files = b.files;
  const sql = buildFile("schema.sql");
  const tables = [...sql.matchAll(/create table if not exists public\.([a-z0-9_]+)/g)].map((m) => m[1]);
  const prompts = files.filter((f) => f.path.endsWith(".prompt.md"));
  const flows = files.filter((f) => f.path.startsWith("n8n/"));
  let memory = {};
  try { memory = JSON.parse(buildFile("memory.json")); } catch { /* optional */ }
  const held = Object.keys(v.policy.alwaysApprove || {});

  const tabs = [
    ["lifecycle", "Lifecycle & policy", v.lifecycle.order.length],
    ["agents", "Agents", prompts.length],
    ["data", "Data", tables.length],
    ["workflows", "Workflows", flows.length],
    ["files", "Files", files.length],
    ["deploy", "Deploy", ""],
  ];

  let panel = "";
  if (S.buildTab === "lifecycle") panel = lifecyclePanel({ vertical: v });
  else if (S.buildTab === "agents") {
    panel = `<div class="callout info small">Deploying creates each agent on SnapServe as a draft, named for this build, with no phone number — see the Deploy tab.</div>` + prompts.map(agentBlock).join("");
  } else if (S.buildTab === "data") {
    panel = `<div class="group"><h3>Tables</h3><div class="flow">${tables.map((t) => `<span class="st">${esc(t)}</span>`).join("")}</div></div>
      <div class="group"><h3>schema.sql</h3>${codeBlock(sql, "sql")}</div>`;
  } else if (S.buildTab === "workflows") {
    panel = `<div class="items">${flows.map(workflowRow).join("")}</div>
      <div class="muted small">Written switched off. Import through n8n; on n8n Cloud replace <code>{{ $env.SHIPMATE_BASE }}</code> first.</div>`;
  } else if (S.buildTab === "files") {
    panel = filesView(files, b.buildDir);
  } else {
    panel = deployPanel(b.name);
  }

  el.innerHTML = `<section class="card hero">
    <div class="hero-top">
      <div>
        <div class="eyebrow">Built business · ${esc(v.id)}</div>
        <h2>${esc(v.business.name)}</h2>
        <div class="muted small">${esc(v.label)} · ${esc(v.business.currency)} · ${esc(v.business.timezone)} · ${esc(b.buildDir)}/ · built ${new Date(b.builtAt).toLocaleString()}</div>
      </div>
      <div class="hero-actions">${appControl(b.name)}<span class="badge ok">built</span></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${v.lifecycle.order.length}</div><div class="l">Lifecycle states</div></div>
      <div class="stat"><div class="v">${v.actions.length}</div><div class="l">Actions</div></div>
      <div class="stat"><div class="v">${held.length}</div><div class="l">Always need a person</div></div>
      <div class="stat"><div class="v">${tables.length}</div><div class="l">Tables</div></div>
      <div class="stat"><div class="v">${prompts.length}</div><div class="l">Voice agents</div></div>
      <div class="stat"><div class="v">${flows.length}</div><div class="l">Workflows</div></div>
      <div class="stat wide"><div class="model">${esc(memory.dataset || "—")}</div><div class="l">Memory dataset (Cognee)</div></div>
    </div>
    ${deployedLine(b.name)}
    <div class="tabs" role="tablist">${tabs.map(([id, label, n]) => `<button role="tab" data-btab="${id}" aria-selected="${S.buildTab === id}">${label}<span class="count">${n}</span></button>`).join("")}</div>
    <div class="tab-panel">${panel}</div>
  </section>`;

  $$("#run [data-btab]").forEach((x) => x.addEventListener("click", () => { S.buildTab = x.dataset.btab; renderBuild(); }));
  bindAppControls(renderBuild);
  bindDeploy(b.name);
  $$("#run [data-file]").forEach((x) => x.addEventListener("click", () => { S.file = x.dataset.file; renderBuild(); }));
  const copy = $("#copy-file");
  if (copy) copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(buildFile(S.file)); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
  });
}

// ------------------------------------------------------------------------- deploy
/*
 * The Deploy tab. A preview first — it only reads the live accounts — then Deploy, with a
 * name, which creates everything under this build's own name. Every later deploy of the
 * same build updates those same things in place; Remove deletes exactly them.
 */
S.deploy = {};

async function loadDeployment(name, rerender = true) {
  try {
    S.deploy[name] = { ...(S.deploy[name] || {}), info: await api(`/api/builds/${encodeURIComponent(name)}/deployment`) };
  } catch (e) {
    S.deploy[name] = { ...(S.deploy[name] || {}), info: { error: e.message } };
  }
  if (rerender && S.build && S.build.name === name) renderBuild();
}

function deployedLine(name) {
  const d = S.deploy[name];
  if (!d || !d.info) { loadDeployment(name); return `<div class="callout info small">Checking where this business is deployed…</div>`; }
  const r = d.info.record;
  if (!r) return `<div class="callout info small">Built, not deployed. The Deploy tab creates its memory on Cognee, its agents on SnapServe and its workflows on n8n — all named for this build.</div>`;
  return `<div class="callout ok small">Deployed ${esc(new Date(r.deployedAt).toLocaleString())} by ${esc(r.by)}: ${r.snapserve ? `${r.snapserve.agents.length} agent(s) on SnapServe` : "no agents"}, ${r.n8n ? `${r.n8n.workflows.length} workflow(s) on n8n` : "no workflows"}, ${r.cognee ? `memory in Cognee (${esc(r.cognee.dataset)})` : "no memory"}.</div>`;
}

const STEP_BADGE = { create: "ok", update: "info", replace: "info", keep: "", delete: "bad", skip: "warn" };

function stepsTable(steps) {
  return `<div class="items">${steps.map((s) => `<div class="item">
    <span class="badge ${s.error ? "bad" : STEP_BADGE[s.action] || ""}">${esc(s.error ? "failed" : s.action)}</span>
    <div><div class="map"><span class="muted small mono">${esc(s.service)}</span> <b>${esc(s.what)}</b></div>
    ${s.note ? `<div class="why">${esc(s.note)}</div>` : ""}${s.error ? `<div class="why" style="color:var(--bad)">${esc(s.error)}</div>` : ""}</div>
  </div>`).join("")}</div>`;
}

/**
 * One deployed workflow, with the switch that starts it.
 *
 * A workflow that cannot safely go on says why here rather than failing on the click.
 * deploy.ts refuses the same three cases server-side — this is the explanation, not the
 * check, and the button stays disabled either way.
 */
function workflowItem(w, r, info) {
  const on = w.active === true;
  const routes = info.appRoutes || [];
  const gap = (w.calls || []).filter((c) => !routes.includes(c));
  const mailbox = /gmail|imap|mail/i.test(w.trigger || "");

  let blocked = null;
  if (!on && !r.appUrl) blocked = "No public app URL — it would call nothing.";
  else if (!on && gap.length) blocked = `Calls routes this app does not serve (${gap.join(", ")}) — it would fail on every run.`;

  const where = w.webhooks.map((h) => h.replace(/^https?:\/\/[^/]+/, "")).join(", ") || "scheduled";
  const name = info.n8nBase
    ? `<a href="${esc(info.n8nBase)}/workflow/${esc(w.id)}" target="_blank" rel="noopener">${esc(w.name)}</a>`
    : `<b>${esc(w.name)}</b>`;

  return `<div class="item switchable">
    <span class="badge ${on ? "ok" : ""}">${on ? "on" : "off"}</span>
    <div class="grow">
      <div class="map">${name}</div>
      <div class="why">${esc(where)}${w.calls.length ? ` · calls ${esc(w.calls.join(", "))}` : ""}${on && w.activatedBy ? ` · switched on by ${esc(w.activatedBy)}` : ""}</div>
      ${blocked ? `<div class="why muted">${esc(blocked)}</div>` : ""}
      ${!on && !blocked && mailbox ? `<div class="why muted">Reads a real mailbox the moment it is on.</div>` : ""}
    </div>
    <button class="btn small ${on ? "ghost" : "primary"}" data-wf="${esc(w.id)}" data-on="${on ? "1" : "0"}" ${blocked ? "disabled" : ""}>${on ? "Switch off" : "Switch on"}</button>
  </div>`;
}

function deployPanel(name) {
  const d = S.deploy[name] || {};
  const info = d.info;
  if (!info) { loadDeployment(name); return `<div class="muted small">Reading the deployment…</div>`; }
  if (info.error) return `<div class="callout bad small">${esc(info.error)}</div>`;
  const c = info.configured;
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  const r = info.record;
  const parts = [];

  parts.push(`<div class="callout info small">Everything is created under <b class="mono">[${esc(name)}]</b> and only ever changed or removed by this build — the logistics system's workflows, Priya and Arun, and earlier builds are never touched. Agents are drafts with no phone number; workflows are switched off.</div>`);
  if (missing.length) parts.push(`<div class="callout warn small">Not configured in .env: ${esc(missing.join(", "))} — those steps are skipped.</div>`);

  if (r) {
    const wf = (r.n8n && r.n8n.workflows) || [];
    parts.push(`<div class="group"><h3>Live now</h3><div class="items">
      ${r.cognee ? `<div class="item"><span class="badge ok">cognee</span><div><div class="map"><b>${esc(r.cognee.dataset)}</b></div><div class="why">${r.cognee.documents} documents · graph ${esc(r.cognee.cognify)} · the app adds every recorded change</div></div></div>` : ""}
      ${r.snapserve ? r.snapserve.agents.map((a) => `<div class="item"><span class="badge ok">agent</span><div><div class="map"><b>${esc(a.name)}</b> <span class="muted small mono">#${a.id}</span></div><div class="why">SnapServe · draft until someone gives it a number</div></div></div>`).join("") : ""}
      ${r.snapserve ? r.snapserve.sources.map((s) => `<div class="item"><span class="badge ok">knowledge</span><div><div class="map"><b>${esc(s.name)}</b> <span class="muted small mono">#${s.id}</span></div></div></div>`).join("") : ""}
      ${wf.map((w) => workflowItem(w, r, info)).join("")}
    </div>
    ${wf.length ? `<div class="act" style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <input type="text" id="wf-by" placeholder="Your name" class="input small" style="min-width:150px" />
      <span class="muted small">Switching a workflow on is recorded against your name.</span>
    </div>` : ""}
    <div class="muted small">Deployed ${esc(new Date(r.deployedAt).toLocaleString())} by ${esc(r.by)}${r.appUrl ? ` · app at ${esc(r.appUrl)}` : " · no public app URL yet, so the workflows call nothing"}</div></div>`);
  }

  parts.push(`<div class="group"><h3>${r ? "Deploy again" : "Deploy"}</h3>
    <div class="act" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="text" id="d-url" placeholder="Public app URL (optional, https://…)" value="${esc((r && r.appUrl) || info.publicAppUrl || "")}" style="flex:1;min-width:220px" class="input" />
      <button class="btn ghost" id="d-preview" ${d.busy ? "disabled" : ""}>Preview</button>
    </div></div>`);

  if (d.busy) parts.push(`<div class="callout info small"><span class="spinner"></span> ${esc(d.busy)}</div>`);
  if (d.error) parts.push(`<div class="callout bad small">${esc(d.error)}</div>`);
  if (d.steps) {
    parts.push(`<div class="group"><h3>${esc(d.stepsTitle)}</h3>${stepsTable(d.steps)}</div>`);
    if (d.pending) {
      parts.push(`<div class="act" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="d-by" placeholder="Your name" class="input" style="min-width:160px" />
        <button class="btn ${d.pending === "undeploy" ? "danger" : "primary"}" id="d-go">${d.pending === "undeploy" ? "Remove it" : "Deploy"}</button>
        <span class="muted small">${d.pending === "undeploy" ? "Deletes exactly the items above." : "Reaches the live accounts."}</span>
      </div>`);
    }
  }
  if (r && !d.pending) parts.push(`<div class="restart" style="justify-content:flex-start"><button class="btn ghost small" id="d-remove" ${d.busy ? "disabled" : ""}>Remove this deployment…</button></div>`);
  parts.push(`<details class="group"><summary class="muted small">BUILD.md</summary>${codeBlock(buildFile("BUILD.md"), "md")}</details>`);
  return parts.join("");
}

function bindDeploy(name) {
  const d = () => (S.deploy[name] = S.deploy[name] || {});
  const go = async (label, fn) => {
    d().busy = label; d().error = null; renderBuild();
    try { await fn(); } catch (e) { d().error = e.message; }
    d().busy = null;
    await loadDeployment(name, false);
    renderBuild();
  };
  const url = () => ($("#d-url") ? $("#d-url").value.trim() : "");

  const preview = $("#d-preview");
  if (preview) preview.addEventListener("click", () => go("Reading n8n, SnapServe and Cognee…", async () => {
    const out = await post(`/api/builds/${encodeURIComponent(name)}/deploy`, { apply: false, appUrl: url() || undefined });
    Object.assign(d(), { steps: out.steps, stepsTitle: "What deploying will do", pending: "deploy", appUrl: url() });
  }));
  const remove = $("#d-remove");
  if (remove) remove.addEventListener("click", () => go("Checking what this build made…", async () => {
    const out = await post(`/api/builds/${encodeURIComponent(name)}/undeploy`, { apply: false });
    Object.assign(d(), { steps: out.steps, stepsTitle: "What removing will delete", pending: "undeploy" });
  }));
  $$("[data-wf]").forEach((b) => b.addEventListener("click", () => {
    const by = ($("#wf-by") && $("#wf-by").value || "").trim();
    if (!by) return toast("Add your name — switching a workflow on is recorded with it.");
    const on = b.dataset.on !== "1";
    go(on ? "Switching it on…" : "Switching it off…", async () => {
      await post(`/api/builds/${encodeURIComponent(name)}/workflows/${encodeURIComponent(b.dataset.wf)}/active`, { active: on, by });
    });
  }));

  const confirm = $("#d-go");
  if (confirm) confirm.addEventListener("click", () => {
    const by = ($("#d-by").value || "").trim();
    if (!by) return toast("Add your name — the deployment is recorded with it.");
    const pending = d().pending;
    go(pending === "undeploy" ? "Removing…" : "Deploying — creating the dataset, agents and workflows…", async () => {
      const out = pending === "undeploy"
        ? await post(`/api/builds/${encodeURIComponent(name)}/undeploy`, { apply: true, by })
        : await post(`/api/builds/${encodeURIComponent(name)}/deploy`, { apply: true, by, appUrl: d().appUrl || undefined });
      Object.assign(d(), { steps: out.steps, stepsTitle: pending === "undeploy" ? "Removed" : "Deployed", pending: null });
    });
  });
}

// -------------------------------------------------------------------- extend mode

async function startExtend() {
  const request = $("#request").value.trim();
  if (request.length < 10) return toast("Describe the change in at least a sentence.");
  S.extendBusy = true;
  S.extendRun = null;
  renderExtend();
  const tick = setInterval(() => loadStatus(), 1500);
  try {
    S.extendRun = await post("/api/extend", { request, force: $("#force").checked });
  } catch (e) {
    toast(e.message);
  } finally {
    clearInterval(tick);
    S.extendBusy = false;
    loadStatus();
    renderExtend();
  }
}

function opVerdict(type) {
  return (type.split("_")[0] || "").toUpperCase();
}

function renderExtend() {
  const el = $("#run");
  el.hidden = false;
  if (S.extendBusy) {
    el.innerHTML = `<div class="callout info"><div style="display:flex;gap:10px;align-items:center"><span class="spinner"></span><span>Reading the request, then comparing it with the live system…</span></div></div>`;
    return;
  }
  const run = S.extendRun;
  if (!run) { el.hidden = true; return; }
  const out = [`<div class="card"><div class="eyebrow">Change to the logistics system</div><div class="flow" style="margin-top:6px">${run.history.map((h, i) => `${i ? '<span class="arrow">›</span>' : ""}<span class="st">${esc(h.state)}</span>`).join("")}</div></div>`];

  if (run.state === "ANALYSIS_FAILED") out.push(`<div class="callout bad"><div class="callout-title">Planning stopped</div><div>${esc(run.error)}</div></div>`);
  if (run.state === "CLARIFICATION_REQUIRED" && run.spec) {
    out.push(`<div class="callout warn"><div class="callout-title">These change what would be built</div><ul>${run.spec.openQuestions.filter((q) => q.blocks === "structure").map((q) => `<li>${esc(q.question)}</li>`).join("")}</ul><div class="small">Add the answers to the request, or tick “Don't stop for questions” and plan again.</div></div>`);
  }
  if (run.plan) {
    const p = run.plan;
    const groups = { entity: "CRM — entities", field: "CRM — fields", workflow: "n8n — workflows", agent: "Agents", uiPage: "UI", knowledge: "Memory" };
    const ops = Object.entries(groups).map(([target, title]) => {
      const list = p.operations.filter((o) => o.target === target);
      if (!list.length) return "";
      return `<div class="group"><h3>${esc(title)}</h3><div class="items">${list.map((o) => `<div class="item"><span class="v-badge v-${esc(opVerdict(o.type))}">${esc(opVerdict(o.type))}</span><div><div class="map"><b>${esc(o.name)}</b>${o.capability ? `<span class="badge">${esc(o.capability)}</span>` : ""}</div><div class="why">${esc(o.why)}</div>${o.performable ? "" : `<div class="changes"><span>blocked: ${esc(o.blockedReason)}</span></div>`}</div></div>`).join("")}</div></div>`;
    }).join("");
    out.push(`<section class="card hero">
      <div class="hero-top"><div><div class="eyebrow">Change plan · risk ${esc(p.riskLevel)}</div><h2>${esc(p.summary)}</h2><div class="muted small">read by ${esc(shortModel(p.readBy.model))} (${esc(p.readBy.backend)})</div></div>${stateBadge(run.state)}</div>
      <div class="stats">
        <div class="stat"><div class="v">${p.tally.CREATE}</div><div class="l">Create</div></div>
        <div class="stat"><div class="v">${p.tally.MODIFY}</div><div class="l">Modify</div></div>
        <div class="stat"><div class="v">${p.tally.CONFIGURE}</div><div class="l">Configure</div></div>
        <div class="stat"><div class="v">${p.tally.REUSE}</div><div class="l">Already there</div></div>
        <div class="stat"><div class="v">${p.notPerformable.length}</div><div class="l">Can't perform</div></div>
      </div>
      ${p.unsafe ? '<div class="callout bad">Part of the system could not be read, so some “create” lines may already exist. This plan cannot be approved.</div>' : ""}
      ${p.assumptions.length ? `<div class="callout info"><div class="callout-title">Still open</div><ul>${p.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
      ${ops}
      <details><summary>Plain-text diff</summary>${codeBlock(run.diff || "", "txt")}</details>
    </section>`);
    if (run.state === "WAITING_FOR_APPROVAL") {
      out.push(`<div class="approval"><div class="grow"><b>Approve this plan?</b><div class="note">Approval is recorded. The change plan has no executor — nothing is applied.</div></div>
        <input type="text" id="approver" placeholder="Your name" value="${esc(store("builder.approver") || "")}" /><button class="btn danger" id="x-reject" type="button">Reject</button><button class="btn primary" id="x-approve" type="button">Approve</button></div>`);
    }
  }
  el.innerHTML = out.join("");
  const a = $("#x-approve");
  const r = $("#x-reject");
  const act = async (approve) => {
    const by = $("#approver").value.trim();
    if (!by) return toast("Add your name — approval is recorded with it.");
    store("builder.approver", by);
    try { S.extendRun = await post(`/api/extend/${encodeURIComponent(run.runId)}/decide`, { approve, by }); renderExtend(); } catch (e) { toast(e.message); }
  };
  if (a) a.addEventListener("click", () => act(true));
  if (r) r.addEventListener("click", () => act(false));
}

// ---------------------------------------------------------------------------- mode

function setMode(mode, render = true) {
  S.mode = mode;
  $$(".segmented button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $("#composer-label").textContent = mode === "fork" ? "Describe the business you want built" : "Describe the change to the logistics system";
  $("#request").placeholder = mode === "fork" ? EXAMPLES.fork[0][1] : EXAMPLES.extend[0][1];
  $("#go").textContent = mode === "fork" ? "Draft blueprint" : "Plan the change";
  $("#composer-hint").textContent = mode === "fork"
    ? "One quick draft, then everything else is generated instantly."
    : "One quick read of the request, then the change is worked out against the live system.";
  $("#examples").innerHTML = EXAMPLES[mode].map(([label], i) => `<button type="button" class="chip" data-ex="${i}">${esc(label)}</button>`).join("");
  $$("#examples [data-ex]").forEach((b) => b.addEventListener("click", () => { $("#request").value = EXAMPLES[S.mode][Number(b.dataset.ex)][1]; $("#request").focus(); }));
  if (!render) return;
  if (mode === "fork") renderRun();
  else renderExtend();
}

// --------------------------------------------------------------------------- toast

let toastTimer = null;
function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    t.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--surface);padding:10px 14px;border-radius:8px;font-size:13px;z-index:50;max-width:min(560px,calc(100vw - 32px));box-shadow:0 8px 24px rgba(0,0,0,.2)";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

// ---------------------------------------------------------------------------- boot

function boot() {
  $$(".segmented button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // A phone stops the video and suspends the timers without telling the page; these are
  // the only three moments it admits to being back. pageshow covers a restore from the
  // back-forward cache, which visibilitychange does not fire for.
  watchBackdrop();
  document.addEventListener("visibilitychange", resumeAfterSuspend);
  window.addEventListener("pageshow", resumeAfterSuspend);

  // ----------------------------------------------------------------- views
  $$(".view-switch button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  const ask = $("#ask"), askIn = $("#ask-input");
  ask.addEventListener("submit", (e) => { e.preventDefault(); startFork(askIn.value, true); });
  // Enter sends, Shift+Enter is a newline — the convention people already have
  // for this shape of box. Ctrl/Cmd+Enter also works, matching the other composer.
  askIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startFork(askIn.value, true); }
  });
  // Grow with the text rather than scrolling a three-line window.
  const grow = () => { askIn.style.height = "auto"; askIn.style.height = Math.min(askIn.scrollHeight, 260) + "px"; };
  askIn.addEventListener("input", grow);
  $("#ask-examples").innerHTML = EXAMPLES.fork.map(([label], i) => `<button type="button" class="chip" data-ex="${i}">${esc(label)}</button>`).join("");
  $$("#ask-examples [data-ex]").forEach((b) => b.addEventListener("click", () => {
    askIn.value = EXAMPLES.fork[Number(b.dataset.ex)][1]; grow(); askIn.focus();
  }));
  $("#home").addEventListener("click", (e) => { e.preventDefault(); setView("simple"); });

  $("#go").addEventListener("click", () => (S.mode === "fork" ? startFork() : startExtend()));
  $("#request").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") $("#go").click();
  });
  $("#model-pill").addEventListener("click", (e) => { e.stopPropagation(); toggleModelPopover(); });
  $("#model-popover").addEventListener("click", (e) => e.stopPropagation());
  $("#pop-refresh").addEventListener("click", () => loadStatus(true));
  document.addEventListener("click", () => toggleModelPopover(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleModelPopover(false); });
  $("#runs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-run]");
    if (b) openRun(b.dataset.run);
  });
  $("#builds").addEventListener("click", (e) => {
    const b = e.target.closest("[data-build]");
    if (b) openBuild(b.dataset.build);
  });
  const deep = location.hash.match(/^#build\/([a-z0-9_-]+)$/);
  if (deep) openBuild(deep[1]);

  setMode("fork", false);
  setView(S.view, false);
  loadStatus();
  loadTemplate();
  loadRuns();
  loadBuilds();
  // The label stays honest between runs too: gateway health can change on its own.
  S.statusTimer = setInterval(() => { if (!S.pollTimer && !S.extendBusy) loadStatus(); }, 20000);
}

boot();

// Forza live coach dashboard. Plain ES module, no build step.
// Data: Server-Sent Events from /events (see src/live/coach.ts for the message shapes).

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtLap = (s) => (s == null ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`);
const fmtDelta = (s, d = 2) => (s == null ? "—" : `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(d)}`);
const sevOf = (dt) => (dt >= 0.05 ? "loss" : dt <= -0.05 ? "gain" : "even");

const STALE_MS = 2500;
const CALLOUT_HOLD_MS = 7000;
const REPORT_HOLD_MS = 12000;
const CUE_HOLD_MS = 6000;
const HIT_HOLD_MS = 3500;
/** Countdown: three short beeps then a long one exactly at the marker (seconds relative to it). */
const COUNT_BEEPS = [-0.75, -0.5, -0.25];
const PLAN_FROM_S = 1.3;

const S = {
  connected: false,
  session: null,
  ref: null,
  frame: null,
  lastFrameAt: 0,
  lap: null, // { lap_id, lap_number, is_outlap, results: {id: result}, trace: [[m, delta]] }
  prev: null, // previous lap: { trace, results }
  callout: null,
  cue: null,
  report: null,
  trail: [],
  voice: false,
  hit: null, // last brake_hit, for the next card
  plan: null, // countdown to the next marker: { key, id, kind, atMs, beeps: [{ off, node, at }], flashed }
  flash: null, // { kind, text, at }
};

// ------------------------------------------------------------------ beeps

const A = { ctx: null, on: true, leadMs: 50 };
try {
  if (localStorage.getItem("forza.beeps") === "0") A.on = false;
  const l = localStorage.getItem("forza.leadMs");
  if (l !== null) A.leadMs = Number(l) || 0;
} catch {}

function audio() {
  if (!A.ctx) {
    try { A.ctx = new AudioContext({ latencyHint: "interactive" }); } catch { return null; }
  }
  if (A.ctx.state === "suspended") A.ctx.resume().catch(() => {});
  return A.ctx;
}

/** performance.now() ms → AudioContext time, compensating the output latency. */
function ctxTime(ms) {
  const c = A.ctx;
  return c.currentTime + (ms - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0);
}

function tone(at, freq, dur, vol = 0.3, type = "square") {
  const c = A.ctx;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.004);
  g.gain.setValueAtTime(vol, Math.max(at + 0.005, at + dur - 0.015));
  g.gain.linearRampToValueAtTime(0, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
  return o;
}

const canBeep = () => A.on && A.ctx && A.ctx.state === "running";

function cancelPlan() {
  const p = S.plan;
  if (p && A.ctx) for (const b of p.beeps) if (b.node && b.at > A.ctx.currentTime + 0.005) { try { b.node.stop(0); } catch {} }
  S.plan = null;
}

/** (Re)schedule the countdown beeps that haven't started yet for the current marker time. */
function scheduleBeeps(p) {
  if (!canBeep()) return;
  const now = A.ctx.currentTime;
  for (const b of p.beeps) {
    const at = ctxTime(p.atMs + b.off * 1000);
    if (b.node && b.at <= now + 0.01) continue; // already playing / played
    if (b.node) { try { b.node.stop(0); } catch {} b.node = null; }
    if (at < now + 0.005) continue; // too late for this one
    const final = b.off === 0;
    b.node = final
      ? tone(at, p.kind === "lift" ? 660 : 1320, 0.28, 0.35)
      : tone(at, 880, 0.06, 0.25);
    b.at = at;
  }
}

/** Every frame: keep the countdown for the next marker in sync with the car. */
function updatePlan(f) {
  const n = f.next;
  const s = n?.mark_in_s;
  const key = n ? `${f.lap_id}:${n.id}` : null;
  if (S.plan && S.plan.key !== key && performance.now() > S.plan.atMs + 300) S.plan = null;
  if (f.delta_s == null || !n || s == null || s > PLAN_FROM_S) return;
  // braking already: the countdown is over (the brake_hit says how it went)
  if (f.brake > 0.15 && n.mark_kind === "brake") {
    if (S.plan?.key === key) { const keep = S.plan; cancelPlan(); S.plan = { ...keep, beeps: [], flashed: true }; }
    return;
  }
  const atMs = performance.now() + s * 1000 - A.leadMs;
  let p = S.plan;
  if (!p || p.key !== key) {
    if (p) cancelPlan();
    p = S.plan = { key, id: n.id, kind: n.mark_kind, atMs, beeps: [...COUNT_BEEPS, 0].map((off) => ({ off, node: null, at: 0 })), flashed: false };
    scheduleBeeps(p);
  } else if (!p.flashed && Math.abs(atMs - p.atMs) > 6) {
    p.atMs = atMs;
    scheduleBeeps(p);
  }
}

function showFlash(kind, txt) {
  const el = $("flash");
  el.dataset.kind = kind;
  text("flashText", txt);
  // restart the CSS animation
  el.hidden = true; void el.offsetWidth; el.hidden = false;
  S.flash = { at: performance.now(), dur: kind === "lock" ? 500 : 650 };
}

$("beepBtn").textContent = A.on ? "Beeps on" : "Beeps off";
$("beepBtn").setAttribute("aria-pressed", String(A.on));
$("leadSel").value = String(A.leadMs);
if (!$("leadSel").value) $("leadSel").value = "50";
$("beepBtn").addEventListener("click", () => {
  A.on = !A.on;
  $("beepBtn").setAttribute("aria-pressed", String(A.on));
  $("beepBtn").textContent = A.on ? "Beeps on" : "Beeps off";
  try { localStorage.setItem("forza.beeps", A.on ? "1" : "0"); } catch {}
  if (A.on && audio()) {
    // let the driver hear the pattern once
    const t0 = A.ctx.currentTime + 0.1;
    COUNT_BEEPS.forEach((o) => tone(t0 + 0.75 + o, 880, 0.06, 0.25));
    tone(t0 + 0.75, 1320, 0.28, 0.35);
  }
  keepAwake();
});
$("leadSel").addEventListener("change", () => {
  A.leadMs = Number($("leadSel").value) || 0;
  try { localStorage.setItem("forza.leadMs", String(A.leadMs)); } catch {}
});

// ------------------------------------------------------------------ stream

function connect() {
  const es = new EventSource("events");
  es.onopen = () => { S.connected = true; };
  es.onerror = () => { S.connected = false; };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
}

function newLap(m) {
  return { lap_id: m.lap_id, lap_number: m.lap_number, is_outlap: m.is_outlap, results: {}, trace: [], marks: {} };
}

function handle(m) {
  switch (m.type) {
    case "init":
      S.session = m.session;
      S.ref = m.reference;
      S.lap = m.lap ? { ...newLap(m.lap), trace: m.lap.trace.slice() } : null;
      if (m.lap) for (const r of m.lap.results) S.lap.results[r.id] = r;
      if (m.lap) for (const k of m.lap.marks ?? []) S.lap.marks[k.id] = k;
      S.frame = m.frame;
      S.report = m.last_lap;
      S.prev = m.prev_lap ? { trace: m.prev_lap.trace, results: Object.fromEntries(m.prev_lap.results.map((r) => [r.id, r])) } : null;
      document.querySelectorAll("#log li").forEach((li) => li.remove());
      for (const r of m.recent.filter((x) => x.type === "lap")) logLap(r);
      if (!m.recent.some((x) => x.type === "lap")) $("log").innerHTML = '<li class="muted">Lap summaries appear here after each lap.</li>';
      buildCorners();
      break;
    case "session":
      S.session = m; S.prev = null; S.trail = []; S.report = null; S.callout = null;
      break;
    case "session_end":
      S.lap = null;
      break;
    case "reference":
      S.ref = m;
      buildCorners();
      break;
    case "no_reference":
      S.ref = null;
      buildCorners();
      break;
    case "lap_start":
      if (S.lap && S.lap.lap_id !== m.lap_id) S.prev = { trace: S.lap.trace, results: S.lap.results, marks: S.lap.marks };
      S.lap = newLap(m);
      S.trail = [];
      S.cue = null;
      break;
    case "frame":
      onFrame(m);
      break;
    case "callout":
      if (S.lap && S.lap.lap_id === m.lap_id) S.lap.results[m.id] = m;
      S.callout = { ...m, at: performance.now() };
      if ((m.severity === "loss" && m.time_delta_s >= 0.1) || (m.severity === "gain" && m.time_delta_s <= -0.2)) say(m.speak);
      break;
    case "brake_hit":
      if (S.lap && S.lap.lap_id === m.lap_id) S.lap.marks[m.id] = m;
      S.hit = { ...m, at: performance.now() };
      if (m.verdict === "on" && canBeep()) { const t = A.ctx.currentTime + 0.02; tone(t, 1046, 0.07, 0.18, "sine"); tone(t + 0.08, 1568, 0.1, 0.18, "sine"); }
      break;
    case "lockup":
      if (!S.lap || S.lap.lap_id !== m.lap_id) break;
      showFlash("lock", "EASE OFF");
      if (canBeep()) tone(A.ctx.currentTime + 0.01, 160, 0.16, 0.3, "sawtooth");
      break;
    case "cue":
      S.cue = { ...m, at: performance.now() };
      say(m.speak, true);
      break;
    case "lap":
      S.report = { ...m, at: performance.now() };
      logLap(m);
      say(lapSpeech(m));
      break;
    case "rewind":
      if (S.lap && S.lap.lap_id === m.lap_id) {
        S.lap.trace = S.lap.trace.filter(([d]) => d <= m.dist_m);
        if (S.ref) for (const c of S.ref.corners) if (c.wraps || c.seg_end > m.dist_m) delete S.lap.results[c.id];
      }
      S.trail = S.trail.filter((p) => p[2] <= m.dist_m);
      cancelPlan();
      break;
  }
}

function onFrame(f) {
  S.frame = f;
  S.lastFrameAt = performance.now();
  if (!S.lap || S.lap.lap_id !== f.lap_id) S.lap = newLap(f);
  const tr = S.lap.trace;
  if (f.delta_s != null && (!tr.length || f.dist_m >= tr[tr.length - 1][0] + 5)) tr.push([f.dist_m, f.delta_s]);
  const last = S.trail[S.trail.length - 1];
  if (!last || Math.hypot(f.x - last[0], f.z - last[1]) > 4) S.trail.push([f.x, f.z, f.dist_m]);
  if (S.trail.length > 4000) S.trail.shift();
  updatePlan(f);
}

// ------------------------------------------------------------------ voice

function say(text, urgent = false) {
  if (!S.voice || !text || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  // Stale advice is worse than none: a cue replaces whatever is queued.
  if (urgent || synth.pending) synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.15;
  synth.speak(u);
}

function lapSpeech(m) {
  const t = m.lap_time_s;
  const parts = [`Lap ${Math.floor(t / 60)} ${(t % 60).toFixed(1)}`];
  if (m.delta_s != null) parts.push(`${m.delta_s >= 0 ? "plus" : "minus"} ${Math.abs(m.delta_s).toFixed(1)}`);
  if (m.focus) parts.push(`Focus: turn ${m.focus.id.slice(1)}`);
  return parts.join(". ") + ".";
}

$("voiceBtn").addEventListener("click", () => {
  S.voice = !S.voice;
  $("voiceBtn").setAttribute("aria-pressed", String(S.voice));
  $("voiceBtn").textContent = S.voice ? "Voice on" : "Voice off";
  try { localStorage.setItem("forza.voice", S.voice ? "1" : "0"); } catch {}
  if (S.voice) say("Voice coaching on.");
  keepAwake();
});
try {
  if (localStorage.getItem("forza.voice") === "1") {
    // Browsers need a tap before speaking; show the preference, enable on first tap anywhere.
    $("voiceBtn").textContent = "Tap to enable voice";
  }
} catch {}

$("fsBtn").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {}
  keepAwake();
});

let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); wakeLock?.addEventListener("release", () => { wakeLock = null; }); } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.voice) keepAwake(); });

// ------------------------------------------------------------------ DOM render

function buildCorners() {
  const ol = $("corners");
  ol.innerHTML = "";
  if (!S.ref) {
    ol.innerHTML = '<li class="muted" style="grid-column:1/-1;border:0;background:none">Corners appear once you have a complete reference lap.</li>';
    return;
  }
  for (const c of S.ref.corners) {
    const li = document.createElement("li");
    li.dataset.id = c.id;
    li.innerHTML = `<div class="cid">${c.id}</div><div class="cdt">—</div><div class="cprev"></div><div class="cbrk"></div>`;
    ol.appendChild(li);
  }
}

function renderCorners() {
  if (!S.ref) return;
  const f = S.frame;
  for (const li of $("corners").children) {
    const id = li.dataset.id;
    if (!id) continue;
    const r = S.lap?.results[id];
    const p = S.prev?.results[id];
    li.dataset.sev = r ? r.severity : "none";
    li.dataset.now = f && f.corner === id ? "1" : "0";
    const dt = li.children[1], pv = li.children[2];
    const txt = r ? `${fmtDelta(r.time_delta_s)} s` : "—";
    if (dt.textContent !== txt) dt.textContent = txt;
    const ptxt = p ? `prev ${fmtDelta(p.time_delta_s)}` : "";
    if (pv.textContent !== ptxt) pv.textContent = ptxt;
    const mk = S.lap?.marks[id] ?? null;
    const bk = li.children[3];
    const btxt = mk ? (mk.verdict === "on" ? "brk ✓" : `brk ${mk.offset_m > 0 ? "+" : "−"}${Math.abs(mk.offset_m)}m`) : "";
    if (bk.textContent !== btxt) bk.textContent = btxt;
    bk.dataset.v = mk?.verdict ?? "";
    li.title = r ? `${r.tip}\n${r.note}` : "";
  }
}

function text(id, v) {
  const el = $(id);
  if (el.textContent !== v) el.textContent = v;
}

function renderHeader(now) {
  const f = S.frame;
  const live = f && now - S.lastFrameAt < STALE_MS;
  const conn = $("conn");
  conn.dataset.state = !S.connected ? "off" : live ? "live" : "idle";
  text("conn", !S.connected ? "offline" : live ? "live" : "waiting for game");
  $("waiting").hidden = !!(S.connected && (live || S.frame));
  text("waitDetail", S.connected ? "Connected to the listener — no packets yet." : "Not connected to the listener. Is `pnpm listen` running?");

  text("lapNo", f ? (f.is_outlap ? "Out lap" : String(f.lap_number + 1)) : "—");
  text("lapTime", f ? fmtLap(f.lap_time_s) : "—");
  text("refLap", S.ref ? fmtLap(S.ref.lap_time_s) + (S.ref.same_car ? "" : "*") : "—");
  $("refLap").title = S.ref && !S.ref.same_car ? "Reference is from a different car on this track" : "";
  text("lastLap", f ? fmtLap(f.last_lap_s) : "—");
  text("bestLap", f ? fmtLap(f.best_lap_s) : "—");
  text("beepBtn", !A.on ? "Beeps off" : canBeep() ? "Beeps on" : "Tap for beeps");
  $("posWrap").hidden = !(f && f.race_position);
  if (f?.race_position) text("pos", `P${f.race_position}`);
}

function renderDelta() {
  const f = S.frame;
  const panel = $("deltaPanel");
  if (!f || f.delta_s == null) {
    panel.dataset.sign = "none";
    text("delta", f?.is_outlap ? "Out lap" : S.ref ? "—" : "No ref");
    text("pred", "—");
    text("trend", "");
    return;
  }
  panel.dataset.sign = f.delta_s <= -0.005 ? "gain" : f.delta_s >= 0.005 ? "loss" : "none";
  text("delta", fmtDelta(f.delta_s));
  text("pred", fmtLap(f.predicted_s));
  // trend: change in delta over the last ~150 m
  const tr = S.lap?.trace ?? [];
  let back = null;
  for (let i = tr.length - 1; i >= 0; i--) if (tr[i][0] <= f.dist_m - 150) { back = tr[i]; break; }
  if (back) {
    const ch = f.delta_s - back[1];
    text("trend", Math.abs(ch) < 0.03 ? "holding" : ch > 0 ? `▲ losing ${ch.toFixed(2)}` : `▼ gaining ${(-ch).toFixed(2)}`);
  } else text("trend", "");
}

function renderCoach(now) {
  const card = $("coachCard");
  const rep = S.report;
  const co = S.callout;
  const showReport = rep && rep.at && now - rep.at < REPORT_HOLD_MS && !(co && co.at > rep.at);
  if (showReport) {
    card.dataset.sev = "lap";
    text("coachHead", `Lap ${rep.lap_number + 1} report`);
    text("coachMain", `${fmtLap(rep.lap_time_s)}${rep.delta_s != null ? ` (${fmtDelta(rep.delta_s, 3)})` : ""}`);
    const html = (rep.focus ? `<div><b>Focus next lap: ${rep.focus.id}</b> — ${esc(rep.focus.tip)}</div>` : `<div>${esc(rep.summary)}</div>`) +
      (rep.losses.length ? `<ol>${rep.losses.map((l) => `<li>${l.id} ${fmtDelta(l.time_delta_s)} s — ${esc(l.tip)}</li>`).join("")}</ol>` : "") +
      (rep.brake_marks?.length ? `<div>${marksLine(rep.brake_marks).replace("<br>", "")}</div>` : "") +
      (rep.theoretical_best_s ? `<div class="muted">Theoretical best ${fmtLap(rep.theoretical_best_s)}</div>` : "");
    if ($("coachSub").innerHTML !== html) $("coachSub").innerHTML = html;
  } else if (co && now - co.at < CALLOUT_HOLD_MS) {
    card.dataset.sev = co.severity;
    text("coachHead", `${co.id} · ${fmtDelta(co.time_delta_s)} s ${co.severity === "loss" ? "lost" : co.severity === "gain" ? "gained" : ""}`);
    text("coachMain", co.tip);
    const html = `<div>${esc(co.note)}</div>`;
    if ($("coachSub").innerHTML !== html) $("coachSub").innerHTML = html;
  } else {
    card.dataset.sev = "none";
    text("coachHead", "Coach");
    const f = S.frame;
    text("coachMain", !S.ref ? "Drive a clean lap — it becomes your reference." : f?.is_outlap ? "Out lap — coaching starts at the line." : "Drive. Each corner is scored when you clear it.");
    const html = S.report?.focus ? `<div>Focus this lap: <b>${S.report.focus.id}</b> — ${esc(S.report.focus.tip)}</div>` : "";
    if ($("coachSub").innerHTML !== html) $("coachSub").innerHTML = html;
  }
}

function renderNext(now) {
  const f = S.frame;
  const card = $("nextCard");
  const n = f?.next;
  if (!n || f.delta_s == null) { card.hidden = true; return; }
  card.hidden = false;
  text("nextId", n.id);
  const word = n.mark_kind === "lift" ? "lift" : "brake";
  const p = S.plan && S.plan.id === n.id && !S.plan.flashed ? S.plan : null;
  const left = p ? Math.max(0, (p.atMs - now) / 1000) : null;
  text("nextIn", left != null ? `${word.toUpperCase()} ${left.toFixed(1)} s` : n.mark_in_m > 0 ? `${word} in ${Math.round(n.mark_in_m)} m` : "braking");
  card.dataset.count = p ? "on" : "off";
  // bar: distance-based far out, time-based in the countdown so it fills exactly at the marker
  const fill = left != null ? 1 - left / PLAN_FROM_S : Math.max(0, 1 - n.mark_in_m / 300) * 0.6;
  $("brakeFill").style.width = `${Math.max(0, Math.min(1, fill)) * 100}%`;
  const hit = S.hit && now - S.hit.at < HIT_HOLD_MS ? S.hit : null;
  $("nextHit").hidden = !hit;
  if (hit) {
    $("nextHit").dataset.v = hit.verdict;
    text("nextHit", hit.verdict === "on" ? `${hit.id} · on the marker` : `${hit.id} · braked ${Math.abs(hit.offset_m)} m ${hit.verdict}`);
  }
  text("nextRef", `Reference: ${word}, ${Math.round(n.ref_min_kmh)} km/h at the apex in gear ${n.ref_gear}`);
  const cue = S.cue && S.cue.id === n.id && now - S.cue.at < CUE_HOLD_MS ? S.cue : null;
  card.dataset.cue = cue ? "on" : "off";
  text("nextLast", cue ? cue.tip : n.last ? `Last lap ${fmtDelta(n.last.time_delta_s)} s — ${n.last.tip}` : "");
}

function renderTele() {
  const f = S.frame;
  if (!f) return;
  text("speed", String(Math.round(f.speed_kmh)));
  text("gear", f.gear === 0 ? "R" : f.gear === 11 ? "N" : String(f.gear));
  const rpmPct = f.rpm_max > 0 ? Math.min(1, f.rpm / f.rpm_max) : 0;
  const rf = $("rpmFill");
  rf.style.width = `${rpmPct * 100}%`;
  rf.classList.toggle("shift", rpmPct > 0.92);
  $("thrFill").style.height = `${f.throttle * 100}%`;
  $("brkFill").style.height = `${f.brake * 100}%`;
  $("steerDot").style.left = `${50 + f.steer * 50}%`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function logLap(m) {
  const ol = $("log");
  ol.querySelector(".muted")?.remove();
  const li = document.createElement("li");
  li.innerHTML = `<b>Lap ${m.lap_number + 1} · ${fmtLap(m.lap_time_s)}</b>${m.delta_s != null ? ` (${fmtDelta(m.delta_s, 3)})` : ""}<br>${
    m.focus ? `Focus: ${m.focus.id} — ${esc(m.focus.tip)}` : esc(m.summary)}${marksLine(m.brake_marks)}${m.theoretical_best_s ? `<br><span class="muted">Theoretical best ${fmtLap(m.theoretical_best_s)}</span>` : ""}`;
  ol.prepend(li);
  while (ol.children.length > 20) ol.lastChild.remove();
}

function marksLine(marks) {
  if (!marks?.length) return "";
  const on = marks.filter((k) => k.verdict === "on").length;
  const early = marks.filter((k) => k.verdict === "early");
  const late = marks.filter((k) => k.verdict === "late");
  const avg = (xs) => Math.round(xs.reduce((s, k) => s + Math.abs(k.offset_m), 0) / xs.length);
  const parts = [`${on}/${marks.length} on the marker`];
  if (early.length) parts.push(`${early.length} early (avg ${avg(early)} m)`);
  if (late.length) parts.push(`${late.length} late (avg ${avg(late)} m)`);
  return `<br>Brakes: ${parts.join(", ")}`;
}

// ------------------------------------------------------------------ canvases

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cv.clientWidth, h: cv.clientHeight };
}

function drawMap() {
  const { ctx, w, h } = fitCanvas($("mapCv"));
  ctx.clearRect(0, 0, w, h);
  const pts = S.ref ? S.ref.map : S.trail;
  if (pts.length < 2) {
    ctx.fillStyle = css("--muted");
    ctx.font = "14px system-ui";
    ctx.fillText("Map appears as you drive.", 8, 20);
    return;
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const pad = 18;
  const sc = Math.min((w - 2 * pad) / (x1 - x0 || 1), (h - 2 * pad) / (z1 - z0 || 1));
  const ox = (w - (x1 - x0) * sc) / 2, oz = (h - (z1 - z0) * sc) / 2;
  const P = (x, z) => [ox + (x - x0) * sc, h - (oz + (z - z0) * sc)];
  const path = (list, from, to) => {
    ctx.beginPath();
    for (let i = from; i <= to && i < list.length; i++) {
      const [px, py] = P(list[i][0], list[i][1]);
      i === from ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
  };
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.strokeStyle = css("--rule");
  ctx.lineWidth = 6;
  path(pts, 0, pts.length - 1);
  ctx.stroke();

  if (S.ref) {
    // corner segments coloured by this lap's result (5 m per map point)
    const seg = (a, b, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 6;
      path(pts, Math.floor(a / 5), Math.ceil(b / 5)); ctx.stroke();
    };
    for (const c of S.ref.corners) {
      const r = S.lap?.results[c.id];
      if (!r || r.severity === "even") continue;
      const col = css(r.severity === "loss" ? "--bad" : "--good");
      if (c.wraps) { seg(c.seg_start, S.ref.length_m, col); seg(0, c.seg_end, col); } else seg(c.seg_start, c.seg_end, col);
    }
    ctx.font = "600 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const placed = [];
    for (const c of S.ref.corners) {
      let [px, py] = P(c.x, c.z);
      // nudge badges that would overlap an earlier one
      for (let tries = 0; tries < 4 && placed.some(([qx, qy]) => Math.hypot(px - qx, py - qy) < 22); tries++) py -= 22;
      placed.push([px, py]);
      ctx.fillStyle = css("--surface-2");
      ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css("--ink-2");
      ctx.fillText(c.id.slice(1), px, py + 0.5);
    }
    // start/finish
    const [sx, sy] = P(pts[0][0], pts[0][1]);
    ctx.fillStyle = css("--ink");
    ctx.fillRect(sx - 2, sy - 8, 4, 16);
  }

  const f = S.frame;
  if (f) {
    const [cx, cy] = P(f.x, f.z);
    ctx.fillStyle = css("--surface");
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css("--series");
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
  }
}

let hoverX = null;
function drawChart() {
  const cv = $("chartCv");
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const cur = S.lap?.trace ?? [];
  const prev = S.prev?.trace ?? [];
  const len = S.ref?.length_m ?? Math.max(1000, cur.length ? cur[cur.length - 1][0] : 0);
  const L = 44, R = 10, T = 8, B = 22;
  const pw = w - L - R, ph = h - T - B;
  let m = 0.3;
  for (const [, d] of cur) m = Math.max(m, Math.abs(d));
  for (const [, d] of prev) m = Math.max(m, Math.abs(d));
  m = Math.min(m, 20);
  const nice = [0.25, 0.5, 1, 2, 3, 5, 10, 20].find((v) => v >= m) ?? 20;
  const X = (d) => L + (d / len) * pw;
  const Y = (v) => T + ph / 2 - (Math.max(-nice, Math.min(nice, v)) / nice) * (ph / 2);

  // grid + axis labels (recessive)
  ctx.font = "11px system-ui";
  ctx.fillStyle = css("--muted");
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = css("--rule");
  ctx.lineWidth = 1;
  for (const v of [-nice, 0, nice]) {
    ctx.globalAlpha = v === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(v === 0 ? "0" : fmtDelta(v, nice < 1 ? 2 : 0), L - 6, Y(v));
  }
  // corner ticks
  if (S.ref) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let lastLabel = -Infinity;
    for (const c of S.ref.corners) {
      const x = X(c.apex);
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      ctx.globalAlpha = 1;
      if (x - lastLabel >= 26) { ctx.fillText(c.id, x, T + ph + 6); lastLabel = x; }
    }
  }
  const line = (tr, color, width) => {
    if (tr.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    tr.forEach(([d, v], i) => (i ? ctx.lineTo(X(d), Y(v)) : ctx.moveTo(X(d), Y(v))));
    ctx.stroke();
  };
  line(prev, css("--series-prev"), 1.5);
  line(cur, css("--series"), 2);
  if (cur.length) {
    const [d, v] = cur[cur.length - 1];
    ctx.fillStyle = css("--surface");
    ctx.beginPath(); ctx.arc(X(d), Y(v), 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css("--series");
    ctx.beginPath(); ctx.arc(X(d), Y(v), 4, 0, Math.PI * 2); ctx.fill();
  }

  // hover crosshair + tooltip
  const tip = $("tip");
  if (hoverX == null || hoverX < L || hoverX > w - R || !cur.length) { tip.hidden = true; return; }
  const dist = ((hoverX - L) / pw) * len;
  const near = (tr) => tr.reduce((b, p) => (!b || Math.abs(p[0] - dist) < Math.abs(b[0] - dist) ? p : b), null);
  const c = near(cur), p = near(prev);
  ctx.strokeStyle = css("--ink-2"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hoverX, T); ctx.lineTo(hoverX, T + ph); ctx.stroke();
  const corner = S.ref?.corners.find((k) => (k.wraps ? dist >= k.seg_start || dist < k.seg_end : dist >= k.seg_start && dist < k.seg_end));
  tip.innerHTML = `${Math.round(dist)} m${corner ? ` · ${corner.id}` : ""}<br>This lap <b>${c && Math.abs(c[0] - dist) < 30 ? fmtDelta(c[1]) + " s" : "—"}</b>` +
    (p ? `<br>Previous ${Math.abs(p[0] - dist) < 30 ? fmtDelta(p[1]) + " s" : "—"}` : "");
  tip.hidden = false;
  tip.style.left = `${Math.min(w - 70, Math.max(70, hoverX))}px`;
  tip.style.top = `${T + 40}px`;
}

const chartCv = $("chartCv");
const setHover = (clientX) => { hoverX = clientX - chartCv.getBoundingClientRect().left; };
chartCv.addEventListener("pointermove", (e) => setHover(e.clientX));
chartCv.addEventListener("pointerdown", (e) => setHover(e.clientX));
chartCv.addEventListener("pointerleave", () => { hoverX = null; });

// ------------------------------------------------------------------ loop

let lastDraw = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (now - lastDraw < 33) return; // ~30 fps is plenty
  lastDraw = now;
  const p = S.plan;
  if (p && !p.flashed && now >= p.atMs) { p.flashed = true; showFlash(p.kind, p.kind === "lift" ? "LIFT" : "BRAKE"); }
  if (S.flash && now - S.flash.at > S.flash.dur) { $("flash").hidden = true; S.flash = null; }
  renderHeader(now);
  renderDelta();
  renderCoach(now);
  renderNext(now);
  renderTele();
  renderCorners();
  drawMap();
  drawChart();
}

document.addEventListener("pointerdown", () => { if (A.on) audio(); });
document.addEventListener("pointerdown", (e) => {
  if (e.target === $("voiceBtn")) return; // that tap toggles it already
  try {
    if (!S.voice && localStorage.getItem("forza.voice") === "1") $("voiceBtn").click();
  } catch {}
}, { once: true });

buildCorners();
connect();
requestAnimationFrame(loop);

// Progress over time. Plain ES module, no build step.
// Data: /api/progress/combos, /api/progress, /api/progress/corner (src/live/server.ts → src/analysis/progress.ts).

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const fmtLap = (s) => (s == null ? "—" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`);
const fmtLapShort = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const fmtSigned = (s, d = 2) => {
  if (s == null) return "—";
  const r = Number(s.toFixed(d)); // −0.001 → "±0.00", not "−0.00"
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${Math.abs(r).toFixed(d)}`;
};
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dayTime = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const pct = (r) => `${Math.round(r * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const S = { combos: [], report: null, corner: null, allTunes: false, charts: [] };

// ------------------------------------------------------------------ state ↔ URL

function readUrl() {
  const q = new URLSearchParams(location.search);
  return { track: q.get("track"), car: q.get("car"), pi: q.get("pi"), last: q.get("last"), all: q.get("all_tunes") === "1", corner: q.get("corner") };
}

function writeUrl(p) {
  const q = new URLSearchParams();
  for (const k of ["track", "car", "pi", "last", "corner"]) if (p[k] != null && p[k] !== "") q.set(k, p[k]);
  if (p.all) q.set("all_tunes", "1");
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

function params() {
  const [track, car, pi] = ($("comboSel").value || "::").split(":");
  return { track, car, pi: S.allTunes ? "" : pi, last: $("lastSel").value, all: S.allTunes, corner: S.corner };
}

function query(p, extra = {}) {
  const q = new URLSearchParams();
  if (p.track) q.set("track", p.track);
  if (p.car) q.set("car", p.car);
  if (p.pi) q.set("pi", p.pi);
  if (p.last) q.set("last", p.last);
  if (p.all) q.set("all_tunes", "1");
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

function showError(msg) {
  $("err").hidden = false;
  $("err").textContent = msg;
  $("pmain").hidden = true;
}

// ------------------------------------------------------------------ loading

async function init() {
  const u = readUrl();
  if (u.last) $("lastSel").value = u.last;
  S.allTunes = u.all;
  S.corner = u.corner;
  $("tunesBtn").setAttribute("aria-pressed", String(S.allTunes));
  try {
    S.combos = (await getJson("/api/progress/combos")).combos;
  } catch (e) {
    return showError(`Couldn't load your data: ${e.message}`);
  }
  if (!S.combos.length) return showError("No clean laps recorded yet. Drive a few laps with `pnpm listen` running, then come back.");
  const sel = $("comboSel");
  sel.innerHTML = S.combos
    .map((c) => {
      const v = `${c.track_ordinal}:${c.car_ordinal}:${c.car_pi ?? ""}`;
      return `<option value="${v}">Track ${c.track_ordinal} · car ${c.car_ordinal} · PI ${c.car_pi ?? "?"} — PB ${c.best_lap} (${c.sessions} session${c.sessions === 1 ? "" : "s"})</option>`;
    })
    .join("");
  const want = S.combos.find((c) => String(c.track_ordinal) === u.track && (!u.car || String(c.car_ordinal) === u.car) && (!u.pi || String(c.car_pi) === u.pi));
  if (want) sel.value = `${want.track_ordinal}:${want.car_ordinal}:${want.car_pi ?? ""}`;
  sel.addEventListener("change", () => { S.corner = null; load(); });
  $("lastSel").addEventListener("change", load);
  $("tunesBtn").addEventListener("click", () => {
    S.allTunes = !S.allTunes;
    $("tunesBtn").setAttribute("aria-pressed", String(S.allTunes));
    load();
  });
  $("detailClose").addEventListener("click", () => { S.corner = null; writeUrl(params()); renderDetail(null); markSelected(); });
  await load();
}

async function load() {
  const p = params();
  writeUrl(p);
  try {
    S.report = await getJson(`/api/progress?${query(p)}`);
  } catch (e) {
    return showError(e.message);
  }
  $("err").hidden = true;
  $("pmain").hidden = false;
  render();
  if (S.corner && S.report.corners.some((c) => c.id === S.corner)) await loadCorner(S.corner);
  else renderDetail(null);
}

async function loadCorner(id) {
  S.corner = id;
  writeUrl(params());
  markSelected();
  try {
    renderDetail(await getJson(`/api/progress/corner?${query(params(), { corner: id })}`));
  } catch (e) {
    renderDetail(null);
    showError(e.message);
  }
}

// ------------------------------------------------------------------ render

/** Sessions with clean laps (the ones that can be plotted) and their indexes into report.sessions. */
function timed(r) {
  const idx = [];
  r.sessions.forEach((s, i) => s.best_s != null && idx.push(i));
  return { idx, sessions: idx.map((i) => r.sessions[i]) };
}

function render() {
  const r = S.report;
  const t = timed(r);
  const first = t.sessions[0];
  const latest = t.sessions[t.sessions.length - 1];

  // tiles
  $("pbVal").textContent = fmtLap(r.personal_best.lap_time_s);
  $("pbSub").textContent = `Session ${r.personal_best.session_id} · ${dayTime(r.personal_best.date)}`;
  const tr = r.trend;
  const verdictText = { improving: "Improving", steady: "Steady", slower: "Slower", worse: "Less consistent", "not enough data": "One session" };
  $("paceVal").textContent = verdictText[tr.pace];
  $("paceSub").innerHTML =
    tr.median_change_s == null
      ? "Drive another session to see a trend"
      : `Median lap <b class="${tr.median_change_s < 0 ? "up-good" : ""}">${fmtSigned(tr.median_change_s)} s</b> since ${day(first.started_at)}`;
  $("consVal").textContent = tr.consistency === "improving" ? "Improving" : verdictText[tr.consistency];
  $("consSub").innerHTML =
    tr.sd_change_s == null
      ? latest.sd_s == null ? "Needs two laps in a session" : `Spread ${latest.sd_s.toFixed(2)} s`
      : `Spread ${first.sd_s.toFixed(2)} → <b class="${tr.sd_change_s < 0 ? "up-good" : ""}">${latest.sd_s.toFixed(2)} s</b>`;
  $("theoVal").textContent = fmtLap(latest.theoretical_s);
  $("theoSub").textContent = `${(latest.best_s - latest.theoretical_s).toFixed(2)} s under that session's best`;

  // coach's read: the summary, one sentence per line
  $("readList").innerHTML = r.summary
    .split(/(?<=\.) (?=[A-Z])/)
    .slice(1)
    .map((s) => `<li>${esc(s)}</li>`)
    .join("");

  // tables
  $("sessionTable").tBodies[0].innerHTML = r.sessions
    .slice()
    .reverse()
    .map(
      (s) => `<tr><td>${s.session_id}</td><td>${dayTime(s.started_at)}</td><td class="num">${s.car_pi ?? "?"}</td>
        <td class="num">${s.clean_laps}</td><td class="num">${s.best}</td><td class="num">${s.median}</td>
        <td class="num">${s.sd_s == null ? "—" : s.sd_s.toFixed(2) + " s"}</td><td class="num">${s.theoretical}</td></tr>`,
    )
    .join("");
  $("pbList").innerHTML = r.pb_history
    .slice()
    .reverse()
    .map(
      (p) => `<li><span class="t">${p.lap_time}</span><span class="d">${dayTime(p.date)} · session ${p.session_id}, lap ${p.lap_number}</span>
        ${p.improvement_s == null ? '<span class="d">first lap</span>' : `<span class="imp">−${p.improvement_s.toFixed(3)} s</span>`}</li>`,
    )
    .join("");
  renderCornerTable(r, t);

  $("changeHead").textContent =
    t.sessions.length >= 2
      ? `Corner time change, ${day(first.started_at)} → ${day(latest.started_at)}`
      : "Corner time change (needs two sessions)";
  drawAll();
}

const STATUS = {
  improved: ["✓", "Improved"],
  regressed: ["!", "Slower"],
  steady: ["–", "Steady"],
  new: ["·", "New"],
};

function renderCornerTable(r, t) {
  const body = $("cornerTable").tBodies[0];
  body.innerHTML = r.corners
    .map((c) => {
      const [icon, label] = STATUS[c.status];
      return `<tr tabindex="0" data-id="${c.id}" aria-selected="false">
        <td><b>${c.id}</b></td>
        <td><span class="status" data-s="${c.status}"><i aria-hidden="true">${icon}</i>${label}</span></td>
        <td class="num">${c.first_median_s.toFixed(2)}</td>
        <td class="num">${c.latest_median_s.toFixed(2)}</td>
        <td class="num">${c.change_s == null ? "—" : fmtSigned(c.change_s)}</td>
        <td class="num">${c.best_ever_s == null ? "—" : c.best_ever_s.toFixed(2)}</td>
        <td class="num">${c.latest_gap_to_best_s == null ? "—" : c.latest_gap_to_best_s.toFixed(2)}</td>
        <td><canvas class="spark" aria-hidden="true"></canvas></td>
        <td class="note">${esc(c.note.replace(/^T\d+: /, ""))}</td>
      </tr>`;
    })
    .join("");
  for (const tr of body.rows) {
    const go = () => loadCorner(tr.dataset.id);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
  }
  markSelected();
}

function markSelected() {
  for (const tr of $("cornerTable").tBodies[0].rows) tr.setAttribute("aria-selected", String(tr.dataset.id === S.corner));
}

function renderDetail(d) {
  $("detail").hidden = !d;
  S.detail = d;
  if (!d) return;
  $("detailHead").textContent = `${d.corner.id} over time`;
  $("detailSum").textContent = d.summary.replace(/^T\d+ on [^:]+: /, "");
  $("detailTable").tBodies[0].innerHTML = d.sessions
    .slice()
    .reverse()
    .map(
      (s) => `<tr><td>${s.session_id}</td><td>${dayTime(s.started_at)}</td><td class="num">${s.laps}</td>
        <td class="num">${s.median_s.toFixed(2)} s</td><td class="num">${s.best_s == null ? "—" : s.best_s.toFixed(2) + " s"}</td>
        <td class="num">${s.brake_m == null ? "lift" : s.brake_m + " m"}</td><td class="num">${Math.round(s.entry_kmh)} km/h</td>
        <td class="num">${Math.round(s.min_kmh)} km/h</td><td class="num">${s.throttle_m == null ? "—" : s.throttle_m + " m"}</td>
        <td class="num">${Math.round(s.exit_kmh)} km/h</td><td class="num">${pct(s.lockup_rate)}</td>
        <td class="num">${pct(s.wheelspin_rate)}</td><td class="num">${pct(s.off_line_rate)}</td></tr>`,
    )
    .join("");
  drawDetail();
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ------------------------------------------------------------------ canvas helpers

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  return { ctx, w: cv.clientWidth, h: cv.clientHeight };
}

/** Clean tick values covering [lo, hi], about `n` of them. */
function ticks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { step, values: out };
}

/** Bar with a 4px rounded data end and a square baseline end. dir: "up" | "right" | "left". */
function bar(ctx, x, y, w, h, dir) {
  const r = Math.min(4, Math.abs(dir === "up" ? h : w) / 2, Math.abs(dir === "up" ? w : h) / 2);
  ctx.beginPath();
  if (dir === "up") {
    ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h);
  } else if (dir === "right") {
    ctx.moveTo(x, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x, y + h);
  } else {
    ctx.moveTo(x + w, y); ctx.lineTo(x + r, y); ctx.arcTo(x, y, x, y + r, r);
    ctx.lineTo(x, y + h - r); ctx.arcTo(x, y + h, x + r, y + h, r); ctx.lineTo(x + w, y + h);
  }
  ctx.closePath();
  ctx.fill();
}

function dot(ctx, x, y, color, r = 4) {
  ctx.fillStyle = css("--surface");
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// ------------------------------------------------------------------ tooltip

const tip = $("tip");
function showTip(x, y, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.max(w / 2 + 6, Math.min(innerWidth - w / 2 - 6, x))}px`;
  tip.style.top = `${Math.max(tip.offsetHeight + 8, y - 10)}px`;
}
const hideTip = () => (tip.hidden = true);
const tipRow = (color, label, value) =>
  `<div class="tr"><span>${color ? `<i style="background:${color}"></i>` : ""}${esc(label)}</span><b>${esc(value)}</b></div>`;

/** Wire hover once per canvas; `hit(x, y)` returns { html, redraw? } or null. */
function hover(cv, hit, redraw) {
  if (cv.dataset.wired) return;
  cv.dataset.wired = "1";
  const move = (e) => {
    const b = cv.getBoundingClientRect();
    const res = hit(e.clientX - b.left, e.clientY - b.top);
    redraw(res?.focus ?? null);
    if (res) showTip(e.clientX, e.clientY, res.html);
    else hideTip();
  };
  cv.addEventListener("pointermove", move);
  cv.addEventListener("pointerdown", move);
  cv.addEventListener("pointerleave", () => { redraw(null); hideTip(); });
}

// ------------------------------------------------------------------ line chart (lap time, corner detail)

/**
 * series: [{ label, color, values: (number|null)[] }]; xs: session objects (started_at, session_id).
 * fmt formats y values for ticks/tooltips; endLabel = index of the series that gets a value at its last point.
 */
function lineChart(cv, xs, series, { fmt, tickFmt = fmt, endLabel = 0 }, focus = null) {
  const { ctx, w, h } = fitCanvas(cv);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.12, 0.05);
  lo -= pad; hi += pad;
  const tk = ticks(lo, hi, 4);
  const L = 58, R = 64, T = 10, B = 26;
  const pw = w - L - R, ph = h - T - B;
  const X = (i) => L + (xs.length === 1 ? pw / 2 : (i / (xs.length - 1)) * pw);
  const Y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;

  ctx.font = "11px system-ui";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const v of tk.values) {
    ctx.strokeStyle = css("--grid");
    ctx.beginPath(); ctx.moveTo(L, Math.round(Y(v)) + 0.5); ctx.lineTo(w - R, Math.round(Y(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = css("--axis-ink");
    ctx.fillText(tickFmt(v), L - 8, Y(v));
  }
  // x labels: dates, thinned so they don't collide
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let lastX = -Infinity;
  xs.forEach((s, i) => {
    const x = X(i);
    if (x - lastX < 54 && i !== xs.length - 1) return;
    if (i === xs.length - 1 && x - lastX < 54 && lastX > -Infinity) return;
    ctx.fillStyle = css("--axis-ink");
    ctx.fillText(day(s.started_at), x, T + ph + 8);
    lastX = x;
  });
  if (focus != null) {
    ctx.strokeStyle = css("--axis");
    ctx.beginPath(); ctx.moveTo(Math.round(X(focus)) + 0.5, T); ctx.lineTo(Math.round(X(focus)) + 0.5, T + ph); ctx.stroke();
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      pen ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v));
      pen = true;
    });
    ctx.stroke();
  }
  for (const s of series) {
    s.values.forEach((v, i) => {
      if (v == null) return;
      const isEnd = i === s.values.length - 1;
      if (isEnd || i === focus || xs.length <= 12) dot(ctx, X(i), Y(v), s.color, i === focus ? 5 : 4);
    });
  }
  // one direct label: the headline series at its last point
  const hs = series[endLabel];
  const lv = hs?.values[hs.values.length - 1];
  if (lv != null) {
    ctx.fillStyle = css("--ink");
    ctx.font = "600 12px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(fmt(lv), X(xs.length - 1) + 10, Y(lv));
  }
  return {
    hit(x) {
      if (x < L - 20 || x > w - R + 30) return null;
      let best = 0;
      xs.forEach((_, i) => Math.abs(X(i) - x) < Math.abs(X(best) - x) && (best = i));
      const s = xs[best];
      return {
        focus: best,
        html:
          `<div class="th">${dayTime(s.started_at)} · session ${s.session_id}</div>` +
          series.map((se) => tipRow(se.color, se.label, se.values[best] == null ? "—" : fmt(se.values[best]))).join(""),
      };
    },
  };
}

// ------------------------------------------------------------------ charts

function drawLaps(focus = null) {
  const r = S.report;
  const { sessions } = timed(r);
  const cv = $("lapCv");
  const ch = lineChart(
    cv,
    sessions,
    [
      { label: "Best", color: css("--s1"), values: sessions.map((s) => s.best_s) },
      { label: "Median", color: css("--s2"), values: sessions.map((s) => s.median_s) },
      { label: "Theoretical best", color: css("--s3"), values: sessions.map((s) => s.theoretical_s) },
    ],
    { fmt: fmtLap, tickFmt: fmtLapShort },
    focus,
  );
  hover(cv, (x, y) => S.lapChart?.hit(x, y), (f) => drawLaps(f));
  S.lapChart = ch;
}

function drawSd(focus = null) {
  const { sessions } = timed(S.report);
  const cv = $("sdCv");
  const { ctx, w, h } = fitCanvas(cv);
  const vals = sessions.map((s) => s.sd_s);
  const max = Math.max(0.1, ...vals.filter((v) => v != null));
  const tk = ticks(0, max * 1.15, 3);
  const top = tk.values[tk.values.length - 1] < max ? max * 1.15 : tk.values[tk.values.length - 1];
  const L = 44, R = 10, T = 16, B = 24;
  const pw = w - L - R, ph = h - T - B;
  const slot = pw / Math.max(1, sessions.length);
  const bw = Math.min(24, slot * 0.6);
  const Y = (v) => T + ph - (v / top) * ph;
  ctx.font = "11px system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  for (const v of tk.values) {
    ctx.strokeStyle = v === 0 ? css("--axis") : css("--grid");
    ctx.beginPath(); ctx.moveTo(L, Math.round(Y(v)) + 0.5); ctx.lineTo(w - R, Math.round(Y(v)) + 0.5); ctx.stroke();
    ctx.fillStyle = css("--axis-ink");
    ctx.fillText(`${v.toFixed(tk.step < 1 ? 1 : 0)} s`, L - 6, Y(v));
  }
  const latest = vals.length - 1;
  ctx.textAlign = "center";
  let lastX = -Infinity;
  sessions.forEach((s, i) => {
    const cx = L + slot * (i + 0.5);
    const v = vals[i];
    if (v != null) {
      ctx.fillStyle = css("--s1");
      ctx.globalAlpha = focus == null || focus === i ? 1 : 0.55;
      bar(ctx, cx - bw / 2, Y(v), bw, Y(0) - Y(v), "up");
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = "top";
    if (cx - lastX >= 54 || i === latest) {
      if (i !== latest || cx - lastX >= 54) {
        ctx.fillStyle = css("--axis-ink");
        ctx.fillText(day(s.started_at), cx, T + ph + 6);
        lastX = cx;
      }
    }
    if (i === latest && v != null) {
      ctx.fillStyle = css("--ink");
      ctx.font = "600 12px system-ui";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${v.toFixed(2)} s`, cx, Y(v) - 4);
      ctx.font = "11px system-ui";
    }
  });
  S.sdHit = (x) => {
    const i = Math.floor((x - L) / slot);
    if (i < 0 || i >= sessions.length) return null;
    const s = sessions[i];
    return {
      focus: i,
      html: `<div class="th">${dayTime(s.started_at)} · session ${s.session_id}</div>` +
        tipRow(null, "Lap-time spread", s.sd_s == null ? "one lap" : `${s.sd_s.toFixed(2)} s`) +
        tipRow(null, "Clean laps", String(s.clean_laps)),
    };
  };
  hover(cv, (x, y) => S.sdHit(x, y), (f) => drawSd(f));
}

function drawChange(focus = null) {
  const r = S.report;
  const rows = r.corners;
  const wrap = $("changeWrap");
  const ROW = 26, T = 6, B = 22;
  wrap.style.height = `${T + B + rows.length * ROW}px`;
  wrap.style.flex = "none";
  const cv = $("changeCv");
  const { ctx, w, h } = fitCanvas(cv);
  const vals = rows.map((c) => c.change_s ?? 0);
  const m = Math.max(0.1, ...vals.map(Math.abs));
  const tk = ticks(-m, m, 4);
  const lim = Math.max(Math.abs(tk.values[0]), Math.abs(tk.values[tk.values.length - 1]), m);
  // corner names in the first 36 px, then room for a value label left of the longest faster bar
  const NAMES = 36, L = NAMES + 52, R = 56;
  const pw = w - L - R;
  const X = (v) => L + ((v + lim) / (2 * lim)) * pw;
  const bh = Math.min(16, ROW - 6);
  ctx.font = "11px system-ui";
  ctx.lineWidth = 1;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (const v of tk.values) {
    ctx.strokeStyle = v === 0 ? css("--axis") : css("--grid");
    ctx.beginPath(); ctx.moveTo(Math.round(X(v)) + 0.5, T); ctx.lineTo(Math.round(X(v)) + 0.5, h - B); ctx.stroke();
    ctx.fillStyle = css("--axis-ink");
    ctx.fillText(v === 0 ? "0" : `${fmtSigned(v, tk.step < 0.1 ? 2 : 1)} s`, X(v), h - B + 6);
  }
  rows.forEach((c, i) => {
    const y = T + i * ROW + (ROW - bh) / 2;
    const v = c.change_s;
    if (focus === i) {
      ctx.fillStyle = css("--surface-2");
      ctx.fillRect(0, T + i * ROW, w, ROW);
    }
    ctx.fillStyle = css("--ink-2");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "12px system-ui";
    ctx.fillText(c.id, NAMES - 6, y + bh / 2);
    if (v == null || v === 0) return;
    ctx.fillStyle = v < 0 ? css("--gain") : css("--loss");
    const x0 = X(0), x1 = X(v);
    if (Math.abs(x1 - x0) >= 1) bar(ctx, Math.min(x0, x1), y, Math.abs(x1 - x0), bh, v < 0 ? "left" : "right");
    if (Math.abs(v) >= 0.05) {
      ctx.fillStyle = css("--ink");
      ctx.textAlign = v < 0 ? "right" : "left";
      ctx.fillText(fmtSigned(v), v < 0 ? x1 - 6 : x1 + 6, y + bh / 2);
    }
  });
  S.changeHit = (x, y) => {
    const i = Math.floor((y - T) / ROW);
    const c = rows[i];
    if (!c) return null;
    return {
      focus: i,
      html: `<div class="th">${c.id} · ${STATUS[c.status][1].toLowerCase()}</div>` +
        tipRow(null, "Typical time", `${c.first_median_s.toFixed(2)} → ${c.latest_median_s.toFixed(2)} s`) +
        tipRow(null, "Change", c.change_s == null ? "—" : `${fmtSigned(c.change_s)} s`) +
        `<div class="small" style="margin-top:4px">${esc(c.note.replace(/^T\d+: /, ""))}</div>`,
    };
  };
  hover(cv, (x, y) => S.changeHit(x, y), (f) => drawChange(f));
  if (!cv.dataset.click) {
    cv.dataset.click = "1";
    cv.addEventListener("click", (e) => {
      const b = cv.getBoundingClientRect();
      const res = S.changeHit(e.clientX - b.left, e.clientY - b.top);
      if (res) loadCorner(S.report.corners[res.focus].id);
    });
  }
}

function drawSparks() {
  const r = S.report;
  const { idx } = timed(r);
  const rows = $("cornerTable").tBodies[0].rows;
  r.corners.forEach((c, k) => {
    const cv = rows[k]?.querySelector("canvas");
    if (!cv) return;
    const { ctx, w, h } = fitCanvas(cv);
    const vs = idx.map((i) => c.medians[i]);
    const ok = vs.filter((v) => v != null);
    if (ok.length < 2) return;
    const lo = Math.min(...ok), hi = Math.max(...ok);
    const X = (i) => 3 + (i / (vs.length - 1)) * (w - 8);
    const Y = (v) => 4 + (hi === lo ? (h - 8) / 2 : ((v - lo) / (hi - lo)) * (h - 8)); // faster (lower) is drawn lower
    ctx.strokeStyle = css("--spark");
    ctx.lineWidth = 1.5;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    vs.forEach((v, i) => v != null && (i ? ctx.lineTo(X(i), h - Y(v)) : ctx.moveTo(X(i), h - Y(v))));
    ctx.stroke();
    const lv = vs[vs.length - 1];
    if (lv != null) {
      ctx.fillStyle = css("--s1");
      ctx.beginPath(); ctx.arc(X(vs.length - 1), h - Y(lv), 3, 0, Math.PI * 2); ctx.fill();
    }
  });
}

function drawDetail(focus = null) {
  const d = S.detail;
  if (!d) return;
  const cv = $("detailCv");
  S.detailChart = lineChart(
    cv,
    d.sessions,
    [
      { label: "Best", color: css("--s1"), values: d.sessions.map((s) => s.best_s) },
      { label: "Typical (median)", color: css("--s2"), values: d.sessions.map((s) => s.median_s) },
    ],
    { fmt: (v) => `${v.toFixed(2)} s`, tickFmt: (v) => `${v.toFixed(1)} s`, endLabel: 1 },
    focus,
  );
  hover(cv, (x, y) => S.detailChart?.hit(x, y), (f) => drawDetail(f));
}

function drawAll() {
  if (!S.report) return;
  drawLaps();
  drawSd();
  drawChange();
  drawSparks();
  drawDetail();
}

let resizeRaf = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(drawAll);
});
matchMedia("(prefers-color-scheme: light)").addEventListener("change", drawAll);

init();

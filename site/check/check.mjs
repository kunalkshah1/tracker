// The repo checker's page: the form, the target chips and the results. worker.mjs does the fetching and checking.
// Everything shown from the repo or PyPI goes in with textContent, never as HTML.

import {
  PLATFORMS, PYTHONS, parseRepo, pickLockfile, toQuery, fromQuery, sortPythons, freeThreaded,
  fixFor, rowsFor, headline, cliCommand, fixPrompt, verdictText, nextSteps, validRef, labVerdict, labFor, canonicalName, gapWheelFor,
  gapWheelFixText,
} from "./check-logic.mjs";

const $ = (id) => document.getElementById(id);
const NAMES = Object.fromEntries(PLATFORMS);
const STATUS_TEXT = { wheel: "✓", source: "source", missing: "can't install", unknown: "unknown", "n/a": "–" };
const STAGES = {
  python: "Starting Python in your browser (about 10 MB the first time)…",
  wheelgap: "Installing wheelgap…",
  tree: "Listing the repository's files on GitHub…",
  files: "Reading its workflows and Dockerfiles…",
  lockfile: "Fetching the lockfile…",
  checking: "Checking every package…",
};
const SHOWN = 60;
const LAB_SHORT = { works: "builds ✓", gil: "builds, GIL on", pure: "builds, pure Python", unsupported: "unsupported here", partial: "no compiled part", broken: "builds, won't load", fails: "won't build", slow: "too slow" };
const LAB_LOOKUPS = 120;

// The tracker's build lab results for the gap rows' packages, from its own per-package files (same origin).
async function loadLab(result) {
  const names = [...new Set(result.rows.filter((r) => r.gaps.length).map((r) => canonicalName(r.name)))]
    .filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && !(n in state.lab))
    .slice(0, LAB_LOOKUPS);
  let next = 0;
  const lane = async () => {
    while (next < names.length) {
      const n = names[next++];
      try {
        const r = await fetch(new URL(`../data/packages/${n}.json`, location.href));
        state.lab[n] = r.ok ? ((await r.json()).builds ?? []) : [];
      } catch {
        state.lab[n] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, lane));
  if (state.result === result) renderTable();
}
const FIX_TEXT = {
  all: (f) => `→ ${f.text}`,
  some: (f) => `→ ${f.text}`,
  loses: () => "only by losing a wheel elsewhere",
  none: () => "no newer wheel",
  private: () => "not looked up (index not known to be PyPI)",
  unchecked: () => "",
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid);
  return e;
}

const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
let seq = 0;
let wheelgapVersion = null;
const state = {
  repo: null, ref: null, root: null, plan: null, detected: null, lockfile: null, pythons: [], platforms: [],
  result: null, fixes: null, gapWheels: null, fixesDone: false, python: null, platform: null, showAll: false, truncated: false, lab: {},
};

function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}

// Re-rendering replaces buttons; this puts keyboard focus back on the one with the same data-key.
function keepFocus(fn) {
  const key = document.activeElement?.dataset?.key;
  fn();
  if (key) document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

function workerFailed(message) {
  status(message, true);
  $("go").disabled = false;
}
worker.onerror = (e) => {
  e.preventDefault();
  workerFailed("The checker stopped (Python couldn't load, or the browser ran out of memory). Reload the page to try again.");
};
worker.onmessageerror = () => workerFailed("The checker sent something the page couldn't read. Reload the page to try again.");

worker.onmessage = ({ data }) => {
  if (data.type === "progress") {
    if (data.id === undefined || data.id === seq) status(STAGES[data.stage] || "Working…"); // not a dropped request's
    return;
  }
  if (data.type === "ready") {
    wheelgapVersion = data.wheelgap;
    if (!state.repo) status(`Ready. wheelgap ${data.wheelgap} is running in your browser.`);
    return;
  }
  if (data.id !== undefined && data.id !== seq) return; // an answer to a request the page has moved on from
  if (data.type === "error") {
    status(data.message, true);
    $("go").disabled = false;
    return;
  }
  if (data.type === "loaded") return onLoaded(data);
  if (data.type === "result") return onResult(data.result);
  if (data.type === "gap-wheels") {
    state.gapWheels = data.gapWheels;
    // Said on the page, not only in the tag's tooltip: a touch screen or a keyboard never shows a title.
    $("gap-wheels-note").textContent = state.gapWheels.text ? `Gap wheels are ${state.gapWheels.unofficial}.` : "";
    $("gap-wheels-text").textContent = state.gapWheels.text;
    $("gap-wheels").hidden = !state.gapWheels.text;
    renderTable();
    return;
  }
  if (data.type === "fixes") {
    state.fixes = data.fixes;
    state.fixesDone = true;
    renderTable();
  }
};

function start(repo, query = null) {
  state.repo = repo;
  state.query = query;
  state.result = null;
  $("out").hidden = true;
  $("go").disabled = true;
  $("repo").value = `${repo.owner}/${repo.name}${repo.ref ? `@${repo.ref}` : ""}`;
  status(wheelgapVersion ? STAGES.tree : STAGES.python);
  worker.postMessage({ id: ++seq, type: "load", repo });
}

function onLoaded({ plan, detected, truncated, ref, root }) {
  Object.assign(state, { plan, detected, truncated, ref, root });
  const q = state.query;
  const lock = (q?.lockfile && plan.lockfiles.find((l) => l.path === q.lockfile)) || pickLockfile(plan.lockfiles, state.repo.dir);
  if (!lock) {
    status("");
    $("go").disabled = false;
    return noLockfile();
  }
  state.lockfile = lock.path;
  state.pythons = sortPythons(q?.pythons?.length ? q.pythons : detected.pythons);
  state.platforms = q?.platforms?.length ? q.platforms : detected.platforms.filter((p) => NAMES[p]);
  if (!state.platforms.length) state.platforms = ["linux-x86_64"];
  state.query = null;
  runCheck();
}

function runCheck() {
  state.fixes = null;
  state.fixesDone = false;
  state.showAll = false;
  const fromCi = state.detected.platforms_from === "ci";
  const options = { pythons: state.pythons, platforms: state.platforms };
  for (const k of ["glibc", "musl", "macos"]) if (fromCi && state.detected[k]) options[k] = state.detected[k];
  history.replaceState(null, "", `?${toQuery({ ...state, repo: { ...state.repo, ref: state.repo.ref } })}`);
  const lock = state.plan.lockfiles.find((l) => l.path === state.lockfile);
  if (!lock.offline) return needsIndex(lock.path);
  status(STAGES.checking);
  worker.postMessage({ id: ++seq, type: "check", root: state.root, lockfile: state.lockfile, options });
}

function onResult(result) {
  state.gapWheels = null;
  $("gap-wheels").hidden = true;
  $("gap-wheels-note").textContent = "";
  $("gap-wheels-text").textContent = "";
  $("go").disabled = false;
  if (result.kind === "needs-index") return needsIndex(state.lockfile);
  if (result.error) {
    status(result.kind === "source" ? `wheelgap couldn't read ${state.lockfile}: ${result.error}` : result.error, true);
    return;
  }
  state.result = result;
  const pys = sortPythons(result.targets.map((t) => t.python));
  if (!pys.includes(state.python)) state.python = pys.find((p) => !result.outside_lock.includes(p)) ?? pys[0];
  if (state.platform && !state.platforms.includes(state.platform)) state.platform = null;
  status(`Checked with wheelgap ${result.wheelgap}, in your browser.`);
  loadLab(result);
  keepFocus(render);
  $("out").hidden = false;
}

function noLockfile() {
  $("out").hidden = false;
  $("verdict").textContent = "No lockfile found";
  $("verdict-detail").textContent = `The repo check reads a uv.lock, poetry.lock, pdm.lock or pylock.toml, and ${state.repo.owner}/${state.repo.name} has none${state.truncated ? " in the part of its file list GitHub returned" : ""}. For a requirements.txt, pixi.lock or pyproject.toml, run uvx wheelgap in a checkout: it looks the packages up on PyPI.`;
  for (const id of ["alerts"]) $(id).replaceChildren();
  hideResultSections(true);
}

function needsIndex(path) {
  $("go").disabled = false;
  $("out").hidden = false;
  status("");
  $("verdict").textContent = `${path.split("/").pop()} needs PyPI lookups`;
  $("verdict-detail").textContent = `It doesn't list each package's files, so the browser check can't read it yet. Run uvx wheelgap ${path} in a checkout instead.`;
  $("alerts").replaceChildren();
  renderSetup();
  hideResultSections(true, true);
}

function hideResultSections(hidden, keepSetup = false) {
  if (hidden) {
    $("next").hidden = true;
    $("verdict").closest("section").classList.remove("clean");
  }
  for (const id of ["targets-title", "gaps-title", "next-title"]) $(id).closest("section").hidden = hidden;
  $("setup-title").closest("section").hidden = hidden && !keepSetup;
}

function render() {
  hideResultSections(false);
  renderVerdict();
  renderSetup();
  renderTargets();
  renderTable();
  renderNext();
}

function renderVerdict() {
  const r = state.result;
  const h = headline(r);
  const card = $("verdict").closest("section");
  const repoName = `${state.repo.owner}/${state.repo.name}`;
  card.classList.toggle("clean", h.gaps === 0 && h.unknown === 0 && h.targets > 0);
  $("verdict").textContent = h.targets === 0 ? `${repoName}'s lockfile leaves out every Python picked` : verdictText(h);
  const steps = nextSteps(state.pythons, state.platforms);
  $("next").hidden = !steps.length;
  $("next-buttons").replaceChildren(...steps.map((s) => el("button", {
    type: "button", class: "chip shortcut", text: `+ ${s.label}`, "data-key": `next:${s.label}`,
    onclick: () => { state.pythons = s.pythons; state.platforms = s.platforms; runCheck(); },
  })));
  $("verdict-detail").textContent = `${repoName} · ${r.lockfile}${state.ref && state.ref !== "HEAD" ? ` at ${state.ref}` : ""} · Python ${sortPythons(state.pythons).join(", ")} on ${state.platforms.length} platform${state.platforms.length === 1 ? "" : "s"}`;
  const alerts = [];
  if (r.outside_lock.length) {
    alerts.push(el("p", { class: "alert warn", text: `${r.lockfile} only allows Python ${r.requires_python}, so it has no wheels for ${r.outside_lock.join(", ")} and those aren't counted. Widening requires-python and re-locking is the first step there.` }));
  }
  if (h.unknown) {
    alerts.push(el("p", { class: "alert warn", text: `${h.unknown} package${h.unknown === 1 ? "" : "s"} couldn't be checked on some targets (marked unknown below), so they aren't counted as having a wheel or not.` }));
  }
  if (r.skipped.length) {
    alerts.push(el("p", { class: "alert", text: `Not checked, since they aren't from PyPI (the project itself, or path, Git and workspace packages): ${r.skipped.slice(0, 8).join(", ")}${r.skipped.length > 8 ? `, and ${r.skipped.length - 8} more` : ""}.` }));
  }
  $("alerts").replaceChildren(...alerts);
}

function chip(label, pressed, onclick, extra = {}) {
  return el("button", { type: "button", class: `chip${extra.shortcut ? " shortcut" : ""}`, "aria-pressed": String(pressed), title: extra.title, "data-key": `chip:${label}`, onclick },
    label, extra.ci ? el("span", { class: "ci", text: "CI" }) : null);
}

function renderSetup() {
  const d = state.detected;
  const ciTargets = new Set(d.found.filter((f) => f.kind === "target").map((f) => f.value));
  const ciPythons = new Set(d.found.filter((f) => f.kind === "python").map((f) => f.value));
  const from = d.platforms_from === "ci"
    ? "The platforms and Pythons marked CI come from the repo's workflows and Dockerfiles."
    : "The repo's workflows and Dockerfiles don't name a platform wheelgap can read, so this starts from the common ones.";
  $("setup-note").textContent = `${from} Add or remove any of them; the check reruns in a moment.`;

  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  $("platform-chips").replaceChildren(...PLATFORMS.map(([p, name]) => chip(name, state.platforms.includes(p), () => {
    const next = toggle(state.platforms, p);
    if (!next.length) return;
    state.platforms = PLATFORMS.map(([q]) => q).filter((q) => next.includes(q));
    runCheck();
  }, { ci: ciTargets.has(p), title: p })));

  const pys = sortPythons([...PYTHONS, ...state.pythons, ...ciPythons]);
  const ft = freeThreaded(state.pythons);
  $("python-chips").replaceChildren(
    ...pys.map((v) => chip(v.endsWith("t") ? `${v} free-threaded` : `Python ${v}`, state.pythons.includes(v), () => {
      const next = toggle(state.pythons, v);
      if (!next.length) return;
      state.pythons = sortPythons(next);
      runCheck();
    }, { ci: ciPythons.has(v) })),
  );
  if (ft && !pys.includes(ft)) {
    $("python-chips").append(chip(`+ ${ft} free-threaded`, false, () => { state.pythons = sortPythons([...state.pythons, ft]); runCheck(); }, { shortcut: true }));
  }

  const locks = state.plan.lockfiles;
  $("lock-pick").hidden = locks.length < 2;
  $("lockfile").replaceChildren(...locks.map((l) => el("option", { value: l.path, selected: l.path === state.lockfile, text: l.offline ? l.path : `${l.path} (not readable here)` })));
  $("lockfile").onchange = () => { state.lockfile = $("lockfile").value; runCheck(); };

  const repoUrl = `https://github.com/${state.repo.owner}/${state.repo.name}/blob/${encodeURIComponent(state.ref || "HEAD")}/`;
  const link = (path, line) => el("a", { href: `${repoUrl}${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`, rel: "noopener" }, el("code", { text: `${path}${line ? `:${line}` : ""}` }));
  const items = [
    el("li", {}, "Lockfile: ", link(state.lockfile)),
    ...d.found.map((f) => el("li", {}, `${f.kind === "target" ? "Platform" : "Python"} ${f.value}, from `, link(f.path, f.line), ` (${f.source})`)),
    ...d.unreadable.map((u) => el("li", {}, "Not read: ", link(u.path, u.line), ` (${u.reason})`)),
  ];
  if (!state.plan.workflows.length) items.push(el("li", { text: "No GitHub Actions workflows." }));
  if (state.plan.more_dockerfiles) items.push(el("li", { text: `${state.plan.more_dockerfiles} more Dockerfiles weren't read.` }));
  if (state.truncated) items.push(el("li", { text: "GitHub listed only part of this large repo's files, so some may have been missed." }));
  $("read-list").replaceChildren(...items);
}

function renderTargets() {
  const r = state.result;
  const pys = sortPythons(r.targets.map((t) => t.python));
  $("python-tabs").replaceChildren(...pys.map((v) => el("button", {
    type: "button", "aria-pressed": String(v === state.python), text: v, "data-key": `py:${v}`,
    onclick: () => { state.python = v; state.platform = null; keepFocus(() => { renderTargets(); renderTable(); }); },
  })));
  const outside = r.outside_lock.includes(state.python);
  const rows = r.targets.filter((t) => t.python === state.python).map((t) => {
    const c = r.per_target[t.label];
    const total = c.wheel + c.source + c.missing + c.unknown;
    const without = c.source + c.missing; // unknown is in the tooltip, never counted as "without a wheel"
    const pct = (k) => (total ? (100 * c[k]) / total : 0);
    const pressed = state.platform === t.platform;
    return el("li", {}, el("button", {
      type: "button", "aria-pressed": String(pressed), "data-key": `platform:${t.platform}`,
      onclick: () => { state.platform = pressed ? null : t.platform; keepFocus(() => { renderTargets(); renderTable(); }); },
    },
    el("span", { class: "pname" }, NAMES[t.platform] || t.platform, el("small", { text: t.platform })),
    el("span", { class: "bar", title: outside ? "not in the lock's Pythons" : `${c.wheel} wheel, ${c.source} from source, ${c.missing} can't install${c.unknown ? `, ${c.unknown} unknown` : ""}` },
      ...["wheel", "source", "missing", "unknown"].map((k) => el("span", { class: `b-${k}`, style: `width:${pct(k)}%` }))),
    el("span", { class: "pct" }, outside ? "–" : without === 0 ? "✓" : String(without), el("small", { text: outside ? "not locked" : without === 0 ? (c.unknown ? `${c.unknown} unknown` : "all wheels") : "without a wheel" }))));
  });
  $("platforms").replaceChildren(...rows);
  $("targets-note").textContent = outside
    ? `${r.lockfile} doesn't allow Python ${state.python}, so there's nothing to count.`
    : "Click a platform to list only its gaps.";
}

function renderTable() {
  const r = state.result;
  if (!r) return;
  const labels = r.targets.filter((t) => t.python === state.python && (!state.platform || t.platform === state.platform));
  let rows = rowsFor(r, state.python);
  if (state.platform) rows = rows.filter((row) => row.here.some((l) => labels.some((t) => t.label === l)));
  $("gaps-title").textContent = `Packages without a wheel on Python ${state.python}${state.platform ? `, ${NAMES[state.platform]}` : ""}`;
  $("gaps-note").textContent = r.outside_lock.includes(state.python)
    ? `${r.lockfile} doesn't allow Python ${state.python} (requires-python ${r.requires_python}), so it has no wheels for it to check. Widen requires-python and re-lock first.`
    : rows.length
      ? `${rows.length} package${rows.length === 1 ? "" : "s"}. The fix column names the lowest newer release with a wheel for every gap that has one, without losing a wheel elsewhere.`
      : "None: every package installs from a wheel here.";
  const shownLab = rows.some((row) => labels.some((t) => row.statuses[t.label] === "source" && labFor(state.lab[canonicalName(row.name)], row.version, t.label)));
  if (shownLab) {
    $("gaps-note").textContent += " Under a source build, what the tracker's build lab saw building that release from source on GitHub's runners, which have compilers and many system libraries preinstalled (hover for details).";
  }
  const shown = state.showAll ? rows : rows.slice(0, SHOWN);
  const head = el("thead", {}, el("tr", {},
    el("th", { scope: "col", text: "Package" }),
    ...labels.map((t) => el("th", { scope: "col", text: NAMES[t.platform] || t.platform, title: t.label })),
    el("th", { scope: "col", text: "Fix" })));
  const body = el("tbody", {}, ...shown.map((row) => {
    const f = fixFor(row, state.fixes);
    const gapWheelFix = f.kind === "none" || f.kind === "loses" ? gapWheelFixText(row, state.gapWheels) : null;
    const fixText = gapWheelFix ?? (f.kind === "pending" ? (state.fixesDone ? "not looked up" : "…") : FIX_TEXT[f.kind](f));
    return el("tr", {},
      el("td", { class: "pkg" }, el("a", { href: `https://pypi.org/project/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version || "")}`, rel: "noopener", text: row.name }), el("span", { class: "ver", text: row.version || "" })),
      ...labels.map((t) => {
        const s = row.statuses[t.label];
        if (s === "n/a") return el("td", {}, el("span", { class: "na", text: "–", title: "not installed on this target" }));
        const lab = s === "source" ? labFor(state.lab[canonicalName(row.name)], row.version, t.label) : null;
        const v = lab ? labVerdict(lab) : null;
        return el("td", {}, el("span", { class: `status s-${s}`, text: STATUS_TEXT[s] || s }),
          v ? el("span", { class: `lab lab-${v.kind}`, text: LAB_SHORT[v.kind], title: `Build lab, ${lab.date} on ${lab.runner}: ${v.text}` }) : null,
          gapWheelFor(row, state.gapWheels, t.label)
            ? el("span", { class: "lab", text: "gap wheel", title: state.gapWheels.unofficial })
            : null);
      }),
      el("td", { class: `fix fix-${f.kind}`, text: fixText }));
  }));
  $("gap-table").replaceChildren(head, body);
  $("gap-table").hidden = !rows.length;
  $("more").hidden = state.showAll || rows.length <= SHOWN;
  $("more").textContent = `Show all ${rows.length}`;
}

function renderNext() {
  const r = state.result;
  $("cli").textContent = cliCommand(r, state.pythons, state.platforms);
  const caveats = [
    "A wheel on PyPI means pip and uv install it without compiling; it doesn't test that the package works there.",
    "Checked from the files your lockfile lists, for the versions it pins. Packages it leaves out on a platform show as –.",
  ];
  if (state.pythons.some((v) => v.endsWith("t"))) {
    caveats.unshift("Free-threaded: a cp3XXt wheel means it installs; whether it's thread-safe without the GIL is up to the package.");
  }
  $("caveats").replaceChildren(...caveats.map((c) => el("li", { text: c })));
}

async function copy(button, text, done) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = done;
    button.classList.add("done");
    setTimeout(() => { button.textContent = old; button.classList.remove("done"); }, 1800);
  } catch {
    status("Couldn't copy: your browser blocked the clipboard.", true);
  }
}

$("copy-link").onclick = (e) => copy(e.currentTarget, location.href, "Link copied");
$("copy-prompt").onclick = (e) => copy(e.currentTarget, fixPrompt(`${state.repo.owner}/${state.repo.name}`, state.result, state.fixes, state.pythons, state.platforms, state.gapWheels), "Prompt copied");
$("copy-gap-wheels").onclick = (e) => copy(e.currentTarget, state.gapWheels.text, "Gap wheel instructions copied");
$("more").onclick = () => { state.showAll = true; renderTable(); };

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  let text = $("repo").value.trim();
  let ref = null;
  const at = text.match(/^([^\s@]+\/[^\s@]+)@([A-Za-z0-9._\/-]+)$/); // owner/name@ref
  if (at) [, text, ref] = at;
  const repo = parseRepo(text);
  if (!repo) return status("That doesn't look like a GitHub repository. Try owner/name or a github.com URL.", true);
  if (ref) {
    if (!validRef(ref)) return status("That branch or tag name isn't one this page can read.", true);
    repo.ref = ref;
  }
  start(repo);
});
for (const b of document.querySelectorAll("[data-repo]")) b.addEventListener("click", () => start(parseRepo(b.dataset.repo)));

const initial = fromQuery(location.search);
if (initial) start(initial.repo, initial);

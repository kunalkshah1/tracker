// node --test tests/site/check-logic.test.mjs: the repo checker's pure helpers (site/check/check-logic.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepo, rawUrl, pickLockfile, toQuery, fromQuery, sortPythons, freeThreaded, fixFor, rowsFor, headline,
  cliCommand, fixPrompt, verdictText, nextSteps, validRef, labVerdict, labFor, canonicalName, gapWheelFor,
} from "../../site/check/check-logic.mjs";

test("parseRepo reads the forms people paste", () => {
  const plain = { owner: "fastapi", name: "fastapi", ref: null, dir: null };
  assert.deepEqual(parseRepo("fastapi/fastapi"), plain);
  assert.deepEqual(parseRepo("https://github.com/fastapi/fastapi"), plain);
  assert.deepEqual(parseRepo("github.com/fastapi/fastapi.git/"), plain);
  assert.deepEqual(parseRepo("git@github.com:fastapi/fastapi.git"), plain);
  assert.deepEqual(parseRepo("https://www.github.com/fastapi/fastapi?tab=readme#top"), plain);
  assert.deepEqual(parseRepo("https://github.com/o/r/tree/dev/backend/api"), { owner: "o", name: "r", ref: "dev", dir: "backend/api" });
  assert.deepEqual(parseRepo("https://github.com/o/r/blob/main/backend/uv.lock"), { owner: "o", name: "r", ref: "main", dir: "backend" });
  assert.deepEqual(parseRepo("https://github.com/o/r/blob/main/uv.lock"), { owner: "o", name: "r", ref: "main", dir: null });
});

test("parseRepo refuses what isn't a repo", () => {
  for (const bad of ["", "fastapi", "https://gitlab.com/a", "a b/c", "../x", "o/..", "o/r/tree/main/../../etc", "javascript:alert(1)", "o/r/tree/ma in/x"]) {
    assert.equal(parseRepo(bad), null, bad);
  }
});

test("rawUrl encodes each path segment", () => {
  assert.equal(rawUrl({ owner: "o", name: "r" }, "HEAD", "a b/uv.lock"), "https://raw.githubusercontent.com/o/r/HEAD/a%20b/uv.lock");
  assert.equal(rawUrl({ owner: "o", name: "r" }, "feat/x", "uv.lock"), "https://raw.githubusercontent.com/o/r/feat/x/uv.lock");
});

test("pickLockfile prefers the URL's folder, then the first readable one", () => {
  const locks = [
    { path: "requirements.txt", offline: false },
    { path: "uv.lock", offline: true },
    { path: "backend/uv.lock", offline: true },
  ];
  assert.equal(pickLockfile(locks, null).path, "uv.lock");
  assert.equal(pickLockfile(locks, "backend").path, "backend/uv.lock");
  assert.equal(pickLockfile([{ path: "requirements.txt", offline: false }], null).path, "requirements.txt");
  assert.equal(pickLockfile([], null), null);
});

test("a result's query round-trips, and unknown values are dropped", () => {
  const state = { repo: { owner: "o", name: "r", ref: "dev" }, lockfile: "backend/uv.lock", pythons: ["3.14", "3.14t"], platforms: ["linux-aarch64", "win-arm64"] };
  const q = toQuery(state);
  assert.equal(q, "repo=o/r&ref=dev&lock=backend/uv.lock&py=3.14,3.14t&t=linux-aarch64,win-arm64");
  const back = fromQuery(`?${q}`);
  assert.deepEqual(back, { repo: { owner: "o", name: "r", ref: "dev", dir: null }, lockfile: "backend/uv.lock", pythons: ["3.14", "3.14t"], platforms: ["linux-aarch64", "win-arm64"] });
  const odd = fromQuery("?repo=o/r&lock=../x&py=3.14,2.7,evil&t=linux-x86_64,amiga");
  assert.equal(odd.lockfile, null);
  assert.deepEqual(odd.pythons, ["3.14"]);
  assert.deepEqual(odd.platforms, ["linux-x86_64"]);
  assert.equal(fromQuery("?repo=nope"), null);
  assert.equal(fromQuery(""), null);
});

test("Pythons sort with each free-threaded build after its own", () => {
  assert.deepEqual(sortPythons(["3.15t", "3.13", "3.15", "3.14t", "3.14", "3.14"]), ["3.13", "3.14", "3.14t", "3.15", "3.15t"]);
  assert.equal(freeThreaded(["3.12", "3.14"]), "3.14t");
  assert.equal(freeThreaded(["3.10", "3.11"]), "3.13t"); // free-threading starts at 3.13
  assert.equal(freeThreaded(["3.14", "3.14t"]), null);
});

const row = (name, version, gaps, statuses = {}, extra = {}) => ({ name, version, gaps, unknown: [], keep: [], statuses, lookup: true, ...extra });

test("fixFor says one release, some, none, or not looked up", () => {
  const r = row("numpy", "1.26.4", ["3.14 linux-x86_64", "3.14 win-arm64"]);
  assert.deepEqual(fixFor(r, null), { kind: "pending", text: "" });
  assert.deepEqual(fixFor(r, { "numpy==1.26.4": { found: {}, loses: [] } }), { kind: "none", text: "no newer release has a wheel" });
  const all = fixFor(r, { "numpy==1.26.4": { found: { "3.14 linux-x86_64": "2.3.2", "3.14 win-arm64": "2.3.2" }, loses: [] } });
  assert.deepEqual(all, { kind: "all", version: "2.3.2", text: "2.3.2 (a new major version)" });
  const some = fixFor(r, { "numpy==1.26.4": { found: { "3.14 linux-x86_64": "1.26.5" }, loses: [] } });
  assert.deepEqual(some, { kind: "some", version: "1.26.5", text: "1.26.5 for 1 of 2 gaps" });
});

const result = {
  lockfile: "uv.lock",
  packages: 10,
  outside_lock: ["3.15"],
  targets: [
    { label: "3.14 linux-x86_64", python: "3.14", platform: "linux-x86_64" },
    { label: "3.14 win-arm64", python: "3.14", platform: "win-arm64" },
    { label: "3.15 linux-x86_64", python: "3.15", platform: "linux-x86_64" },
  ],
  rows: [
    row("a", "1.0", ["3.14 win-arm64"], { "3.14 linux-x86_64": "wheel", "3.14 win-arm64": "source", "3.15 linux-x86_64": "missing" }),
    row("b", "2.0", ["3.14 linux-x86_64", "3.14 win-arm64"], { "3.14 linux-x86_64": "missing", "3.14 win-arm64": "missing", "3.15 linux-x86_64": "wheel" }),
  ],
};

test("rowsFor lists one Python's gaps, most first; headline counts distinct packages on counted targets", () => {
  assert.deepEqual(rowsFor(result, "3.14").map((r) => [r.name, r.here.length]), [["b", 2], ["a", 1]]);
  assert.deepEqual(rowsFor(result, "3.15"), []); // outside the lock: check() reports no gaps there
  assert.deepEqual(headline(result), { gaps: 2, unknown: 0, packages: 10, targets: 2 });
});

test("the CLI command and the fix prompt reproduce the check", () => {
  assert.equal(cliCommand(result, ["3.14t", "3.14"], ["linux-x86_64", "win-arm64"]), "uvx wheelgap uv.lock -p 3.14,3.14t -t linux-x86_64,win-arm64");
  assert.equal(cliCommand({ lockfile: "my app/uv.lock" }, ["3.14"], ["linux-x86_64"]), "uvx wheelgap 'my app/uv.lock' -p 3.14 -t linux-x86_64");
  const fixes = { "a==1.0": { found: { "3.14 win-arm64": "1.1" }, loses: [] }, "b==2.0": { found: {}, loses: [] } };
  const prompt = fixPrompt("o/r", result, fixes, ["3.14"], ["linux-x86_64", "win-arm64"]);
  assert.match(prompt, /- a 1\.0 -> 1\.1\n/);
  assert.match(prompt, /No newer release has a wheel for these[^\n]*\n- b 2\.0: 3\.14 linux-x86_64, 3\.14 win-arm64/);
  assert.match(prompt, /uvx wheelgap uv\.lock -p 3\.14 -t linux-x86_64,win-arm64/);
  assert.doesNotMatch(prompt, /weren't looked up/);
  assert.match(fixPrompt("o/r", result, null, ["3.14"], ["linux-x86_64"]), /weren't looked up on PyPI/);
});

test("the verdict reads right for one target and many", () => {
  assert.equal(verdictText({ gaps: 1, packages: 77, targets: 1 }), "1 of 77 packages has no wheel for this target");
  assert.equal(verdictText({ gaps: 5, packages: 79, targets: 4 }), "5 of 79 packages have no wheel for at least one of the 4 targets");
  assert.equal(verdictText({ gaps: 0, packages: 10, targets: 1 }), "✓ All 10 packages have a wheel for this target");
  assert.equal(verdictText({ gaps: 0, packages: 10, targets: 6 }), "✓ All 10 packages have a wheel for all 6 targets");
});

test("next steps offer what isn't picked yet, as whole selections", () => {
  const steps = nextSteps(["3.14"], ["linux-x86_64"]);
  assert.deepEqual(steps.map((s) => s.label), ["Free-threaded 3.14t", "Windows on ARM", "Linux ARM64", "Alpine Linux", "Python 3.15", "Everything"]);
  assert.deepEqual(steps[0], { label: "Free-threaded 3.14t", pythons: ["3.14", "3.14t"], platforms: ["linux-x86_64"] });
  assert.deepEqual(steps[3].platforms, ["linux-x86_64", "musl-x86_64", "musl-aarch64"]);
  assert.equal(steps.at(-1).platforms.length, 8);
  const all = ["linux-x86_64", "linux-aarch64", "musl-x86_64", "musl-aarch64", "macos-arm64", "macos-x86_64", "win-amd64", "win-arm64"];
  assert.deepEqual(nextSteps(["3.15", "3.15t"], all), []);
});

test("fixFor: a bump that drops a wheel elsewhere isn't 'no newer wheel', and private packages aren't looked up", () => {
  const r = row("foo", "1.0", ["3.13 linux-aarch64"]);
  const loses = fixFor(r, { "foo==1.0": { found: {}, loses: ["3.13 linux-aarch64"] } });
  assert.equal(loses.kind, "loses");
  const priv = row("corp-utils", "1.0", ["3.13 linux-x86_64"], {}, { lookup: false });
  assert.equal(fixFor(priv, { "corp-utils==1.0": { found: { "3.13 linux-x86_64": "9.9" }, loses: [] } }).kind, "private");
  assert.equal(fixFor(row("x", "1", [], {}, { unknown: ["3.13 linux-x86_64"] }), {}).kind, "unchecked");
  const res = { ...result, rows: [r, priv] };
  const prompt = fixPrompt("o/r", res, { "foo==1.0": { found: {}, loses: ["3.13 linux-aarch64"] } }, ["3.13"], ["linux-aarch64"]);
  assert.match(prompt, /trades one gap for another[^\n]*\n- foo 1\.0: 3\.13 linux-aarch64/);
  assert.match(prompt, /doesn't record their index as PyPI[^\n]*\n- corp-utils 1\.0/);
  assert.doesNotMatch(prompt, /don't come from PyPI/);
  assert.doesNotMatch(prompt, /No newer release has a wheel/);
  assert.doesNotMatch(prompt, /9\.9/);
});

test("unknown cells are listed but not counted as missing a wheel", () => {
  const res = {
    ...result,
    outside_lock: [],
    rows: [row("u", "1", [], { "3.14 linux-x86_64": "unknown", "3.14 win-arm64": "wheel" }, { unknown: ["3.14 linux-x86_64"] })],
  };
  assert.deepEqual(headline(res), { gaps: 0, unknown: 1, packages: 10, targets: 3 });
  assert.deepEqual(rowsFor(res, "3.14").map((r) => r.name), ["u"]);
  assert.equal(verdictText(headline(res)), "No package is missing a wheel, but 1 of 10 couldn't be checked on some targets");
});

test("refs with '..' or empty segments are refused", () => {
  assert.ok(validRef("main") && validRef("feature/x") && validRef("v1.2.3"));
  for (const bad of ["..", "a/../b", "a//b", "/a", "a/", ".", "a b"]) assert.equal(validRef(bad), false, bad);
  assert.equal(parseRepo("https://github.com/o/r/tree/../../other/repo"), null);
  assert.equal(fromQuery("?repo=o/r&ref=../../x/y").repo.ref, null);
});

test("the checker's lab verdicts match the tracker's", async () => {
  const { createRequire } = await import("node:module");
  const site = createRequire(import.meta.url)("../../site/logic.js");
  const base = { outcome: "built", seconds: 87, wheel: "cp314-cp314-win_arm64", extensions: 1, import: "ok", gil: null, reason: null };
  const cases = [
    {}, { gil: "kept-off", seconds: 289 }, { gil: "re-enabled" }, { extensions: 0, wheel: "py3-none-any" }, { extensions: 0 },
    { import: "failed" }, { import: "deps-failed" }, { outcome: "failed", reason: "needs OpenSSL" }, { outcome: "failed", reason: "other" }, { outcome: "failed", reason: "unsupported platform" },
    { outcome: "timeout", seconds: 2400 },
  ];
  for (const c of cases) assert.deepEqual(labVerdict({ ...base, ...c }), site.labVerdict({ ...base, ...c }), JSON.stringify(c));
});

test("a lab result counts only for its own release and target", () => {
  const builds = [{ target: "3.14 win-arm64", version: "0.14.0", outcome: "built" }];
  assert.equal(labFor(builds, "0.14.0", "3.14 win-arm64").outcome, "built");
  assert.equal(labFor(builds, "0.13.0", "3.14 win-arm64"), null);
  assert.equal(labFor(builds, "0.14.0", "3.14t win-arm64"), null);
  assert.equal(labFor("nope", "0.14.0", "3.14 win-arm64"), null);
  assert.equal(canonicalName("Typing_Extensions.x"), "typing-extensions-x");
});


test("the copy prompt includes only the driver’s gap wheel instructions", () => {
  const result = { lockfile: "uv.lock", rows: [] };
  const gapWheels = {
    cells: [{ name: "fastlib", version: "2.0.0", target: "3.13 win-amd64" }],
    text: "[[tool.uv.index]]\nname = \"wheelgap\"",
    unofficial: "unofficial, built by wheelgap",
  };
  assert.equal(gapWheelFor({ name: "fastlib", version: "2.0.0" }, gapWheels, "3.13 win-amd64"), true);
  assert.equal(gapWheelFor({ name: "fastlib", version: "2.0.1" }, gapWheels, "3.13 win-amd64"), false);
  const prompt = fixPrompt("o/r", result, {}, ["3.13"], ["win-amd64"], gapWheels);
  assert.match(prompt, /unofficial, built by wheelgap/);
  assert.ok(prompt.includes(gapWheels.text));
});

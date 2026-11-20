"""site/check/driver.py, the repo checker's Python side, under CPython with the wheelgap release worker.mjs pins.

CI runs this file with `--with wheelgap==<that version>`; without wheelgap (the plain test run) it's skipped.
"""

import json
import re
import sys
from pathlib import Path

import pytest

pytest.importorskip("wheelgap.suggest_targets")

SITE = Path(__file__).resolve().parent.parent / "site" / "check"
sys.path.insert(0, str(SITE))
import driver

LOCK = """\
version = 1
revision = 3
requires-python = ">=3.13"

[[package]]
name = "demo"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "fastlib" },
    { name = "purewheel" },
    { name = "winonly", marker = "sys_platform == 'win32'" },
]

[[package]]
name = "fastlib"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/aa/fastlib-2.0.0.tar.gz", hash = "sha256:00", size = 1 }
wheels = [
    { url = "https://files.pythonhosted.org/packages/aa/fastlib-2.0.0-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", hash = "sha256:00", size = 1 },
    { url = "https://files.pythonhosted.org/packages/aa/fastlib-2.0.0-cp313-cp313-musllinux_1_2_aarch64.whl", hash = "sha256:00", size = 1 },
]

[[package]]
name = "purewheel"
version = "3.1"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/aa/purewheel-3.1-py3-none-any.whl", hash = "sha256:00", size = 1 },
]

[[package]]
name = "winonly"
version = "1.0"
source = { registry = "https://pypi.org/simple" }
wheels = [
    { url = "https://files.pythonhosted.org/packages/aa/winonly-1.0-cp313-cp313-win_amd64.whl", hash = "sha256:00", size = 1 },
]
"""

WORKFLOW = """\
on: push
jobs:
  test:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/setup-python@v6
        with:
          python-version: "3.13"
"""


@pytest.fixture
def repo(tmp_path):
    (tmp_path / "uv.lock").write_text(LOCK, encoding="utf-8")
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "workflows" / "ci.yml").write_text(WORKFLOW, encoding="utf-8")
    (tmp_path / "deploy").mkdir()
    (tmp_path / "deploy" / "Dockerfile").write_text("FROM python:3.13-alpine\n", encoding="utf-8")
    return tmp_path


def test_worker_pins_the_tested_wheelgap():
    import wheelgap

    pin = re.search(r'WHEELGAP = "wheelgap==([^"]+)"', (SITE / "worker.mjs").read_text(encoding="utf-8"))
    assert pin and pin.group(1) == wheelgap.__version__


def test_plan_picks_files_like_suggest_targets():
    paths = [
        "README.md",
        "uv.lock",
        "backend/uv.lock",
        "backend/requirements.txt",
        "node_modules/x/uv.lock",
        ".venv/lib/poetry.lock",
        ".github/workflows/ci.yml",
        ".github/workflows/notes.md",
        ".github/workflows/sub/inner.yml",
        "Dockerfile",
        "deploy/Containerfile",
        "deploy/Dockerfile.j2",
        ".devcontainer/Dockerfile",
        ".python-version",
    ]
    plan = json.loads(driver.plan(json.dumps(paths)))
    assert plan["lockfiles"] == [
        {"path": "uv.lock", "offline": True},
        {"path": "backend/uv.lock", "offline": True},
        {"path": "backend/requirements.txt", "offline": False},
    ]
    assert plan["workflows"] == [".github/workflows/ci.yml"]
    assert plan["dockerfiles"] == ["Dockerfile", "deploy/Containerfile"]
    assert plan["templates"] == ["deploy/Dockerfile.j2"]
    assert plan["python_version"] == ".python-version"


def test_detect_reads_ci_and_dockerfiles(repo):
    d = json.loads(driver.detect(str(repo)))
    assert d["platforms_from"] == "ci" and d["python_from"] == "ci"
    assert set(d["platforms"]) == {"linux-aarch64", "musl-x86_64"}
    assert d["pythons"] == ["3.13"]
    assert {(f["kind"], f["value"], f["path"]) for f in d["found"]} >= {
        ("target", "linux-aarch64", ".github/workflows/ci.yml"),
        ("target", "musl-x86_64", "deploy/Dockerfile"),
    }


def test_detect_falls_back_to_python_version_then_defaults(tmp_path):
    d = json.loads(driver.detect(str(tmp_path)))
    assert d["platforms_from"] == "default" and d["python_from"] == "default"
    assert d["platforms"] == ["linux-x86_64", "linux-aarch64", "macos-arm64", "win-amd64"]
    (tmp_path / ".python-version").write_text("# pinned\n3.12.4\n", encoding="utf-8")
    d = json.loads(driver.detect(str(tmp_path)))
    assert d["pythons"] == ["3.12"] and d["python_from"] == ".python-version"


def options(**kw):
    return json.dumps({"pythons": ["3.13"], "platforms": ["linux-x86_64", "linux-aarch64", "musl-aarch64"]} | kw)


def test_check_lists_gap_rows_and_counts(repo):
    r = json.loads(driver.check(str(repo), "uv.lock", options()))
    assert r["lockfile"] == "uv.lock" and r["outside_lock"] == [] and r["skipped"] == ["demo"]
    assert [row["name"] for row in r["rows"]] == ["fastlib"]
    fast = r["rows"][0]
    assert fast["gaps"] == ["3.13 linux-aarch64"]
    assert fast["keep"] == ["3.13 linux-x86_64", "3.13 musl-aarch64"]
    assert fast["unknown"] == [] and fast["lookup"] is True
    assert fast["statuses"]["3.13 linux-aarch64"] == "source"
    # winonly isn't installed off Windows: n/a, not a gap, and not counted.
    assert r["per_target"]["3.13 linux-x86_64"] == {"wheel": 2, "source": 0, "missing": 0, "unknown": 0}
    assert r["per_target"]["3.13 linux-aarch64"] == {"wheel": 1, "source": 1, "missing": 0, "unknown": 0}


def test_check_doesnt_count_pythons_outside_the_lock(repo):
    (repo / "uv.lock").write_text(LOCK.replace('">=3.13"', '">=3.13, <3.14"'), encoding="utf-8")
    r = json.loads(driver.check(str(repo), "uv.lock", options(pythons=["3.13", "3.14"])))
    assert r["outside_lock"] == ["3.14"]
    assert all(g.startswith("3.13 ") for row in r["rows"] for g in row["gaps"])
    assert r["per_target"]["3.14 linux-x86_64"] == {"wheel": 0, "source": 0, "missing": 0, "unknown": 0}


def test_check_refuses_lockfiles_that_need_an_index(repo):
    (repo / "requirements.txt").write_text("numpy==2.3.4\n", encoding="utf-8")
    assert json.loads(driver.check(str(repo), "requirements.txt", options()))["kind"] == "needs-index"
    assert json.loads(driver.check(str(repo), "uv.lock", options(platforms=["amiga"])))["kind"] == "targets"
    (repo / "uv.lock").write_text("not toml [", encoding="utf-8")
    bad = json.loads(driver.check(str(repo), "uv.lock", options()))
    assert bad["kind"] == "source" and str(repo) not in bad["error"]


def wheel(name):
    return {"filename": name, "yanked": False, "requires_python": None, "packagetype": "bdist_wheel"}


def test_fixes_names_the_nearest_release_with_a_wheel(repo):
    r = json.loads(driver.check(str(repo), "uv.lock", options()))
    releases = {
        "fastlib": {
            "2.0.0": [wheel("fastlib-2.0.0-cp313-cp313-manylinux_2_17_x86_64.whl")],
            "2.1.0": [wheel("fastlib-2.1.0-cp313-cp313-manylinux_2_17_x86_64.whl")],  # still no aarch64
            "2.2.0": [
                wheel("fastlib-2.2.0-cp313-cp313-manylinux_2_17_x86_64.whl"),
                wheel("fastlib-2.2.0-cp313-cp313-manylinux_2_17_aarch64.whl"),
                wheel("fastlib-2.2.0-cp313-cp313-musllinux_1_2_aarch64.whl"),
            ],
        }
    }
    fx = json.loads(driver.fixes(json.dumps(releases), json.dumps(r["rows"])))
    assert fx == {"fastlib==2.0.0": {"found": {"3.13 linux-aarch64": "2.2.0"}, "loses": []}}
    # A package that wasn't looked up gets no answer at all (the page says "not looked up", not "no fix").
    assert json.loads(driver.fixes("{}", json.dumps(r["rows"]))) == {}


def test_a_private_index_package_is_never_looked_up_on_pypi(repo):
    lock = (
        LOCK.replace('{ name = "purewheel" },', '{ name = "purewheel" },\n    { name = "corp-utils" },')
        + """
[[package]]
name = "corp-utils"
version = "1.0"
source = { registry = "https://pkgs.corp.example/simple" }
sdist = { url = "https://pkgs.corp.example/files/corp-utils-1.0.tar.gz", hash = "sha256:00", size = 1 }
"""
    )
    (repo / "uv.lock").write_text(lock, encoding="utf-8")
    r = json.loads(driver.check(str(repo), "uv.lock", options()))
    corp = next(row for row in r["rows"] if row["name"] == "corp-utils")
    assert corp["lookup"] is False
    squatted = {"corp-utils": {"9.9": [wheel("corp_utils-9.9-py3-none-any.whl")]}}
    assert "corp-utils==1.0" not in json.loads(driver.fixes(json.dumps(squatted), json.dumps(r["rows"])))


def test_fixes_reports_a_release_that_only_trades_one_gap_for_another(repo):
    r = json.loads(driver.check(str(repo), "uv.lock", options()))
    releases = {
        "fastlib": {
            "2.0.0": [wheel("fastlib-2.0.0-cp313-cp313-manylinux_2_17_x86_64.whl")],
            # has the aarch64 wheel the pin lacks, but drops x86_64 and musl: not a fix, yet not "nothing newer"
            "2.1.0": [wheel("fastlib-2.1.0-cp313-cp313-manylinux_2_17_aarch64.whl")],
        }
    }
    fx = json.loads(driver.fixes(json.dumps(releases), json.dumps(r["rows"])))
    assert fx == {"fastlib==2.0.0": {"found": {}, "loses": ["3.13 linux-aarch64"]}}


@pytest.mark.parametrize(
    "case", ["match", "version", "target", "private", "malformed", "requires_python"]
)
def test_gap_wheels_reuse_cli_checks(repo, case):
    gapwheels = pytest.importorskip("wheelgap.gapwheels")
    lockfile = repo / "uv.lock"
    entry = {
        "name": "fastlib",
        "version": "2.0.0",
        "wheel": "fastlib-2.0.0-cp313-cp313-win_amd64.whl",
        "sha256": "a" * 64,
        "requires_python": ">=3.13",
    }
    if case == "private":
        lockfile.write_text(
            LOCK.replace(
                'name = "fastlib"\nversion = "2.0.0"\nsource = { registry = "https://pypi.org/simple" }',
                'name = "fastlib"\nversion = "2.0.0"\nsource = { registry = "https://private.invalid/simple" }',
            ),
            encoding="utf-8",
        )
    elif case == "version":
        entry.update(version="2.0.1", wheel="fastlib-2.0.1-cp313-cp313-win_amd64.whl")
    elif case == "target":
        entry["wheel"] = "fastlib-2.0.0-cp313-cp313-win_arm64.whl"
    elif case == "malformed":
        entry["sha256"] = "bad"
    elif case == "requires_python":
        entry["requires_python"] = ">=3.14"
    options = {"pythons": ["3.13"], "platforms": ["win-amd64"]}
    driver.check(str(repo), lockfile.name, json.dumps(options))
    result = json.loads(
        driver.gap_wheels(json.dumps({"schema": gapwheels.SCHEMA, "wheels": [entry]}))
    )
    if case == "match":
        assert [(cell["name"], cell["target"]) for cell in result["cells"]] == [
            ("fastlib", "3.13 win-amd64")
        ]
        assert "[[tool.uv.index]]" in result["text"]
        assert "fastlib" in result["text"]
        assert result["unofficial"] == gapwheels.UNOFFICIAL
    else:
        assert result == {"cells": [], "text": "", "unofficial": ""}

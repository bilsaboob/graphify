"""The section-text read path: `get_section` / `graphify section`.

A heading node records only its heading line. The section it opens is found at
read time from the current file, so an agent gets the section body instead of a
line number it then has to open the file for.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import networkx as nx
import pytest

from graphify.extractors.markdown import extract_markdown
from graphify.sections import format_section, read_section, resolve_section_query
from graphify.security import redact_secrets
from graphify.watch import _rebuild_code

DOC = """\
---
title: Payments
token: ghp_abcdefghijklmnopqrstuvwxyz0123456789
---
# Payments
Intro text.

## Retry policy
Retries 3 times with backoff.

```
# not a heading
```
### Limits
Max 30s.


## Refunds
Refunds take 5 days.

"""


def _node(path: Path, label: str) -> dict:
    node = next(n for n in extract_markdown(path)["nodes"] if n["label"] == label)
    return {**node, "source_file": path.name}


@pytest.fixture()
def doc(tmp_path: Path) -> Path:
    p = tmp_path / "design.md"
    p.write_text(DOC, encoding="utf-8")
    return p


def _read(doc: Path, label: str, **kw):
    section, reason = read_section(_node(doc, label), doc.parent, **kw)
    assert section is not None, reason
    return section


def test_section_runs_to_next_heading_of_same_or_shallower_level(doc: Path) -> None:
    s = _read(doc, "Retry policy")
    # Includes its Limits subsection and the fenced `#` line, stops before
    # Refunds, and drops the blank lines in between.
    assert (s.start, s.end) == (8, 15)
    assert s.text.splitlines()[0] == "## Retry policy"
    assert "# not a heading" in s.text and s.text.splitlines()[-1] == "Max 30s."
    assert "Refunds" not in s.text


def test_last_sections_run_to_end_of_file(doc: Path) -> None:
    assert (_read(doc, "Refunds").start, _read(doc, "Refunds").end) == (18, 19)
    assert _read(doc, "Payments").end == 19


def test_page_is_the_body_without_frontmatter(doc: Path) -> None:
    s = _read(doc, "design.md")
    assert s.start == 5 and s.text.startswith("# Payments")
    assert "ghp_" not in s.text


def test_edit_inside_a_section_after_indexing_is_returned_whole(doc: Path) -> None:
    node = _node(doc, "Retry policy")
    doc.write_text(DOC.replace("Max 30s.", "Max 30s.\nJitter 10%.\nCap 5 retries."),
                   encoding="utf-8")
    section, _ = read_section(node, doc.parent)
    assert section is not None and not section.moved
    assert section.text.splitlines()[-1] == "Cap 5 retries."


def test_heading_moved_by_an_edit_above_it_is_still_found(doc: Path) -> None:
    node = _node(doc, "Refunds")
    doc.write_text(DOC.replace("Intro text.", "Intro text.\nmore\nmore"), encoding="utf-8")
    section, _ = read_section(node, doc.parent)
    assert section is not None and section.moved
    assert section.text.startswith("## Refunds") and section.start == 20


def test_removed_heading_is_refused(doc: Path) -> None:
    node = _node(doc, "Refunds")
    doc.write_text("# Payments\n", encoding="utf-8")
    section, reason = read_section(node, doc.parent)
    assert section is None and "graphify update" in reason


def test_truncates_at_max_chars(doc: Path) -> None:
    s = _read(doc, "Payments", max_chars=10)
    assert s.truncated and len(s.text) == 10


def test_secrets_in_a_section_are_redacted(tmp_path: Path) -> None:
    (tmp_path / "x.md").write_text(
        "# Setup\nexport GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n", encoding="utf-8")
    s = _read(tmp_path / "x.md", "Setup")
    assert "ghp_abcdefghijklmnopqrstuvwxyz0123456789" not in s.text


def test_control_characters_are_stripped_but_tabs_kept(tmp_path: Path) -> None:
    (tmp_path / "x.md").write_text("# T\nok\x1b[31mred\tkept\n", encoding="utf-8")
    s = _read(tmp_path / "x.md", "T")
    assert "\x1b" not in s.text and "\tkept" in s.text


def test_path_outside_the_project_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    root.mkdir()
    (tmp_path / "secret.md").write_text("# s\nkey\n", encoding="utf-8")
    node = {"label": "s", "node_kind": "heading", "source_file": "../secret.md",
            "source_location": "L1"}
    section, reason = read_section(node, root)
    assert section is None and "outside" in reason


def test_code_node_is_refused(tmp_path: Path) -> None:
    node = {"label": "fn", "file_type": "code", "source_file": "x.py", "source_location": "L1"}
    section, reason = read_section(node, tmp_path)
    assert section is None and "not a Markdown" in reason


def _two_file_graph() -> nx.DiGraph:
    G = nx.DiGraph()
    for i, f in enumerate(["README.md", "docs/api.md", "docs/openapi.md"]):
        G.add_node(f"n{i}", label="Installation", node_kind="heading",
                   source_file=f, source_location="L3")
    return G


def test_path_scoped_query_picks_one_of_several_same_named_headings() -> None:
    G = _two_file_graph()
    assert resolve_section_query(G, "docs/api.md::Installation") == ("n1", "")
    assert resolve_section_query(G, "api.md::Installation") == ("n1", "")
    assert resolve_section_query(G, "README.md::Installation") == ("n0", "")


def test_bare_ambiguous_heading_points_at_the_path_scoped_form() -> None:
    nid, err = resolve_section_query(_two_file_graph(), "Installation")
    assert nid is None and "path::" in err


def test_heading_wins_over_a_code_symbol_of_the_same_name() -> None:
    G = _two_file_graph()
    G.add_node("cls", label="Installation", file_type="code",
               source_file="setup.py", source_location="L1")
    G.add_node("cfg", label="Config", file_type="code", source_file="x.py", source_location="L1")
    G.add_node("cfg_h", label="Config", node_kind="heading",
               source_file="README.md", source_location="L9")
    assert resolve_section_query(G, "Config") == ("cfg_h", "")


def test_same_titled_headings_after_an_edit_above_are_refused_not_guessed(tmp_path: Path) -> None:
    p = tmp_path / "api.md"
    p.write_text("# A\n### Example\none\n# B\n### Example\ntwo\n", encoding="utf-8")
    second = [n for n in extract_markdown(p)["nodes"] if n["label"] == "Example"][1]
    second = {**second, "source_file": p.name}
    p.write_text("new\nlines\n" + p.read_text(encoding="utf-8"), encoding="utf-8")
    section, reason = read_section(second, tmp_path)
    assert section is None and "graphify update" in reason


def test_skill_files_are_sections_like_the_extractor_says() -> None:
    from graphify.extract import _DISPATCH
    from graphify.extractors.markdown import extract_markdown as md
    from graphify.sections import _MARKDOWN_SUFFIXES
    assert _MARKDOWN_SUFFIXES == {s for s, fn in _DISPATCH.items() if fn is md}


@pytest.mark.parametrize("text", [
    DOC,
    "---\nnote: |\n  ```\n---\n# Hidden\nx\n",
    "---\nnote: |\n  ```\n---\nx\n```\n# Real\ny\n",
    "# Step\t1\nbody\n",
    "# " + "L" * 300 + "\nbody\n",
])
def test_every_extracted_heading_is_readable(tmp_path: Path, text: str) -> None:
    p = tmp_path / "d.md"
    p.write_text(text, encoding="utf-8")
    for n in extract_markdown(p)["nodes"]:
        section, reason = read_section({**n, "source_file": p.name}, tmp_path)
        assert section is not None and not section.moved, reason


def test_merged_multi_repo_node_is_refused(doc: Path) -> None:
    node = {**_node(doc, "Refunds"), "repo": "billing"}
    section, reason = read_section(node, doc.parent)
    assert section is None and "repo" in reason


def test_out_of_project_root_marker_is_not_trusted(tmp_path: Path) -> None:
    from graphify.sections import section_root
    out = tmp_path / "proj" / "graphify-out"
    out.mkdir(parents=True)
    (out / ".graphify_root").write_text(str(tmp_path.anchor), encoding="utf-8")
    root = section_root(out / "graph.json")
    assert root.resolve() in ((tmp_path / "proj").resolve(), out.resolve())


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / "design.md").write_text(DOC, encoding="utf-8")
    assert _rebuild_code(root, acquire_lock=False, no_cluster=True) is True
    return root


def test_graph_json_is_unchanged_by_the_feature(tmp_path: Path) -> None:
    """Nothing is stored: the extractor output a graph was built from is enough."""
    root = _project(tmp_path)
    graph = json.loads((root / "graphify-out" / "graph.json").read_text(encoding="utf-8"))
    assert not any("end_location" in n for n in graph["nodes"])


def _run_cli(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "graphify", "section", *args],
        cwd=root, capture_output=True, text=True, encoding="utf-8",
    )


def test_cli_section_prints_the_section(tmp_path: Path) -> None:
    root = _project(tmp_path)
    out = _run_cli(root, "Retry policy")
    assert out.returncode == 0, out.stderr
    assert "design.md:L8-L15" in out.stdout
    assert "Max 30s." in out.stdout and "Refunds take" not in out.stdout


def test_cli_section_unknown_heading_exits_not_found(tmp_path: Path) -> None:
    root = _project(tmp_path)
    assert _run_cli(root, "No such heading").returncode == 4


def test_mcp_get_section_and_get_node_hint(tmp_path: Path) -> None:
    from tests.test_serve_http import _call_tool, _client, _init_session
    import graphify.serve as serve_mod

    root = _project(tmp_path)
    app = serve_mod._build_http_app(str(root / "graphify-out" / "graph.json"),
                                    json_response=True)
    with _client(app) as client:
        headers = _init_session(client)
        text = _call_tool(client, headers, "get_section", {"label": "Limits"}, rid=2)
        scoped = _call_tool(client, headers, "get_section",
                            {"label": "design.md::Refunds"}, rid=3)
        node = _call_tool(client, headers, "get_node", {"label": "Limits"}, rid=4)
    assert text.startswith("Section: Limits  [design.md:L14-L15]"), text
    assert "Max 30s." in text
    assert "Refunds take 5 days." in scoped
    assert "get_section returns" in node


def _example_fixture(tmp_path, block="```python\nbuildSession(user)\n```", *, preview="buildSession(user)"):
    path = tmp_path / "example.md"
    path.write_text("# Session\n\n" + block + ("" if block.endswith("\n") else "\n"), encoding="utf-8")
    normalized = "\n".join(block.splitlines())
    node = {
        "id": "example:session", "label": "Session example", "file_type": "document",
        "node_kind": "code_example", "source_file": path.name, "source_location": "L3",
        "attributes": {
            "start_line": 3, "end_line": 2 + len(block.splitlines()),
            "span_hash": hashlib.sha256(redact_secrets(normalized).encode("utf-8")).hexdigest(),
            "preview": preview, "language": "python", "section": {"heading": "Session", "source_location": "L1"},
        },
    }
    return path, node


@pytest.mark.parametrize("block", [
    "```python\nbuildSession(user)\n```",
    "```\n```",
    "~~~unknown\nnot valid code!\n~~~",
    "```python\nincomplete(",
    "```",
    "```python\n\n",
])
def test_example_returns_exact_whole_fence_including_empty_and_unclosed(tmp_path, block):
    path, node = _example_fixture(tmp_path, block)
    section, reason = read_section(node, tmp_path)
    assert section is not None, reason
    assert section.text == "\n".join(block.splitlines())
    assert section.start == 3 and section.end == node["attributes"]["end_line"]
    assert not section.moved and not section.note
    assert format_section(section, node["label"]).startswith(
        f"Section: Session example  [{path.name}:L3-L{section.end}]\n\n"
    )


@pytest.mark.parametrize("newline", ["\r\n", "\r"])
def test_example_fingerprint_uses_normalized_source_newlines(tmp_path, newline):
    path, node = _example_fixture(tmp_path)
    path.write_bytes(path.read_text(encoding="utf-8").replace("\n", newline).encode("utf-8"))
    section, reason = read_section(node, tmp_path)
    assert section is not None and not section.note, reason
    assert section.text == "```python\nbuildSession(user)\n```"


@pytest.mark.parametrize("change", ["content", "moved", "deleted", "missing-fence"])
def test_stale_example_uses_stored_preview_not_other_current_source(tmp_path, change):
    path, node = _example_fixture(tmp_path, preview="INDEXED original preview")
    if change == "content":
        path.write_text("# Session\n\n```python\nWRONG_CURRENT_BLOCK()\n```\n", encoding="utf-8")
    elif change == "moved":
        path.write_text("new\nlines\n" + path.read_text(encoding="utf-8"), encoding="utf-8")
    elif change == "deleted":
        path.unlink()
    else:
        path.write_text("# Session\n\nnot a fence\nWRONG_CURRENT_BLOCK()\n", encoding="utf-8")
    section, reason = read_section(node, tmp_path)
    assert section is not None, reason
    assert section.text == "INDEXED original preview"
    assert not section.moved
    rendered = format_section(section, node["label"])
    assert "Indexed preview; source stale/unavailable" in rendered
    assert "example.md:L3-L5" in rendered
    assert "WRONG_CURRENT_BLOCK" not in rendered


@pytest.mark.parametrize("updates", [
    {"start_line": -1}, {"start_line": 0}, {"start_line": True}, {"start_line": "3"},
    {"end_line": -1}, {"end_line": 2}, {"end_line": 500}, {"end_line": 5.0},
    {"span_hash": "wrong"}, {"span_hash": None},
])
def test_bad_example_span_metadata_falls_back_without_negative_slices(tmp_path, updates):
    _, node = _example_fixture(tmp_path, preview="indexed")
    node["attributes"].update(updates)
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.text == "indexed", reason
    assert section.note and section.start == 3 and section.end >= 3


def test_example_span_must_start_at_recorded_opener(tmp_path):
    _, node = _example_fixture(tmp_path, preview="indexed")
    node["source_location"] = "L4"
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.note, reason
    assert section.text == "indexed" and (section.start, section.end) == (4, 4)


def test_example_range_cannot_stop_mid_fence_even_with_matching_partial_hash(tmp_path):
    path, node = _example_fixture(tmp_path, preview="indexed")
    partial = "\n".join(path.read_text(encoding="utf-8").splitlines()[2:4])
    node["attributes"].update(end_line=4, span_hash=hashlib.sha256(partial.encode()).hexdigest())
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.note and section.text == "indexed", reason


def test_example_opener_cannot_be_inside_another_fence_after_source_edit(tmp_path):
    path, node = _example_fixture(tmp_path, preview="indexed")
    path.write_text(path.read_text(encoding="utf-8").replace("# Session", "```python"), encoding="utf-8")
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.note and section.text == "indexed", reason


@pytest.mark.parametrize("block", ["```py\n```", "~~~~\n```\n~~~~", "```unknown\nincomplete("])
def test_parser_example_hash_and_retrieval_use_the_same_whole_span(tmp_path, block):
    path, _ = _example_fixture(tmp_path, block)
    node = next(n for n in extract_markdown(path)["nodes"] if n.get("node_kind") == "code_example")
    node["source_file"] = path.name
    section, reason = read_section(node, tmp_path)
    assert section is not None and not section.note, reason
    assert section.text == block


@pytest.mark.parametrize("restricted", ["outside", "merged"])
def test_restricted_example_source_is_never_opened_but_safe_preview_is_retained(tmp_path, monkeypatch, restricted):
    import graphify.sections as sections

    _, node = _example_fixture(tmp_path, preview="stored snippet")
    if restricted == "outside":
        node["source_file"] = "../outside.md"
    else:
        node["repo"] = "another-repo"
    monkeypatch.setattr(sections, "_read_source_text", lambda *a, **k: pytest.fail("restricted source opened"))
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.text == "stored snippet", reason
    assert "outside" in section.note if restricted == "outside" else "multi-repo" in section.note
    assert "Indexed preview" in format_section(section, node["label"])


def test_example_symlink_escape_uses_stored_preview(tmp_path, requires_symlinks):
    root = tmp_path / "root"
    root.mkdir()
    outside, node = _example_fixture(tmp_path, preview="stored")
    (root / "example.md").symlink_to(outside)
    section, reason = read_section(node, root)
    assert section is not None and section.text == "stored" and "outside" in section.note, reason


def test_missing_example_preview_or_locator_is_explicit_not_dropped(tmp_path):
    path, node = _example_fixture(tmp_path)
    path.unlink()
    node["attributes"].pop("preview")
    node["source_location"] = "not a location"
    section, reason = read_section(node, tmp_path)
    assert section is not None and section.text == "", reason
    rendered = format_section(section, node["label"])
    assert "unknown span" in rendered and "No stored preview is available" in rendered


@pytest.mark.parametrize("stale", [False, True])
def test_example_redaction_and_control_sanitizing_precede_max_chars(tmp_path, stale):
    secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    content = f'client("{secret}")\x1b\n\tkept'
    path, node = _example_fixture(tmp_path, "```py\n" + content + "\n```", preview=content)
    if stale:
        path.unlink()
    section, reason = read_section(node, tmp_path, max_chars=35)
    assert section is not None, reason
    assert secret not in section.text and "ghp_" not in section.text and "\x1b" not in section.text
    assert "[redacted]" in section.text
    assert len(section.text) <= 35
    assert section.truncated is (not stale)
    # A label credential beyond the old sanitizer's cap must still be redacted
    # before that cap, rather than exposing the token's cut-off prefix to CLI.
    label = "Example\n\x1b" + "x " * 115 + secret
    text = format_section(section, label)
    assert "ghp_" not in text and "\x1b" not in text


def test_truncated_stored_preview_does_not_recommend_wrong_live_lines(tmp_path):
    path, node = _example_fixture(tmp_path, preview="indexed " * 30)
    path.unlink()
    section, reason = read_section(node, tmp_path, max_chars=10)
    assert section is not None and section.truncated and len(section.text) == 10, reason
    text = format_section(section, node["label"])
    assert "Truncated indexed preview" in text
    assert "for the rest" not in text


def test_example_query_resolves_id_or_scoped_label_without_code_shadowing(tmp_path):
    _, node = _example_fixture(tmp_path)
    G = nx.DiGraph()
    G.add_node(node["id"], **node)
    G.add_node("code", label=node["label"], file_type="code", source_file="a.py")
    assert resolve_section_query(G, node["id"]) == (node["id"], "")
    assert resolve_section_query(G, "example.md::Session example") == (node["id"], "")
    assert resolve_section_query(G, "Session example") == (node["id"], "")


def test_mcp_example_section_and_node_hint_use_existing_tools(tmp_path):
    from networkx.readwrite import json_graph
    from tests.test_serve_http import _call_tool, _client, _init_session
    from graphify.serve import _build_http_app

    path, node = _example_fixture(tmp_path)
    G = nx.DiGraph()
    G.add_node(node["id"], **node)
    out = tmp_path / "graphify-out"
    out.mkdir()
    graph = out / "graph.json"
    graph.write_text(json.dumps(json_graph.node_link_data(G, edges="links")), encoding="utf-8")
    with _client(_build_http_app(str(graph), json_response=True)) as client:
        headers = _init_session(client)
        text = _call_tool(client, headers, "get_section", {"node_id": node["id"]}, rid=2)
        detail = _call_tool(client, headers, "get_node", {"node_id": node["id"]}, rid=3)
        path.unlink()
        stale = _call_tool(client, headers, "get_section", {"node_id": node["id"]}, rid=4)
    assert text.startswith("Section: Session example  [example.md:L3-L5]")
    assert "```python\nbuildSession(user)\n```" in text
    assert "get_section returns" in detail
    assert "Indexed preview; source stale/unavailable" in stale


def test_mcp_section_does_not_clip_credential_shaped_label_before_shared_redaction(tmp_path):
    from networkx.readwrite import json_graph
    from tests.test_serve_http import _call_tool, _client, _init_session
    from graphify.serve import _build_http_app

    _, node = _example_fixture(tmp_path)
    node["label"] = "Example " + "x " * 115 + "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    G = nx.DiGraph()
    G.add_node(node["id"], **node)
    graph = tmp_path / "graph.json"
    graph.write_text(json.dumps(json_graph.node_link_data(G, edges="links")), encoding="utf-8")
    with _client(_build_http_app(str(graph), json_response=True)) as client:
        headers = _init_session(client)
        text = _call_tool(client, headers, "get_section", {"node_id": node["id"]}, rid=2)
    assert text.startswith("Section: Example ")
    assert "ghp_" not in text and "[redacted]" in text


def test_cli_section_automatically_uses_shared_example_formatter(tmp_path, monkeypatch, capsys):
    from graphify import cli, querylog

    _, node = _example_fixture(tmp_path)
    G = nx.DiGraph()
    G.add_node(node["id"], **node)
    monkeypatch.setattr(sys, "argv", ["graphify", "section", node["id"]])
    monkeypatch.setattr(cli, "_load_cli_graph", lambda _: G)
    monkeypatch.setattr(cli, "_touch_query_stamp", lambda _: None)
    monkeypatch.setattr(querylog, "log_query", lambda **_: None)
    monkeypatch.setattr("graphify.sections.section_root", lambda _: tmp_path)
    cli.dispatch_command("section")
    section, reason = read_section(node, tmp_path)
    assert section is not None, reason
    assert capsys.readouterr().out == format_section(section, node["label"]) + "\n"

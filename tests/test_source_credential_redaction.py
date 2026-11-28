"""Source masking uses fake credentials and never executes the source."""
from __future__ import annotations

import builtins
import hashlib
import json
import re
import traceback

import pytest
from tree_sitter import Language, Parser
import tree_sitter_typescript

from graphify import security
from graphify.security import (
    SOURCE_REDACTION_MASKS,
    SOURCE_REDACTION_POLICY,
    redact_secrets,
    redact_source_credentials,
)


TOKEN = "ghp_" + "a" * 36
BEARER = "abcDEF0123456789fakeToken"
PEM = "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXktYm9keQ==\n-----END PRIVATE KEY-----"


def _assert_preserved(source: str, masked: str, metadata: dict, language="typescript"):
    raw, safe = source.encode("utf-8"), masked.encode("utf-8")
    assert len(raw) == len(safe)
    assert len(source.encode("utf-16-le")) == len(masked.encode("utf-16-le"))
    assert len(source) == len(masked)
    for before, after in zip(source, masked):
        assert len(before.encode("utf-8")) == len(after.encode("utf-8"))
        assert len(before.encode("utf-16-le")) == len(after.encode("utf-16-le"))
        if before in "\r\n":
            assert after == before
    assert redact_secrets(masked) == masked
    assert redact_source_credentials(masked, language) == (masked, None)
    assert set(metadata) == {"version", "policy", "originalSourceHash", "ranges"}
    assert metadata["version"] == 1
    assert metadata["policy"] == SOURCE_REDACTION_POLICY
    assert metadata["originalSourceHash"] == hashlib.sha256(raw).hexdigest()
    cursor = 0
    for span in metadata["ranges"]:
        assert set(span) == {"startByte", "endByte", "startLine", "endLine"}
        start, end = span["startByte"], span["endByte"]
        assert cursor <= start < end <= len(raw)
        assert raw[cursor:start] == safe[cursor:start]
        assert span["startLine"] == raw.count(b"\n", 0, start) + 1
        assert span["endLine"] == raw.count(b"\n", 0, end - 1) + 1
        cursor = end
    assert raw[cursor:] == safe[cursor:]
    factory = (
        tree_sitter_typescript.language_tsx
        if language == "tsx"
        else tree_sitter_typescript.language_typescript
    )
    assert not Parser(Language(factory())).parse(safe).root_node.has_error


@pytest.mark.parametrize("language", ["typescript", "tsx"])
@pytest.mark.parametrize("userinfo", ["user:fakepass", ":fakepass", "u:p@ss", "u:ab/cd"])
def test_source_redaction_uri_masks_only_userinfo(language, userinfo):
    source = f'const url = "redis://{userinfo}@host.invalid:6379/db";\nkeep(url);'
    masked, metadata = redact_source_credentials(source, language)
    assert masked == source.replace(userinfo, "*" * len(userinfo))
    _assert_preserved(source, masked, metadata, language)


@pytest.mark.parametrize("token", [
    TOKEN,
    "github_pat_" + "a0_" * 12,
    "AKIA" + "0" * 16,
    "xoxb-" + "fake0" * 5,
    "sk_test_" + "fake0" * 5,
    "sk-proj-" + "fake0" * 5,
    "AIza" + "a" * 35,
    "eyJ" + "a" * 12 + ".e30." + "b" * 12,
    BEARER,
])
def test_source_redaction_vendor_and_bearer_tokens(token):
    source = f'const header = "Bearer {token}";'
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked == f'const header = "Bearer {"*" * len(token)}";'
    assert token not in json.dumps(metadata)
    _assert_preserved(source, masked, metadata)


@pytest.mark.parametrize("wrapper", ["`{}`", "/*{}*/"])
@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_source_redaction_multiline_pem_keeps_delimiters_and_lines(wrapper, newline):
    pem = PEM.replace("\n", newline)
    value = wrapper.format(pem)
    source = (f"const key = {value};" if wrapper.startswith("`") else value) + "\nconst n = 1;"
    masked, metadata = redact_source_credentials(source, "typescript")
    expected = "".join(char if char in "\r\n" else "*" for char in pem)
    assert masked == source.replace(pem, expected)
    assert metadata["ranges"][0]["startLine"] == 1
    assert metadata["ranges"][0]["endLine"] == 3
    assert "ZmFrZS1rZXktYm9keQ" not in json.dumps(metadata)
    _assert_preserved(source, masked, metadata)


def test_source_redaction_unicode_bom_crlf_and_all_character_widths():
    assert dict(SOURCE_REDACTION_MASKS) == {1: "*", 2: "\u00a4", 3: "\u2588", 4: "\U0001f7e5"}
    userinfo = "u\u00e9\u4e2d\U0001f9ea:p\u00e4\u5bc6\U0001f512"
    source = '\ufeff// preface\r\nconst url = "https://' + userinfo + '@host.invalid/x";\r\n'
    masked, metadata = redact_source_credentials(source, "typescript")
    expected = "*\u00a4\u2588\U0001f7e5**\u00a4\u2588\U0001f7e5"
    assert masked == source.replace(userinfo, expected)
    assert masked.startswith("\ufeff")
    assert metadata["ranges"][0]["startLine"] == 2
    assert userinfo not in json.dumps(metadata, ensure_ascii=False)
    _assert_preserved(source, masked, metadata)


def test_source_redaction_is_deterministic_but_original_hash_tracks_masked_changes():
    source = 'const url = "https://user:fake-one@host.invalid";'
    masked, metadata = redact_source_credentials(source, "typescript")
    assert redact_source_credentials(source, "typescript") == (masked, metadata)
    changed, changed_metadata = redact_source_credentials(
        source.replace("fake-one", "fake-two"), "typescript",
    )
    assert changed == masked
    assert changed_metadata["ranges"] == metadata["ranges"]
    assert changed_metadata["originalSourceHash"] != metadata["originalSourceHash"]


@pytest.mark.parametrize("quote", ['"', "'", "`"])
def test_source_redaction_expands_escape_prefix(quote):
    source = f"const token = {quote}\\{TOKEN}{quote};"
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked == f"const token = {quote}{'*' * (len(TOKEN) + 1)}{quote};"
    assert metadata["ranges"][0]["startByte"] == source.index("\\")
    _assert_preserved(source, masked, metadata)


def test_source_redaction_expands_escape_at_url_userinfo_end():
    source = r'const url = "https://u:\u0041\@host.invalid/path";'
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked == source.replace(r"u:\u0041\@", "*" * len(r"u:\u0041\@"))
    assert metadata["ranges"][0]["endByte"] == source.index("@") + 1
    _assert_preserved(source, masked, metadata)


def test_source_redaction_merges_overlapping_escape_expansions(monkeypatch):
    # Two independent matches inside the same escape must produce one full mask.
    monkeypatch.setattr(security, "_SECRET_SHAPE_RE", re.compile("00|41"))
    source = r'const value = "\u0041";'
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked == 'const value = "******";'
    assert len(metadata["ranges"]) == 1
    _assert_preserved(source, masked, metadata)


def test_source_redaction_literal_inside_template_substitution_is_independent():
    source = 'const message = `hello ${read("' + TOKEN + '")} ${untouched} world`;'
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked == source.replace(TOKEN, "*" * len(TOKEN))
    assert '${read("' in masked and "${untouched}" in masked
    _assert_preserved(source, masked, metadata)


def test_source_redaction_template_fragments_preserve_substitution_code():
    source = f"const message = `{TOKEN} ${{untouched}} Bearer {BEARER}`;"
    masked, metadata = redact_source_credentials(source, "typescript")
    assert "${untouched}" in masked
    assert len(metadata["ranges"]) == 2
    _assert_preserved(source, masked, metadata)


def test_source_redaction_tsx_text_attribute_and_expression_string():
    source = f'const view = <p title="Bearer {BEARER}">{TOKEN}{{"{TOKEN}"}}</p>;'
    masked, metadata = redact_source_credentials(source, "tsx")
    assert masked == source.replace(BEARER, "*" * len(BEARER)).replace(TOKEN, "*" * len(TOKEN))
    assert len(metadata["ranges"]) == 3
    _assert_preserved(source, masked, metadata, "tsx")


def test_source_redaction_comments_keep_delimiters():
    source = f"// {TOKEN}\r\n/* Bearer {BEARER} */\nconst n = 1;"
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked.startswith("// ")
    assert "\r\n/* Bearer " in masked
    assert masked.endswith(" */\nconst n = 1;")
    assert len(metadata["ranges"]) == 2
    _assert_preserved(source, masked, metadata)


@pytest.mark.parametrize("source,language", [
    ('const uri = "https://user:fakepass"+"@host.invalid";', "typescript"),
    ("/*https://user:fakepass*//*@host.invalid*/", "typescript"),
    ("const uri = `https://user:${password}@host.invalid`;", "typescript"),
    (f"const value = `${{{TOKEN}}}`;", "typescript"),
    (f"const token_{TOKEN} = 1;", "typescript"),
    (f"const view = <p>{{{TOKEN}}}</p>;", "tsx"),
    (f'const value = "{TOKEN};', "typescript"),
    (f'const value = "{PEM.splitlines()[0]}fake-body";', "typescript"),
])
def test_source_redaction_refuses_code_cross_boundary_and_malformed_hits(source, language):
    assert redact_secrets(source) != source
    with pytest.raises(ValueError, match=r"^Cannot safely redact source credentials at line 2$") as exc:
        redact_source_credentials("// preface\n" + source, language)
    assert TOKEN not in str(exc.value)
    assert "fakepass" not in str(exc.value)
    assert "fake-body" not in str(exc.value)


def test_source_redaction_refuses_new_comment_terminator_even_if_result_parses():
    source = f"/* {TOKEN}/ const hidden = 1; /* end */"
    hypothetical = source.replace(TOKEN, "*" * len(TOKEN))
    parser = Parser(Language(tree_sitter_typescript.language_typescript()))
    assert not parser.parse(source.encode()).root_node.has_error
    assert not parser.parse(hypothetical.encode()).root_node.has_error
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(source, "typescript")


@pytest.mark.parametrize("source", [
    "", "const value = 1;", "not valid TypeScript {{{", "x" * 300_000,
], ids=["empty", "plain", "unparsed", "large-no-match"])
def test_source_redaction_no_match_returns_identity_without_parser(monkeypatch, source):
    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        assert not name.startswith("tree_sitter"), "No-match path imported a parser"
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)
    masked, metadata = redact_source_credentials(source, "typescript")
    assert masked is source
    assert metadata is None


def test_source_redaction_parser_errors_do_not_echo_values(monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError(TOKEN)

    import tree_sitter
    monkeypatch.setattr(tree_sitter, "Parser", unavailable)
    with pytest.raises(ValueError, match="line 1") as exc:
        redact_source_credentials(f'const value = "{TOKEN}";', "typescript")
    assert TOKEN not in "".join(traceback.format_exception(exc.value))
    assert exc.value.__suppress_context__


def test_source_redaction_match_count_is_bounded():
    source = "// " + (TOKEN + " ") * (security._SOURCE_REDACTION_MAX_RANGES + 1)
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(source, "typescript")


@pytest.mark.parametrize("padding", ["a" * 262_144, "\u4e2d" * 90_000], ids=["ascii", "unicode"])
def test_source_redaction_source_byte_work_is_bounded(padding):
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(f"/* {padding} {TOKEN} */", "typescript")


def test_source_redaction_syntax_depth_is_bounded():
    source = "(" * 300 + f'"{TOKEN}"' + ")" * 300
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(source, "typescript")


def test_source_redaction_syntax_node_work_is_bounded(monkeypatch):
    monkeypatch.setattr(security, "_SOURCE_REDACTION_MAX_NODES", 4)
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(f'const token = "{TOKEN}";', "typescript")


def test_source_redaction_parser_work_is_bounded(monkeypatch):
    monkeypatch.setattr(security, "_SOURCE_REDACTION_PARSE_TIMEOUT_MICROS", 1)
    source = "const n = 1;\n" * 1000 + f'const token = "{TOKEN}";'
    with pytest.raises(ValueError, match="line 1001"):
        redact_source_credentials(source, "typescript")


def test_source_redaction_postcondition_is_not_bypassed(monkeypatch):
    monkeypatch.setattr(security, "redact_secrets", lambda text: text + "unsafe")
    with pytest.raises(ValueError, match="line 1"):
        redact_source_credentials(f'const token = "{TOKEN}";', "typescript")


def test_source_redaction_invalid_unicode_is_a_safe_error():
    with pytest.raises(ValueError, match="line 1") as exc:
        redact_source_credentials(f'const token = "{TOKEN}\ud800";', "typescript")
    assert TOKEN not in str(exc.value)
    assert exc.value.__suppress_context__

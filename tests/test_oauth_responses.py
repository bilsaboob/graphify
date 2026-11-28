"""OAuth protocol fixtures only: no credentials, login, downloads or live inference."""
from __future__ import annotations

import hashlib
import json
import socket
import uuid
from types import SimpleNamespace

import httpx2 as httpx
import pytest

from graphify import llm, oauth_responses as oauth

MODEL = "gpt-fixture"
BROKER = "http://127.0.0.1:43210"
LOCAL_TOKEN = "local-fixture-token"
SECRET = "PRIVATE_SOURCE_AND_TOKEN_MUST_NOT_APPEAR"
GRAPH = {
    "nodes": [{"id": "note_architecture", "label": "Architecture", "source_file": "note.md",
               "file_type": "concept"}],
    "edges": [], "hyperedges": [], "input_tokens": 999, "output_tokens": 999,
}


def completion(**changes):
    response = {
        "id": "resp_fixture", "status": "completed", "model": MODEL,
        "output": [{"type": "message", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": json.dumps(GRAPH)}]}],
        "usage": {"input_tokens": 17, "output_tokens": 9},
    }
    response.update(changes)
    return {"type": "response.completed", "response": response}


def sse(events, newline="\n"):
    return "".join(
        f"event: {event['type']}{newline}data: {json.dumps(event, ensure_ascii=False)}{newline}{newline}"
        for event in events
    ).encode("utf-8")


class Chunks(httpx.SyncByteStream):
    def __init__(self, parts):
        self.parts = parts
        self.closed = False

    def __iter__(self):
        for part in self.parts:
            if isinstance(part, Exception):
                raise part
            yield part

    def close(self):
        self.closed = True


class Wire:
    def __init__(self):
        self.requests = []
        self.grants = []
        self.outcomes = []
        self.client_options = []
        self.transport_options = []
        self.grant_patch = {}
        self.ack_patch = {}
        self.credential_reply = None
        self.outcome_reply = None
        self.response_status = 200
        self.response_headers = {"Content-Type": "text/event-stream"}
        self.events = [completion()]
        self.parts = None
        self.streams = []

    def handle(self, request):
        self.requests.append(request)
        assert request.method == "POST"
        if str(request.url) == BROKER + "/v1/credential":
            assert request.headers["Authorization"] == f"Bearer {LOCAL_TOKEN}"
            grant_request = json.loads(request.content)
            self.grants.append(grant_request)
            if self.credential_reply is not None:
                return self.credential_reply(request)
            return httpx.Response(200, json={
                "version": 1, "requestId": grant_request["requestId"], "model": MODEL,
                "accessToken": f"oauth-fixture-{len(self.grants)}",
                "expiresAt": "2099-01-01T00:00:00Z", "responsesURL": oauth.RESPONSES_URL,
                **self.grant_patch,
            })
        if str(request.url) == BROKER + "/v1/outcome":
            assert request.headers["Authorization"] == f"Bearer {LOCAL_TOKEN}"
            outcome = json.loads(request.content)
            self.outcomes.append(outcome)
            if self.outcome_reply is not None:
                return self.outcome_reply(request)
            return httpx.Response(200, json={
                "version": 1, "requestId": outcome["requestId"], "accepted": True,
                **self.ack_patch,
            })
        assert str(request.url) in (oauth.RESPONSES_URL, "http://127.0.0.1:43211/v1/responses")
        assert request.headers["Authorization"] == f"Bearer oauth-fixture-{len(self.grants)}"
        stream = Chunks(self.parts if self.parts is not None else [sse(self.events)])
        self.streams.append(stream)
        return httpx.Response(self.response_status, headers=self.response_headers, stream=stream)

    def call(self, **kwargs):
        return oauth.extract_graph(MODEL, "system instructions", "user text", parse_graph=llm._parse_llm_json, **kwargs)

    @property
    def inference_requests(self):
        return [r for r in self.requests if r.url.path == "/v1/responses"]


@pytest.fixture
def wire(monkeypatch):
    fixture = Wire()
    monkeypatch.setenv("GRAPHIFY_OAUTH_BROKER_URL", BROKER)
    monkeypatch.setenv("GRAPHIFY_OAUTH_BROKER_TOKEN", LOCAL_TOKEN)
    monkeypatch.setenv("GRAPHIFY_OPENAI_MODEL", MODEL)
    client = httpx.Client

    def transport(**kwargs):
        fixture.transport_options.append(kwargs)
        return httpx.MockTransport(fixture.handle)

    def create_client(**kwargs):
        fixture.client_options.append(kwargs)
        return client(**kwargs)

    def no_network(*args, **kwargs):
        raise AssertionError("test attempted real network access")

    monkeypatch.setattr(oauth, "httpx", SimpleNamespace(
        HTTPTransport=transport, Client=create_client, Timeout=httpx.Timeout,
    ))
    monkeypatch.setattr(socket.socket, "connect", no_network)
    return fixture


def test_explicit_only_backend_and_auxiliary_rejection(wire, monkeypatch):
    assert llm.detect_backend() is None
    assert llm._get_backend_api_key("openai-oauth") == ""
    assert not llm._backend_supports_vision("openai-oauth")
    monkeypatch.setenv("OPENAI_API_KEY", "inherited-api-key")
    assert llm.detect_backend() == "openai"
    monkeypatch.setenv("GRAPHIFY_BACKEND", "openai-oauth")
    assert llm.detect_backend() == "openai-oauth"
    with pytest.raises(oauth.OAuthResponsesError, match="auxiliary_operation_unsupported"):
        llm._call_llm("label this", backend="openai-oauth")
    assert not wire.requests


def test_extraction_uses_unchanged_prompts_exact_body_and_isolated_http(wire, monkeypatch, tmp_path):
    for key, value in {
        "OPENAI_API_KEY": SECRET, "OPENAI_ADMIN_KEY": SECRET, "OPENAI_MODEL": "wrong-model",
        "OPENAI_BASE_URL": "https://example.invalid/steal", "OPENAI_ORG_ID": SECRET,
        "OPENAI_PROJECT_ID": SECRET, "OPENAI_CUSTOM_HEADERS": f"Authorization: Bearer {SECRET}",
        "HTTP_PROXY": "http://example.invalid:123", "HTTPS_PROXY": "http://example.invalid:123",
        "ALL_PROXY": "http://example.invalid:123", "SSL_CERT_FILE": "nonexistent-fixture.pem",
        "GRAPHIFY_LLM_TEMPERATURE": "1.5", "GRAPHIFY_MAX_OUTPUT_TOKENS": "123",
        "GRAPHIFY_DISABLE_THINKING": "1", "GRAPHIFY_MAX_RETRIES": "12",
    }.items():
        monkeypatch.setenv(key, value)
    note = tmp_path / "note.md"
    note.write_text("# Architecture\nUnicode caf\u00e9, not ASCII bytes.\n", encoding="utf-8")
    wire.events.insert(0, {"type": "response.output_text.delta", "delta": SECRET})
    result = llm.extract_files_direct([note], backend="openai-oauth", api_key=SECRET,
                                      root=tmp_path, deep_mode=True)
    assert result["input_tokens"] == 17
    assert result["output_tokens"] == 9
    assert result["nodes"][0]["_origin"] == "semantic"
    request = wire.inference_requests[0]
    body = json.loads(request.content)
    assert body == {
        "model": MODEL, "instructions": llm._extraction_system(deep=True),
        "input": llm._read_files([note], tmp_path), "store": False, "stream": True,
    }
    credential = wire.grants[0]
    assert set(credential) == {"version", "requestId", "model", "requestHash", "inputBytes"}
    assert uuid.UUID(credential["requestId"]).version == 4
    assert credential["inputBytes"] == len(request.content)
    assert credential["inputBytes"] > len(request.content.decode("utf-8"))
    assert credential["requestHash"] == hashlib.sha256(request.content).hexdigest()
    assert request.headers["X-Client-Request-Id"] == credential["requestId"]
    assert request.headers["Accept"] == "text/event-stream"
    assert SECRET not in str(request.headers)
    assert wire.outcomes == [{
        "version": 1, "requestId": credential["requestId"], "outcome": "completed", "code": "",
        "responseId": "resp_fixture", "inputTokens": 17, "outputTokens": 9,
    }]
    assert wire.transport_options == [{"retries": 0, "trust_env": False}]
    assert wire.client_options[0]["trust_env"] is False
    assert wire.client_options[0]["follow_redirects"] is False
    assert all(value > 0 for value in wire.client_options[0]["timeout"].as_dict().values())
    assert wire.streams[0].closed


def test_each_call_gets_new_grant_not_cached_oauth(wire):
    wire.call()
    wire.call()
    assert len(wire.grants) == len(wire.outcomes) == len(wire.inference_requests) == 2
    assert wire.grants[0]["requestId"] != wire.grants[1]["requestId"]
    assert [r.headers["Authorization"] for r in wire.inference_requests] == [
        "Bearer oauth-fixture-1", "Bearer oauth-fixture-2",
    ]


@pytest.mark.parametrize("elapsed", [50, 61])
def test_credential_timeout_allows_refresh_but_remains_bounded(wire, monkeypatch, elapsed):
    now = [0]
    monkeypatch.setattr(oauth, "time", SimpleNamespace(monotonic=lambda: now[0]))

    def slow_grant(request):
        assert request.extensions["timeout"] == {"connect": 60, "read": 60, "write": 60, "pool": 60}
        now[0] = elapsed
        return httpx.Response(200, json={
            "version": 1, "requestId": wire.grants[0]["requestId"], "model": MODEL,
            "accessToken": "oauth-fixture-1", "expiresAt": "2099-01-01T00:00:00Z",
            "responsesURL": oauth.RESPONSES_URL,
        })

    wire.credential_reply = slow_grant
    if elapsed > 60:
        with pytest.raises(oauth.OAuthResponsesError, match="response_deadline"):
            wire.call()
        assert not wire.inference_requests
        assert wire.outcomes[0]["outcome"] == "unknown"
    else:
        wire.call()
        assert wire.outcomes[0]["outcome"] == "completed"
    assert wire.requests[-1].extensions["timeout"] == {"connect": 10, "read": 10, "write": 10, "pool": 10}
    assert len(wire.grants) == len(wire.outcomes) == 1


@pytest.mark.parametrize("url", [
    "", "https://127.0.0.1:43210", "http://localhost:43210", "http://127.1:43210",
    "http://[::1]:43210", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    "http://127.0.0.1:043210", "http://user:pass@127.0.0.1:43210",
    BROKER + "?", BROKER + "#", BROKER + "/path", BROKER + "\n", " " + BROKER,
])
def test_broker_configuration_is_literal_loopback_only(wire, monkeypatch, url):
    monkeypatch.setenv("GRAPHIFY_OAUTH_BROKER_URL", url)
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_broker_configuration"):
        wire.call()
    assert wire.requests == []


@pytest.mark.parametrize("token", ["", "token with spaces", "token\r\nInjected: bad", "\u00e9", "x" * 16385])
def test_missing_or_invalid_local_token_never_falls_back_to_api_key(wire, monkeypatch, token):
    monkeypatch.setenv("GRAPHIFY_OAUTH_BROKER_TOKEN", token)
    monkeypatch.setenv("OPENAI_API_KEY", SECRET)
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_broker_configuration"):
        wire.call()
    assert not wire.requests


@pytest.mark.parametrize("model", ["", "wrong-model", "openai/gpt-fixture", "gpt-fixture ", "GPT-fixture"])
def test_model_is_canonical_and_frozen(wire, model):
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_model|model_mismatch"):
        oauth.extract_graph(model, "s", "u", parse_graph=llm._parse_llm_json)
    assert not wire.requests


def test_explicit_model_does_not_need_or_fall_back_to_openai_model_env(wire, monkeypatch):
    monkeypatch.delenv("GRAPHIFY_OPENAI_MODEL")
    monkeypatch.setenv("OPENAI_MODEL", "not-the-selected-model")
    wire.call()
    assert wire.grants[0]["model"] == MODEL


def test_alias_can_resolve_to_snapshot_without_changing_request_or_cache_identity(wire, monkeypatch):
    alias, snapshot = "gpt-fixture-latest", "gpt-fixture-2026-11-27"
    monkeypatch.setenv("GRAPHIFY_OPENAI_MODEL", alias)
    wire.grant_patch["model"] = alias
    wire.events = [completion(model=snapshot)]
    for _ in range(2):
        result = oauth.extract_graph(alias, "s", "u", parse_graph=llm._parse_llm_json)
        assert result["model"] == alias
    assert all(grant["model"] == alias for grant in wire.grants)
    assert all(json.loads(request.content)["model"] == alias for request in wire.inference_requests)
    assert wire.grants[0]["requestHash"] == wire.grants[1]["requestHash"]
    assert all(outcome["outcome"] == "completed" for outcome in wire.outcomes)
    assert snapshot not in json.dumps(wire.outcomes)


@pytest.mark.parametrize("model", [None, "a" * 128])
def test_returned_model_metadata_may_be_absent_or_bounded(wire, model):
    if model is None:
        wire.events[0]["response"].pop("model")
    else:
        wire.events[0]["response"]["model"] = model
    assert wire.call()["model"] == MODEL


@pytest.mark.parametrize("model", [None, "", "a" * 129, True, {}, [], "model\n" + SECRET,
                                    "model with prose", "openai/model", "\u00e9"])
def test_present_returned_model_metadata_must_be_valid(wire, model):
    wire.events[0]["response"]["model"] = model
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_completion"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"
    assert SECRET not in json.dumps(wire.outcomes)


@pytest.mark.parametrize("url", [oauth.RESPONSES_URL, "http://127.0.0.1:43211/v1/responses"])
def test_exact_production_or_literal_fixture_destination(wire, url):
    wire.grant_patch["responsesURL"] = url
    wire.call()
    assert str(wire.inference_requests[0].url) == url


@pytest.mark.parametrize("url", [
    "https://example.invalid/v1/responses", "https://api.openai.com:443/v1/responses",
    "http://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/responses/", "https://api.openai.com/v1/responses?",
    "https://api.openai.com/v1/responses#", "https://token@api.openai.com/v1/responses",
    "https://api.openai.com.evil.invalid/v1/responses", "https://chatgpt.com/backend-api/codex/responses",
    "http://localhost:43211/v1/responses", "http://127.0.0.2:43211/v1/responses",
    "http://127.0.0.1:43211/other", "http://127.0.0.1:43211/v1/responses?x=1",
    "http://127.0.0.1:43211/v1/%72esponses", "http://127.0.0.1:0/v1/responses", None,
])
def test_other_destinations_fail_without_dispatch(wire, url):
    wire.grant_patch["responsesURL"] = url
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_responses_url"):
        wire.call()
    assert not wire.inference_requests
    assert len(wire.grants) == len(wire.outcomes) == 1
    assert wire.outcomes[0]["outcome"] == "failed"


@pytest.mark.parametrize("patch", [
    {"version": True}, {"version": 2}, {"version": "1"}, {"requestId": "wrong"},
    {"model": "wrong-model"}, {"accessToken": None}, {"accessToken": ""},
    {"accessToken": "token\r\n"}, {"expiresAt": "2000-01-01T00:00:00Z"},
    {"expiresAt": "2099-01-01T00:00:00"}, {"expiresAt": "2099-13-01T00:00:00Z"},
    {"expiresAt": None}, {"refreshToken": SECRET},
])
def test_malformed_grants_are_reported_without_inference(wire, patch):
    wire.grant_patch = patch
    with pytest.raises(oauth.OAuthResponsesError):
        wire.call()
    assert not wire.inference_requests
    assert wire.outcomes[0]["outcome"] == "failed"
    assert "Tokens" not in json.dumps(wire.outcomes[0])


def test_lost_credential_response_is_unknown_and_not_retried(wire, capsys):
    def lost(_):
        raise httpx.ReadTimeout(SECRET)

    wire.credential_reply = lost
    with pytest.raises(oauth.OAuthResponsesError, match="credential_transport") as caught:
        wire.call()
    assert caught.value.outcome == "unknown"
    assert len(wire.grants) == len(wire.outcomes) == 1
    assert not wire.inference_requests
    assert wire.outcomes[0]["outcome"] == "unknown"
    assert SECRET not in str(caught.value) + str(capsys.readouterr())


@pytest.mark.parametrize("stage", ["credential", "response", "outcome"])
@pytest.mark.parametrize("status", [301, 307, 401, 403, 429, 500])
def test_no_redirect_or_http_retry_at_any_stage(wire, stage, status):
    headers = {"Location": "https://example.invalid/steal", "Retry-After": "0"}
    reply = lambda _: httpx.Response(status, headers=headers, text=SECRET)
    if stage == "credential":
        wire.credential_reply = reply
    elif stage == "outcome":
        wire.outcome_reply = reply
    else:
        wire.response_status = status
        wire.response_headers = headers
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert len(wire.grants) == len(wire.outcomes) == 1
    assert len(wire.inference_requests) == (0 if stage == "credential" else 1)
    assert SECRET not in str(caught.value)
    if stage == "outcome":
        assert caught.value.code == "outcome_unacknowledged"
    else:
        expected = {401: "auth_required", 403: "model_unavailable", 429: "usage_limit"}.get(
            status, "broker_http_error" if stage == "credential" else "response_http_error",
        )
        assert caught.value.code == wire.outcomes[0]["code"] == expected
        assert wire.outcomes[0]["outcome"] == "failed"


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_stream_framing_across_byte_chunks_and_canonical_not_deltas(wire, newline):
    wire.events.insert(0, {"type": "response.output_text.done", "text": SECRET})
    data = b": keepalive" + newline.encode() + sse(wire.events, newline)
    wire.parts = [data[i:i + 1] for i in range(len(data))]
    result = wire.call()
    assert result["nodes"][0]["id"] == "note_architecture"
    assert SECRET not in json.dumps(result)


@pytest.mark.parametrize("data", [
    b"", b"data: [DONE]\n\n", b"data: not-json\n\n", b"data: []\n\n",
    b"data: {}\n\n", b"data: \xff\n\n",
    b'event: response.completed\ndata: {"type":"error"}\n\n',
    sse([{"type": "response.output_text.done", "text": json.dumps(GRAPH)}]),
    sse([completion()]).rstrip(b"\n"),
])
def test_malformed_stream_or_eof_before_terminal_fails_unknown(wire, data):
    wire.parts = [data]
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert caught.value.outcome == "unknown"
    assert wire.outcomes[0]["outcome"] == "unknown"
    assert len(wire.inference_requests) == 1


def test_non_sse_response_does_not_accept_plain_completed_json(wire):
    wire.response_headers = {"Content-Type": "application/json"}
    wire.parts = [json.dumps(completion()).encode()]
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_stream_type"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "unknown"


@pytest.mark.parametrize("kind", ["response.failed", "response.incomplete", "error"])
def test_terminal_failure_and_usage_error_events_never_complete(wire, kind, capsys):
    wire.events = [{"type": kind, "message": SECRET, "code": SECRET,
                    "response": {"id": "resp_fixture", "status": "failed",
                                 "usage": {"input_tokens": 17, "output_tokens": 0}}}]
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"
    assert wire.outcomes[0]["inputTokens"] == 17
    assert wire.outcomes[0]["outputTokens"] == 0
    assert SECRET not in str(caught.value) + str(capsys.readouterr()) + json.dumps(wire.outcomes)


@pytest.mark.parametrize("source", ["response.failed", "error", "nested_error"])
@pytest.mark.parametrize("code,expected", [
    ("invalid_api_key", "auth_required"),
    ("authentication_error", "auth_required"),
    ("permission_error", "auth_required"),
    ("subscription_sharing_invalid_user", "auth_required"),
    ("subscription_sharing_user_unavailable", "auth_required"),
    ("chatpass_v2_scope_not_authorized", "auth_required"),
    ("chatpass_v2_invalid_authorization_context", "auth_required"),
    ("model_not_found", "model_unavailable"),
    ("subscription_sharing_unsupported_capability", "model_unavailable"),
    ("subscription_sharing_route_not_supported", "model_unavailable"),
    ("subscription_sharing_user_not_eligible", "model_unavailable"),
    ("rate_limit_exceeded", "usage_limit"),
    ("rate_limit_error", "usage_limit"),
    ("too_many_requests", "usage_limit"),
    ("insufficient_quota", "usage_limit"),
    ("quota_exceeded", "usage_limit"),
    ("billing_hard_limit_reached", "usage_limit"),
    ("billing_not_active", "usage_limit"),
    ("subscription_sharing_usage_limit_exceeded", "usage_limit"),
    ("subscription_sharing_usage_unavailable", "usage_limit"),
])
def test_allowlisted_failure_diagnostics_are_safe_and_never_retried(wire, source, code, expected, capsys):
    error = {"code": code, "message": SECRET, "param": SECRET}
    if source == "response.failed":
        event = {"type": source, "response": {"id": "resp_fixture", "status": "failed", "error": error,
                                              "usage": {"input_tokens": 17, "output_tokens": 0}}}
    elif source == "nested_error":
        event = {"type": "error", "error": error}
    else:
        event = {"type": "error", **error}
    wire.events.insert(0, event)
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert caught.value.code == wire.outcomes[0]["code"] == expected
    assert wire.outcomes[0]["outcome"] == "failed"
    if source == "response.failed":
        assert wire.outcomes[0]["inputTokens"] == 17
        assert wire.outcomes[0]["outputTokens"] == 0
    assert len(wire.grants) == len(wire.inference_requests) == len(wire.outcomes) == 1
    assert SECRET not in str(caught.value) + str(capsys.readouterr()) + json.dumps(wire.outcomes)


@pytest.mark.parametrize("code", [None, SECRET, "insufficient_quota " + SECRET, "INVALID_API_KEY",
                                   True, {"code": "invalid_api_key"}, ["insufficient_quota"], "server_error"])
@pytest.mark.parametrize("kind", ["error", "response.failed"])
def test_unknown_codes_and_arbitrary_error_prose_never_become_diagnostics(wire, code, kind, capsys):
    error = {"code": code, "type": "insufficient_quota", "message": "invalid_api_key " + SECRET}
    if kind == "error":
        wire.events = [{"type": kind, "error": error}]
    else:
        wire.events = [{"type": kind, "response": {"id": "resp_fixture", "status": "failed", "error": error}}]
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    expected = "response_error" if kind == "error" else "response_failed"
    assert caught.value.code == wire.outcomes[0]["code"] == expected
    assert wire.outcomes[0]["outcome"] == "failed"
    assert SECRET not in str(caught.value) + str(capsys.readouterr()) + json.dumps(wire.outcomes)


@pytest.mark.parametrize("response_code,expected", [("model_not_found", "model_unavailable"),
                                                     (SECRET, "response_failed")])
def test_canonical_error_code_takes_precedence_over_lower_priority_diagnostics(wire, response_code, expected):
    wire.events = [{
        "type": "response.failed", "code": "invalid_api_key", "error": {"code": "insufficient_quota"},
        "response": {"id": "resp_fixture", "status": "failed", "error": {"code": response_code}},
    }]
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert caught.value.code == wire.outcomes[0]["code"] == expected


def test_diagnostic_does_not_override_missing_outcome_ack(wire):
    wire.response_status = 429
    wire.ack_patch["accepted"] = False
    with pytest.raises(oauth.OAuthResponsesError, match="outcome_unacknowledged"):
        wire.call()
    assert wire.outcomes[0]["code"] == "usage_limit"
    assert len(wire.grants) == len(wire.inference_requests) == len(wire.outcomes) == 1


@pytest.mark.parametrize("change", [
    {"status": "incomplete"}, {"status": None},
    {"error": {"message": SECRET}}, {"incomplete_details": {"reason": SECRET}},
    {"output": None}, {"output": []}, {"output": [None]},
    {"output": [{"type": "function_call", "arguments": SECRET}]},
    {"output": [{"type": "message", "role": "assistant", "status": "in_progress", "content": []}]},
    {"output": [{"type": "message", "role": "user", "status": "completed", "content": []}]},
    {"output": [{"type": "message", "role": "assistant", "status": "completed",
                 "content": [{"type": "refusal", "refusal": SECRET}]}]},
    {"output": [{"type": "message", "role": "assistant", "status": "completed",
                 "content": [{"type": "output_audio", "audio": SECRET}]}]},
    {"id": "not-safe/" + SECRET},
])
def test_canonical_completion_must_be_completed_assistant_text_only(wire, change):
    wire.events = [completion(**change)]
    with pytest.raises(oauth.OAuthResponsesError) as caught:
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"
    assert SECRET not in str(caught.value) + json.dumps(wire.outcomes)


@pytest.mark.parametrize("event", [
    {"type": "response.refusal.delta", "delta": SECRET},
    {"type": "response.output_item.added", "item": {"type": "function_call"}},
    {"type": "response.output_item.done", "item": {"type": "web_search_call"}},
])
def test_observed_refusal_or_tool_events_are_rejected(wire, event):
    wire.events.insert(0, event)
    with pytest.raises(oauth.OAuthResponsesError):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"


@pytest.mark.parametrize("usage", [None, {}, {"input_tokens": 0}, {"output_tokens": 0},
                                    {"input_tokens": 1234567, "output_tokens": 7654321}])
def test_usage_is_exact_when_observed_and_omitted_when_unknown(wire, usage):
    wire.events = [completion(usage=usage)]
    result = wire.call()
    for source, target in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens")):
        if source in (usage or {}):
            assert result[source] == usage[source]
            assert wire.outcomes[0][target] == usage[source]
        else:
            assert source not in result
            assert target not in wire.outcomes[0]


@pytest.mark.parametrize("usage", ["bad", [], {"input_tokens": -1}, {"input_tokens": True},
                                    {"output_tokens": "9"}, {"output_tokens": 9.0}])
def test_malformed_usage_is_not_coerced_to_zero_or_success(wire, usage):
    wire.events = [completion(usage=usage)]
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_usage"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"


def test_valid_usage_field_survives_other_invalid_metadata(wire):
    wire.events = [completion(usage={"input_tokens": False, "output_tokens": 9}, id=SECRET)]
    with pytest.raises(oauth.OAuthResponsesError):
        wire.call()
    assert wire.outcomes[0]["outputTokens"] == 9
    assert "inputTokens" not in wire.outcomes[0]
    assert "responseId" not in wire.outcomes[0]


def test_observed_usage_survives_connection_loss(wire):
    wire.parts = [sse([{"type": "response.in_progress", "response": {
        "id": "resp_fixture", "usage": {"input_tokens": 17},
    }}]), httpx.ReadError(SECRET)]
    with pytest.raises(oauth.OAuthResponsesError, match="response_transport"):
        wire.call()
    assert wire.outcomes[0] == {
        "version": 1, "requestId": wire.grants[0]["requestId"], "outcome": "unknown",
        "code": "response_transport", "responseId": "resp_fixture", "inputTokens": 17,
    }


@pytest.mark.parametrize("text", [
    SECRET, "{", "[]", "null", "{}", '{"nodes":[]}', '{"edges":[]}',
    '{"nodes":{},"edges":[],"hyperedges":[]}', '{"nodes":["bad"],"edges":[],"hyperedges":[]}',
    '{"nodes":[],"edges":null,"hyperedges":[]}', '{"nodes":[],"edges":[],"hyperedges":[[]]}',
    '{"nodes":[],"nodes":[],"edges":[],"hyperedges":[]}',
    '{"nodes":[],"edges":[],"hyperedges":[],"bad":NaN}',
    '{"nodes":[],"edges":[],"hyperedges":[],"bad":1e999}',
])
def test_invalid_graph_containers_fail_before_completed_receipt_without_raw_logging(wire, text, capsys):
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = text
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_graph_json"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"
    assert wire.outcomes[0]["inputTokens"] == 17
    assert SECRET not in str(capsys.readouterr())


@pytest.mark.parametrize("nodes", [[], GRAPH["nodes"]])
def test_hyperedges_may_be_absent_while_nodes_and_edges_remain_required(wire, nodes):
    graph = {"nodes": nodes, "edges": []}
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = json.dumps(graph)
    result = wire.call()
    assert result["nodes"] == nodes
    assert result["edges"] == result["hyperedges"] == []
    assert wire.outcomes[0]["outcome"] == "completed"


@pytest.mark.parametrize("hyperedges", [None, {}, "not an array", [None], ["not an object"]])
def test_present_hyperedges_must_still_be_valid_graph_containers(wire, hyperedges):
    graph = {**GRAPH, "hyperedges": hyperedges}
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = json.dumps(graph)
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_graph_json"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "failed"


def test_existing_graph_parser_runs_before_completed_receipt_and_cannot_log_raw_text(wire, capsys):
    graph = {"nodes": [{"id": "<think>", "label": SECRET}], "edges": [],
             "hyperedges": [{"id": "</think>", "nodes": ["<think>"]}]}
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = json.dumps(graph)

    def parse(text):
        assert not wire.outcomes
        return llm._parse_llm_json(text)

    result = oauth.extract_graph(MODEL, "s", "u", parse_graph=parse)
    assert result["nodes"] == graph["nodes"]
    assert SECRET not in str(capsys.readouterr())


def test_graph_parser_failure_is_reported_before_any_completed_receipt(wire, capsys):
    def parse(_):
        assert not wire.outcomes
        raise ValueError(SECRET)

    with pytest.raises(oauth.OAuthResponsesError, match="invalid_graph_json") as caught:
        oauth.extract_graph(MODEL, "s", "u", parse_graph=parse)
    assert wire.outcomes[0]["outcome"] == "failed"
    assert SECRET not in str(caught.value) + str(capsys.readouterr())


@pytest.mark.parametrize("patch", [
    {"version": True}, {"version": 2}, {"requestId": "wrong"}, {"accepted": False},
    {"accepted": 1}, {"accepted": "true"}, {"extra": SECRET},
])
def test_bad_ack_never_returns_extraction_success(wire, patch):
    wire.ack_patch = patch
    with pytest.raises(oauth.OAuthResponsesError, match="outcome_unacknowledged") as caught:
        wire.call()
    assert caught.value.outcome == "unknown"
    assert len(wire.outcomes) == len(wire.inference_requests) == 1


def test_lost_ack_never_retries_either_request(wire):
    def lost(_):
        raise httpx.ReadTimeout(SECRET)

    wire.outcome_reply = lost
    with pytest.raises(oauth.OAuthResponsesError, match="outcome_unacknowledged"):
        wire.call()
    assert len(wire.grants) == len(wire.outcomes) == len(wire.inference_requests) == 1


@pytest.mark.parametrize("stage", ["credential", "outcome"])
@pytest.mark.parametrize("raw", [b"[]", b"{", b'{}', b'{"version":1,"version":1}', b"\xff"])
def test_invalid_broker_json_is_not_accepted(wire, stage, raw):
    reply = lambda _: httpx.Response(200, content=raw)
    if stage == "credential":
        wire.credential_reply = reply
    else:
        wire.outcome_reply = reply
    with pytest.raises(oauth.OAuthResponsesError):
        wire.call()
    assert len(wire.outcomes) == 1
    assert len(wire.inference_requests) == (0 if stage == "credential" else 1)


def test_request_stream_and_broker_reads_are_bounded(wire, monkeypatch):
    monkeypatch.setattr(oauth, "_MAX_REQUEST", 10)
    with pytest.raises(oauth.OAuthResponsesError, match="request_too_large"):
        wire.call()
    assert not wire.requests
    monkeypatch.setattr(oauth, "_MAX_REQUEST", 8 * 1024 * 1024)
    monkeypatch.setattr(oauth, "_MAX_STREAM", 32)
    with pytest.raises(oauth.OAuthResponsesError, match="response_too_large"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "unknown"
    wire.credential_reply = lambda _: httpx.Response(200, content=b"x" * (oauth._MAX_BROKER + 1))
    with pytest.raises(oauth.OAuthResponsesError, match="response_too_large"):
        wire.call()
    assert len(wire.inference_requests) == 1
    assert len(wire.outcomes) == 2


@pytest.mark.parametrize("extra", [0, 1])
def test_actual_request_byte_cap_matches_native_eight_mib(wire, extra):
    assert oauth._MAX_REQUEST == 8 * 1024 * 1024
    overhead = len(json.dumps({
        "model": MODEL, "instructions": "", "input": "", "store": False, "stream": True,
    }, sort_keys=True, separators=(",", ":")).encode())
    text = "x" * (oauth._MAX_REQUEST - overhead + extra)
    if extra:
        with pytest.raises(oauth.OAuthResponsesError, match="request_too_large"):
            oauth.extract_graph(MODEL, "", text, parse_graph=llm._parse_llm_json)
        assert not wire.requests
    else:
        oauth.extract_graph(MODEL, "", text, parse_graph=llm._parse_llm_json)
        assert wire.grants[0]["inputBytes"] == len(wire.inference_requests[0].content) == oauth._MAX_REQUEST


def test_output_and_parser_limit_stays_separate_from_request_limit(wire, monkeypatch):
    assert oauth._MAX_OUTPUT == 10 * 1024 * 1024
    monkeypatch.setattr(oauth, "_MAX_REQUEST", 256)
    graph = {"nodes": [{"id": "fixture", "label": "x" * 1024}], "edges": []}
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = json.dumps(graph)
    assert wire.call()["nodes"] == graph["nodes"]
    monkeypatch.setattr(oauth, "_MAX_OUTPUT", 256)
    with pytest.raises(oauth.OAuthResponsesError, match="invalid_output"):
        wire.call()
    assert wire.outcomes[-1]["outcome"] == "failed"


def test_stream_deadline_still_reports_outcome(wire, monkeypatch):
    monkeypatch.setattr(oauth, "_REQUEST_SECONDS", -1)
    with pytest.raises(oauth.OAuthResponsesError, match="response_deadline"):
        wire.call()
    assert wire.outcomes[0]["outcome"] == "unknown"


@pytest.mark.parametrize("empty", [True, False])
def test_generic_adaptive_retry_does_not_repeat_oauth_calls(wire, tmp_path, empty):
    note = tmp_path / "note.md"
    note.write_text("# Fixture\n", encoding="utf-8")
    text = '{"nodes":[],"edges":[],"hyperedges":[]}' if empty else "invalid"
    wire.events[0]["response"]["output"][0]["content"][0]["text"] = text
    if empty:
        result = llm._extract_with_adaptive_retry([note], "openai-oauth", None, MODEL, tmp_path, 3)
        assert result["finish_reason"] == "stop"
    else:
        with pytest.raises(oauth.OAuthResponsesError):
            llm._extract_with_adaptive_retry([note], "openai-oauth", None, MODEL, tmp_path, 3)
    assert len(wire.grants) == len(wire.inference_requests) == len(wire.outcomes) == 1


@pytest.mark.parametrize("extra", [[], ["--no-cluster"]])
def test_cli_explicit_oauth_no_key_and_no_fake_dollar_estimate(wire, tmp_path, monkeypatch, capsys, extra):
    import graphify.__main__ as main

    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "note.md").write_text("# Architecture\nA local fixture.\n", encoding="utf-8")
    output = tmp_path / "output"
    monkeypatch.setattr(main, "_check_skill_version", lambda _: None)
    monkeypatch.setenv("GRAPHIFY_NO_INCREMENTAL_CACHE", "1")
    monkeypatch.setattr(main.sys, "argv", [
        "graphify", "extract", str(corpus), "--backend", "openai-oauth", "--model", MODEL,
        "--out", str(output), "--no-gitignore", *extra,
    ])
    try:
        main.main()
    except SystemExit as exc:
        assert exc.code in (None, 0)
    captured = capsys.readouterr()
    assert "no API-dollar estimate" in captured.out
    assert "est. cost" not in captured.out
    assert "$0" not in captured.out
    assert not (output / "graphify-out" / "cost.json").exists()
    assert len(wire.grants) == len(wire.outcomes) == len(wire.inference_requests) == 1
    assert llm.estimate_cost("openai-oauth", 17, 9) is None
    assert llm.estimate_cost("openai", 1_000_000, 1_000_000) == 2.0

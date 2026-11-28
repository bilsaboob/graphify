"""Explicit, single-attempt OAuth Responses transport; credentials stay broker-owned."""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from collections.abc import Callable, Iterator
from datetime import datetime, timezone

import httpx2 as httpx

RESPONSES_URL = "https://api.openai.com/v1/responses"
_MAX_REQUEST = 8 * 1024 * 1024
_MAX_OUTPUT = 10 * 1024 * 1024
_MAX_STREAM = 32 * 1024 * 1024
_MAX_BROKER = 64 * 1024
_REQUEST_SECONDS = 600
_CREDENTIAL_SECONDS = 60
_BROKER_SECONDS = 10
_BEARER = re.compile(r"[A-Za-z0-9._~+/-]+=*")
_HTTP_FAILURES = {401: "auth_required", 403: "model_unavailable", 429: "usage_limit"}
_ERROR_CODES = {
    "invalid_api_key": "auth_required",
    "authentication_error": "auth_required",
    "permission_error": "auth_required",
    "subscription_sharing_invalid_user": "auth_required",
    "subscription_sharing_user_unavailable": "auth_required",
    "chatpass_v2_scope_not_authorized": "auth_required",
    "chatpass_v2_invalid_authorization_context": "auth_required",
    "model_not_found": "model_unavailable",
    "subscription_sharing_unsupported_capability": "model_unavailable",
    "subscription_sharing_route_not_supported": "model_unavailable",
    "subscription_sharing_user_not_eligible": "model_unavailable",
    "rate_limit_exceeded": "usage_limit",
    "rate_limit_error": "usage_limit",
    "too_many_requests": "usage_limit",
    "insufficient_quota": "usage_limit",
    "quota_exceeded": "usage_limit",
    "billing_hard_limit_reached": "usage_limit",
    "billing_not_active": "usage_limit",
    "subscription_sharing_usage_limit_exceeded": "usage_limit",
    "subscription_sharing_usage_unavailable": "usage_limit",
}


class OAuthResponsesError(RuntimeError):
    """Only stable local codes may cross the CLI's exception/logging boundary."""

    def __init__(self, code: str, outcome: str = "failed"):
        self.code = code
        self.outcome = outcome
        super().__init__(f"openai-oauth: {code}")


def _loopback_url(url: object, path: str = "") -> bool:
    if not isinstance(url, str):
        return False
    match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})" + re.escape(path), url)
    return match is not None and int(match[1]) <= 65535


def _bearer(token: object) -> bool:
    return isinstance(token, str) and 0 < len(token) <= 16384 and _BEARER.fullmatch(token) is not None


def configuration(model: str) -> tuple[str, str]:
    """Validate explicit local handoff settings without contacting any service."""
    broker = os.environ.get("GRAPHIFY_OAUTH_BROKER_URL", "")
    token = os.environ.get("GRAPHIFY_OAUTH_BROKER_TOKEN", "")
    frozen = os.environ.get("GRAPHIFY_OPENAI_MODEL", "")
    if not _loopback_url(broker) or not _bearer(token):
        raise OAuthResponsesError("invalid_broker_configuration")
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", model):
        raise OAuthResponsesError("invalid_model")
    if frozen and model != frozen:
        raise OAuthResponsesError("model_mismatch")
    return broker, token


def _json(raw: str | bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("nonfinite number")

    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def _chunks(response: httpx.Response, limit: int, deadline: float) -> Iterator[bytes]:
    size = 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > limit:
            raise OAuthResponsesError("response_too_large", "unknown")
        if time.monotonic() > deadline:
            raise OAuthResponsesError("response_deadline", "unknown")
        yield chunk


def _broker(client, url: str, token: str, payload: dict, *, timeout: float = _BROKER_SECONDS) -> dict:
    deadline = time.monotonic() + timeout
    with client.stream(
        "POST", url, headers={"Authorization": f"Bearer {token}"}, json=payload,
        timeout=timeout,
    ) as response:
        if response.status_code != 200:
            raise OAuthResponsesError(_HTTP_FAILURES.get(response.status_code, "broker_http_error"))
        data = _json(b"".join(_chunks(response, _MAX_BROKER, deadline)))
        if not isinstance(data, dict):
            raise OAuthResponsesError("invalid_broker_response")
        return data


def _grant(data: dict, request_id: str, model: str) -> tuple[str, str]:
    expected = {"version", "requestId", "model", "accessToken", "expiresAt", "responsesURL"}
    if (set(data) != expected or type(data.get("version")) is not int or data["version"] != 1
            or data.get("requestId") != request_id or data.get("model") != model
            or not _bearer(data.get("accessToken"))):
        raise OAuthResponsesError("invalid_credential_grant")
    expiry = data.get("expiresAt")
    if not isinstance(expiry, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", expiry
    ):
        raise OAuthResponsesError("invalid_credential_expiry")
    try:
        valid = datetime.fromisoformat(expiry.replace("Z", "+00:00")) > datetime.now(timezone.utc)
    except ValueError:
        valid = False
    if not valid:
        raise OAuthResponsesError("invalid_credential_expiry")
    url = data["responsesURL"]
    # Only the trusted fixture broker may substitute a literal loopback Responses server.
    if url != RESPONSES_URL and not _loopback_url(url, "/v1/responses"):
        raise OAuthResponsesError("invalid_responses_url")
    return data["accessToken"], url


def _events(response: httpx.Response, deadline: float) -> Iterator[dict]:
    buffer = b""
    data: list[str] = []
    event = ""
    skip_lf = False
    for chunk in _chunks(response, _MAX_STREAM, deadline):
        if skip_lf and chunk:
            chunk = chunk.removeprefix(b"\n")
            skip_lf = False
        buffer += chunk
        while (match := re.search(b"[\r\n]", buffer)) is not None:
            pos = match.start()
            skip_lf = buffer[pos:] == b"\r"
            line = buffer[:pos].decode("utf-8")
            buffer = buffer[pos + (2 if buffer[pos:pos + 2] == b"\r\n" else 1):]
            if not line:
                if data:
                    raw = "\n".join(data)
                    if raw == "[DONE]":
                        return  # Not a canonical response.completed event.
                    value = _json(raw)
                    if (not isinstance(value, dict) or not isinstance(value.get("type"), str)
                            or (event and event != value["type"])):
                        raise OAuthResponsesError("invalid_stream_event", "unknown")
                    yield value
                data, event = [], ""
            elif line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
            elif line.startswith("event:"):
                event = line[6:].removeprefix(" ")


def _observe(response: dict, outcome: dict) -> None:
    error = None
    response_id = response.get("id")
    if response_id is not None:
        if not isinstance(response_id, str) or not re.fullmatch(r"resp_[A-Za-z0-9_-]{1,123}", response_id):
            error = "invalid_response_id"
        elif "responseId" in outcome and outcome["responseId"] != response_id:
            error = "response_id_mismatch"
        else:
            outcome["responseId"] = response_id
    usage = response.get("usage")
    if usage is not None:
        if not isinstance(usage, dict):
            raise OAuthResponsesError("invalid_usage")
        for wire, key in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens")):
            count = usage.get(wire)
            if count is not None:
                if type(count) is not int or count < 0:
                    error = "invalid_usage"
                else:
                    outcome[key] = count
    if error:
        raise OAuthResponsesError(error)


def _completed(response: dict) -> str:
    if (response.get("status") != "completed" or response.get("error") is not None
            or response.get("incomplete_details") is not None):
        raise OAuthResponsesError("invalid_completion")
    # An alias may resolve to a snapshot; metadata never changes request identity.
    if "model" in response and (
        not isinstance(response["model"], str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", response["model"])
    ):
        raise OAuthResponsesError("invalid_completion")
    output = response.get("output")
    if not isinstance(output, list):
        raise OAuthResponsesError("invalid_output")
    texts = []
    for item in output:
        if not isinstance(item, dict):
            raise OAuthResponsesError("invalid_output")
        if item.get("type") == "reasoning":
            continue
        if (item.get("type") != "message" or item.get("role") != "assistant"
                or item.get("status") != "completed" or not isinstance(item.get("content"), list)):
            raise OAuthResponsesError("unsupported_output")
        for part in item["content"]:
            if isinstance(part, dict) and part.get("type") == "refusal":
                raise OAuthResponsesError("response_refused")
            if (not isinstance(part, dict) or part.get("type") != "output_text"
                    or not isinstance(part.get("text"), str)):
                raise OAuthResponsesError("unsupported_output")
            texts.append(part["text"])
    text = "".join(texts)
    if not text.strip() or len(text.encode("utf-8")) > _MAX_OUTPUT:
        raise OAuthResponsesError("invalid_output")
    return text


def extract_graph(model: str, instructions: str, text: str, *, parse_graph: Callable[[str], dict]) -> dict:
    """One grant, one Responses POST, one acknowledged outcome; never retry."""
    broker, local_token = configuration(model)
    if not isinstance(instructions, str) or not isinstance(text, str):
        raise OAuthResponsesError("invalid_request")
    body = json.dumps(
        {"model": model, "instructions": instructions, "input": text, "store": False, "stream": True},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode("utf-8")
    if len(body) > _MAX_REQUEST:
        raise OAuthResponsesError("request_too_large")
    request_id = str(uuid.uuid4())
    credential = {
        "version": 1, "requestId": request_id, "model": model,
        "requestHash": hashlib.sha256(body).hexdigest(), "inputBytes": len(body),
    }
    outcome = {"version": 1, "requestId": request_id, "outcome": "unknown", "code": "credential_transport"}
    failure = None
    stage = "credential_transport"
    with httpx.Client(
        trust_env=False, follow_redirects=False,
        transport=httpx.HTTPTransport(retries=0, trust_env=False),
        timeout=httpx.Timeout(60, connect=10, write=30, pool=10),
    ) as client:
        try:
            grant = _broker(client, broker + "/v1/credential", local_token, credential, timeout=_CREDENTIAL_SECONDS)
            access_token, url = _grant(grant, request_id, model)
            stage = "response_transport"
            outcome["code"] = stage
            with client.stream("POST", url, content=body, headers={
                "Authorization": f"Bearer {access_token}", "Content-Type": "application/json",
                "Accept": "text/event-stream", "X-Client-Request-Id": request_id,
            }) as response:
                if response.status_code != 200:
                    raise OAuthResponsesError(_HTTP_FAILURES.get(response.status_code, "response_http_error"))
                if response.headers.get("content-type", "").split(";", 1)[0].strip() != "text/event-stream":
                    raise OAuthResponsesError("invalid_stream_type", "unknown")
                for event in _events(response, time.monotonic() + _REQUEST_SECONDS):
                    canonical = event.get("response")
                    if isinstance(canonical, dict):
                        _observe(canonical, outcome)
                    kind = event["type"]
                    if kind in ("error", "response.failed", "response.incomplete"):
                        default_code = "response_error" if kind == "error" else kind.replace(".", "_")
                        code = default_code
                        if kind != "response.incomplete":
                            # Match native precedence without copying remote prose or unknown codes.
                            for source in (event, event.get("error"),
                                           canonical.get("error") if isinstance(canonical, dict) else None):
                                candidate = source.get("code") if isinstance(source, dict) else None
                                if isinstance(candidate, str) and candidate:
                                    code = _ERROR_CODES.get(candidate, default_code)
                        raise OAuthResponsesError(code)
                    if kind.startswith("response.refusal."):
                        raise OAuthResponsesError("response_refused")
                    if kind in ("response.output_item.added", "response.output_item.done"):
                        item = event.get("item")
                        if not isinstance(item, dict) or item.get("type") not in ("reasoning", "message"):
                            raise OAuthResponsesError("unsupported_output")
                    if kind == "response.completed":
                        if not isinstance(canonical, dict):
                            raise OAuthResponsesError("invalid_completion")
                        final_text = _completed(canonical)
                        try:
                            graph = _json(final_text)
                            if isinstance(graph, dict):
                                graph.setdefault("hyperedges", [])
                            if not isinstance(graph, dict) or any(
                                not isinstance(graph.get(key), list)
                                or any(not isinstance(row, dict) for row in graph[key])
                                for key in ("nodes", "edges", "hyperedges")
                            ):
                                raise ValueError("invalid graph containers")
                            # Avoid the generic parser's prose/think-block recovery and
                            # raw-invalid-text log path while retaining its sanitization.
                            parse_text = json.dumps(graph, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c")
                            if len(parse_text) > _MAX_OUTPUT:
                                raise ValueError("graph exceeds parser bound")
                            result = parse_graph(parse_text)
                        except Exception:
                            raise OAuthResponsesError("invalid_graph_json") from None
                        break
                else:
                    raise OAuthResponsesError("stream_ended", "unknown")
            # Never trust token counts generated inside the graph JSON itself.
            for wire, key in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens")):
                result.pop(wire, None)
                if key in outcome:
                    result[wire] = outcome[key]
            result.update(model=model, finish_reason="stop")
            outcome.update(outcome="completed", code="")
        except OAuthResponsesError as exc:
            failure = exc
            outcome.update(outcome=exc.outcome, code=exc.code)
        except Exception:
            failure = OAuthResponsesError(stage, "unknown")
            outcome.update(outcome="unknown", code=stage)
        finally:
            try:
                ack = _broker(client, broker + "/v1/outcome", local_token, outcome)
                if (set(ack) != {"version", "requestId", "accepted"}
                        or type(ack.get("version")) is not int or ack["version"] != 1
                        or ack.get("requestId") != request_id or ack.get("accepted") is not True):
                    raise ValueError("invalid acknowledgement")
            except Exception:
                raise OAuthResponsesError("outcome_unacknowledged", "unknown") from None
        if failure is not None:
            raise failure from None
        return result

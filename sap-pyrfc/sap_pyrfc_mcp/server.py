"""SAP PyRFC MCP server — dynamic sap_connect + connection_id (multi-user)."""

from __future__ import annotations

import json
import os
from typing import Any

from mcp.server.fastmcp import FastMCP

from sap_pyrfc_mcp import connection
from sap_pyrfc_mcp.config import (
    build_adt_config,
    build_rfc_config,
    derive_adt_url_from_rfc,
    is_adt_configured,
    is_sap_configured,
)
from sap_pyrfc_mcp.registry import get_registry

_HOST = os.environ.get("MCP_HOST", "127.0.0.1").strip() or "127.0.0.1"
_PORT = int(os.environ.get("MCP_PORT", "8200") or "8200")
_PATH = os.environ.get("MCP_PATH", "/mcp").strip() or "/mcp"

mcp = FastMCP(
    "sap-pyrfc-mcp",
    instructions=(
        "Multi-user SAP PyRFC/ADT MCP. "
        "Always call sap_connect first with SAP credentials; use the returned connection_id "
        "on every subsequent tool (call_rfc, read_table, …). "
        "Do not disconnect/reconnect on every call — reuse connection_id across the conversation."
    ),
    host=_HOST,
    port=_PORT,
    streamable_http_path=_PATH,
    # One process shares the ConnectionRegistry across BuildingAI chat turns.
    stateless_http=False,
    json_response=True,
)


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, default=str)


@mcp.tool()
def sap_connect(
    user: str,
    password: str,
    client: str = "100",
    ashost: str = "",
    sysnr: str = "00",
    language: str = "EN",
    saprouter: str = "",
    mshost: str = "",
    msserv: str = "",
    group: str = "",
    r3name: str = "",
    url: str = "",
    backend: str = "auto",
    tls_verify: bool = False,
    timeout: int = 60,
    https: bool = True,
) -> str:
    """Connect to SAP for this chat. Returns connection_id (password never echoed).

    Provide RFC params (ashost+sysnr or mshost, optional saprouter) and/or ADT url.
    If url is empty but ashost is set, an ADT URL is derived as https://ashost:44300+sysnr.
    """
    try:
        rfc = build_rfc_config(
            ashost=ashost,
            sysnr=sysnr,
            client=client,
            user=user,
            password=password,
            language=language,
            saprouter=saprouter,
            mshost=mshost,
            msserv=msserv,
            group=group,
            r3name=r3name,
        )
        adt_url = (url or "").strip()
        if not adt_url and rfc.ashost:
            adt_url = derive_adt_url_from_rfc(rfc.ashost, rfc.sysnr, https=https)
        adt = (
            build_adt_config(
                url=adt_url,
                user=user,
                password=password,
                client=client,
                language=language,
                tls_verify=tls_verify,
                timeout=timeout,
            )
            if adt_url
            else None
        )

        if not is_sap_configured(rfc) and not (adt and is_adt_configured(adt)):
            return _json(
                {
                    "error": (
                        "Provide ashost (or mshost) and/or url, plus user/password/client."
                    )
                }
            )

        mode = (backend or "auto").lower()
        if mode not in ("auto", "pyrfc", "adt"):
            mode = "auto"

        # Soft ping — still register if ping fails so caller can inspect error.
        ping: dict[str, Any] | None = None
        ping_error: str | None = None
        try:
            ping = connection.ping_sap(
                rfc=rfc if is_sap_configured(rfc) else None,
                adt=adt,
                preferred=mode,
            )
        except Exception as exc:
            ping_error = str(exc)

        info = get_registry().connect(
            rfc=rfc if is_sap_configured(rfc) else None,
            adt=adt,
            backend=mode,
        )
        result: dict[str, Any] = {**info, "connected": ping_error is None}
        if ping is not None:
            result["ping"] = ping
        if ping_error:
            result["ping_error"] = ping_error
            result["warning"] = (
                "connection_id was created but live ping failed. "
                "Check host/port/saprouter/VPN, then retry tools or reconnect."
            )
        return _json(result)
    except Exception as exc:
        return _json({"error": str(exc)})


@mcp.tool()
def sap_disconnect(connection_id: str) -> str:
    """Disconnect and destroy a connection_id."""
    try:
        return _json(get_registry().disconnect(connection_id))
    except Exception as exc:
        return _json({"error": str(exc)})


@mcp.tool()
def sap_whoami(connection_id: str) -> str:
    """Show non-secret metadata for a connection_id."""
    try:
        return _json(get_registry().whoami(connection_id))
    except Exception as exc:
        return _json({"error": str(exc)})


@mcp.tool()
def healthcheck(connection_id: str = "") -> str:
    """Check SDK / backends. Pass connection_id to ping that session."""
    status = connection.pyrfc_status()
    result: dict[str, Any] = {"status": "ok", **status, "registry_size": get_registry().size()}

    if status["active_backend"] == "none" and not (connection_id or "").strip():
        result["status"] = "not_ready"
        result["next_steps"] = [
            "Chat: sap_connect(ashost, sysnr, user, password, client[, saprouter|url])",
            "PyRFC: ./install-nwrfcsdk.sh && ./install-pyrfc.sh",
            "ADT: pass url=https://host:44300 in sap_connect",
        ]
        return _json(result)

    cid = (connection_id or "").strip()
    if not cid:
        result["note"] = "Pass connection_id to ping a live sap_connect session."
        return _json(result)

    try:
        def _ping(entry):
            return connection.ping_sap(rfc=entry.rfc, adt=entry.adt, preferred=entry.backend)

        ping = get_registry().call_with(cid, _ping)
        result["status"] = "connected"
        result["connection"] = get_registry().whoami(cid)
        result["ping"] = ping
    except Exception as exc:
        result["status"] = "connection_failed"
        result["error"] = str(exc)
    return _json(result)


@mcp.tool()
def call_rfc(connection_id: str, function_name: str, parameters_json: str = "{}") -> str:
    """Invoke an RFC/BAPI (PyRFC backend). Requires connection_id from sap_connect."""
    try:
        parameters = json.loads(parameters_json or "{}")
        if not isinstance(parameters, dict):
            raise ValueError("parameters_json must decode to a JSON object")
    except (json.JSONDecodeError, ValueError) as exc:
        return _json({"error": f"Invalid parameters_json: {exc}"})

    try:
        def _call(entry):
            return connection.call_rfc(
                function_name.upper(),
                parameters,
                rfc=entry.rfc,
                adt=entry.adt,
                preferred=entry.backend,
            )

        data = get_registry().call_with(connection_id, _call)
        return _json({"function": function_name.upper(), "backend": "pyrfc", "result": data})
    except Exception as exc:
        return _json({"function": function_name.upper(), "error": str(exc)})


@mcp.tool()
def get_rfc_function_description(connection_id: str, function_name: str) -> str:
    """Return RFC function metadata (PyRFC). Requires connection_id."""
    try:
        def _call(entry):
            return connection.get_function_description(
                function_name.upper(),
                rfc=entry.rfc,
                adt=entry.adt,
                preferred=entry.backend,
            )

        data = get_registry().call_with(connection_id, _call)
        return _json({"function": function_name.upper(), "backend": "pyrfc", "description": data})
    except Exception as exc:
        return _json({"function": function_name.upper(), "error": str(exc)})


@mcp.tool()
def read_table(
    connection_id: str,
    table_name: str,
    fields: str = "",
    where: str = "",
    row_count: int = 20,
    row_skip: int = 0,
) -> str:
    """Read SAP table via RFC_READ_TABLE or ADT. Requires connection_id."""
    field_list = [part.strip() for part in fields.split(",") if part.strip()] or None
    try:
        def _call(entry):
            return connection.read_table(
                table_name=table_name,
                fields=field_list,
                where=where,
                row_count=row_count,
                row_skip=row_skip,
                rfc=entry.rfc,
                adt=entry.adt,
                preferred=entry.backend,
            )

        data = get_registry().call_with(connection_id, _call)
        return _json(data)
    except Exception as exc:
        return _json({"table": table_name.upper(), "error": str(exc)})


@mcp.tool()
def run_query(connection_id: str, sql_query: str, row_count: int = 20) -> str:
    """Run freestyle SQL via ADT datapreview. Requires connection_id."""
    try:
        def _call(entry):
            return connection.run_query(
                sql_query,
                row_count=row_count,
                rfc=entry.rfc,
                adt=entry.adt,
                preferred=entry.backend,
            )

        data = get_registry().call_with(connection_id, _call)
        return _json(data)
    except Exception as exc:
        return _json({"error": str(exc)})


def main() -> None:
    transport = (os.environ.get("MCP_TRANSPORT", "streamable-http") or "streamable-http").strip()
    if transport not in ("stdio", "sse", "streamable-http"):
        transport = "streamable-http"
    if transport == "streamable-http":
        print(
            f"sap-pyrfc-mcp listening on http://{_HOST}:{_PORT}{_PATH} "
            f"(shared connection registry, max={os.environ.get('MAX_CONNECTIONS', '20')})",
            flush=True,
        )
    mcp.run(transport=transport)  # type: ignore[arg-type]

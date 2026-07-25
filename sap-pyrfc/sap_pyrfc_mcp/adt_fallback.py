"""ADT HTTPS fallback when PyRFC / NW RFC SDK is unavailable."""

from __future__ import annotations

import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

from sap_pyrfc_mcp.config import AdtConnectionConfig, is_adt_configured, load_adt_config

_CSRF_FETCH = "fetch"


class AdtClient:
    def __init__(self, config: AdtConnectionConfig | None = None) -> None:
        self.config = config or load_adt_config()
        self._csrf = _CSRF_FETCH
        self._cookies: dict[str, str] = {}

    def _build_opener(self) -> urllib.request.OpenerDirector:
        password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        password_mgr.add_password(None, self.config.url, self.config.user, self.config.password)
        handlers: list[Any] = [urllib.request.HTTPBasicAuthHandler(password_mgr)]
        if self.config.url.lower().startswith("https"):
            ctx = ssl.create_default_context()
            if not self.config.tls_verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=ctx))
        return urllib.request.build_opener(*handlers)

    def _base_query(self) -> dict[str, str]:
        qs: dict[str, str] = {}
        if self.config.client:
            qs["sap-client"] = self.config.client
        if self.config.language:
            qs["sap-language"] = self.config.language
        return qs

    def _url(self, path: str, extra_qs: dict[str, str] | None = None) -> str:
        base = self.config.url.rstrip("/")
        qs = self._base_query()
        if extra_qs:
            qs.update(extra_qs)
        query = urllib.parse.urlencode(qs)
        return f"{base}{path}?{query}" if query else f"{base}{path}"

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: str = "",
        extra_qs: dict[str, str] | None = None,
        accept: str = "application/*",
    ) -> tuple[int, dict[str, str], bytes]:
        url = self._url(path, extra_qs)
        if method != "GET" and self._csrf in ("", _CSRF_FETCH):
            self.login()
        if method != "GET" and self._csrf in ("", _CSRF_FETCH):
            raise RuntimeError("ADT CSRF token not obtained; login may have failed")

        headers = {
            "Accept": accept,
            "Cache-Control": "no-cache",
            "X-sap-adt-sessiontype": self.config.session_type,
            "User-Agent": "buildingai-sap-pyrfc-mcp/1.0",
            "x-csrf-token": self._csrf,
        }
        if self._cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self._cookies.items())

        req = urllib.request.Request(url, data=body.encode("utf-8") if body else None, method=method, headers=headers)
        opener = self._build_opener()
        try:
            with opener.open(req, timeout=self.config.timeout) as resp:
                response_headers = {k.lower(): v for k, v in resp.headers.items()}
                for raw in resp.headers.get_all("Set-Cookie") or []:
                    part = raw.split(";", 1)[0]
                    if "=" in part:
                        key, val = part.split("=", 1)
                        self._cookies[key.strip()] = val.strip()
                token = response_headers.get("x-csrf-token")
                if token and token != _CSRF_FETCH:
                    self._csrf = token
                return resp.status, response_headers, resp.read()
        except urllib.error.HTTPError as exc:
            headers = {k.lower(): v for k, v in exc.headers.items()} if exc.headers else {}
            token = headers.get("x-csrf-token")
            if token and token != _CSRF_FETCH:
                self._csrf = token
            return exc.code, headers, exc.read()

    def login(self) -> None:
        self._csrf = _CSRF_FETCH
        status, headers, _ = self._request("/sap/bc/adt/compatibility/graph", method="GET")
        if status >= 400:
            raise RuntimeError(f"ADT login failed: HTTP {status}")
        token = headers.get("x-csrf-token")
        if token and token != _CSRF_FETCH:
            self._csrf = token

    def ping(self) -> dict[str, Any]:
        self.login()
        return {"backend": "adt", "endpoint": "/sap/bc/adt/compatibility/graph", "status": "ok"}

    def read_table(
        self,
        table_name: str,
        fields: list[str] | None = None,
        where: str = "",
        row_count: int = 20,
    ) -> dict[str, Any]:
        self.login()
        sql = where.strip()
        if fields:
            cols = ", ".join(name.upper() for name in fields)
            sql = f"SELECT {cols} FROM {table_name.upper()}" + (f" WHERE {where}" if where else "")
        status, _, body = self._request(
            "/sap/bc/adt/datapreview/ddic",
            method="POST",
            body=sql,
            extra_qs={"rowNumber": str(max(1, min(row_count, 500))), "ddicEntityName": table_name.upper()},
        )
        if status >= 400:
            raise RuntimeError(f"ADT tableContents failed: HTTP {status} — {body[:300]!r}")
        return _parse_datapreview_xml(body, table_name.upper())

    def run_query(self, sql_query: str, row_count: int = 20) -> dict[str, Any]:
        self.login()
        status, _, body = self._request(
            "/sap/bc/adt/datapreview/freestyle",
            method="POST",
            body=sql_query,
            extra_qs={"rowNumber": str(max(1, min(row_count, 500)))},
        )
        if status >= 400:
            raise RuntimeError(f"ADT runQuery failed: HTTP {status} — {body[:300]!r}")
        return _parse_datapreview_xml(body, "QUERY")


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _attr(node: ET.Element, key: str) -> str:
    for attr_key, value in node.attrib.items():
        if _local(attr_key) == key:
            return value
    return ""


def _parse_datapreview_xml(body: bytes, label: str) -> dict[str, Any]:
    root = ET.fromstring(body)
    columns: list[str] = []
    column_meta: list[dict[str, Any]] = []
    field_values: list[list[str]] = []

    for node in root.iter():
        if _local(node.tag) != "columns":
            continue
        meta_node = next((child for child in node if _local(child.tag) == "metadata"), None)
        if meta_node is None:
            continue
        name = _attr(meta_node, "name")
        columns.append(name)
        column_meta.append(
            {
                "name": name,
                "type": _attr(meta_node, "type"),
                "description": _attr(meta_node, "description"),
            }
        )
        values = []
        for child in node:
            if _local(child.tag) == "dataSet":
                for data in child:
                    if _local(data.tag) == "data":
                        values.append(data.text or "")
        field_values.append(values)

    row_count = max((len(v) for v in field_values), default=0)
    rows: list[dict[str, str]] = []
    for i in range(row_count):
        row: dict[str, str] = {}
        for idx, name in enumerate(columns):
            if idx < len(field_values) and i < len(field_values[idx]):
                row[name] = field_values[idx][i]
        rows.append(row)

    return {
        "table": label,
        "backend": "adt",
        "row_count": len(rows),
        "columns": columns,
        "column_meta": column_meta,
        "rows": rows,
    }


def adt_available() -> bool:
    return is_adt_configured()


def adt_error_message() -> str:
    if is_adt_configured():
        return ""
    return (
        "ADT fallback is not configured. Set SAP_URL (HTTPS ADT endpoint), "
        "SAP_USER, SAP_PASSWORD, SAP_CLIENT — or copy from sibling sap-connect/sap-abap/.env"
    )

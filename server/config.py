"""Validated graph normalization and Nginx configuration generation."""

from __future__ import annotations

import ipaddress
import math
import re
from copy import deepcopy
from typing import Any


ID_RE = re.compile(r"^[\w-]{1,80}$", re.ASCII)
EDGE_ID_RE = re.compile(r"^[\w-]{1,100}$", re.ASCII)
PATH_RE = re.compile(r"^/[a-zA-Z0-9/_~.-]*$")
MARKER_RE = re.compile(r"^[a-zA-Z0-9_-]+$")
RESOLVER_RE = re.compile(r"^([0-9.]+)(\s+[0-9.]+)*$")


def empty_graph() -> dict[str, list[Any]]:
    return {"nodes": [], "edges": []}


def example_graph() -> dict[str, list[dict[str, Any]]]:
    return {
        "nodes": [
            {
                "id": "demo-domain",
                "type": "domain",
                "position": {"x": 60, "y": 150},
                "data": {
                    "label": "Demo website",
                    "domain": "demo.localhost",
                    "tls": "",
                    "forceHttps": False,
                },
            },
            {
                "id": "demo-rule",
                "type": "rule",
                "position": {"x": 410, "y": 150},
                "data": {"label": "All traffic", "path": "/", "websocket": True},
            },
            {
                "id": "demo-service",
                "type": "service",
                "position": {"x": 760, "y": 150},
                "data": {
                    "label": "Welcome app",
                    "host": "demo",
                    "port": 80,
                    "protocol": "http",
                },
            },
        ],
        "edges": [
            {"id": "demo-edge-1", "source": "demo-domain", "target": "demo-rule"},
            {"id": "demo-edge-2", "source": "demo-rule", "target": "demo-service"},
        ],
    }


def _hostname(value: Any) -> bool:
    if not isinstance(value, str) or len(value) > 253:
        return False
    label = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.I)
    return bool(value) and all(label.fullmatch(part) for part in value.split("."))


def valid_host(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return _hostname(value)


def _number(value: Any) -> float | int | None:
    if value is None:
        return 0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else number


def _position(value: Any) -> float | int:
    number = _number(value)
    if isinstance(number, (int, float)) and math.isfinite(number):
        return max(-10000, min(10000, number))
    return 0


def normalize_graph(source: Any) -> dict[str, list[dict[str, Any]]]:
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("nodes"), list)
        or not isinstance(source.get("edges"), list)
        or len(source["nodes"]) > 300
        or len(source["edges"]) > 600
    ):
        raise ValueError("Use a graph with at most 300 blocks and 600 connections.")

    ids: set[str] = set()
    nodes: list[dict[str, Any]] = []
    for node in source["nodes"]:
        node_id = node.get("id") if isinstance(node, dict) else None
        node_type = node.get("type") if isinstance(node, dict) else None
        if (
            not isinstance(node_id, str)
            or not ID_RE.fullmatch(node_id)
            or node_id in ids
            or node_type not in {"domain", "rule", "service"}
        ):
            raise ValueError("Each block needs a unique ID and a supported type.")
        ids.add(node_id)
        data = node.get("data")
        if not isinstance(data, dict):
            raise ValueError("Block settings are missing.")
        label = data.get("label")[:100] if isinstance(data.get("label"), str) else node_type
        if node_type == "domain":
            normalized_data = {
                "label": label,
                "domain": str(data.get("domain") or "").lower(),
                "tls": str(data.get("tls") or ""),
                "forceHttps": data.get("forceHttps") is True,
                "maxBodySizeMb": _number(data.get("maxBodySizeMb", 1)),
            }
        elif node_type == "rule":
            normalized_data = {
                "label": label,
                "path": str(data.get("path") if data.get("path") is not None else "/"),
                "websocket": data.get("websocket") is True,
            }
        else:
            normalized_data = {
                "label": label,
                "host": str(data.get("host") or ""),
                "hostHeader": str(data.get("hostHeader") or ""),
                "port": _number(data.get("port")),
                "protocol": "https" if data.get("protocol") == "https" else "http",
            }
        position = node.get("position") if isinstance(node.get("position"), dict) else {}
        nodes.append(
            {
                "id": node_id,
                "type": node_type,
                "position": {
                    "x": _position(position.get("x")),
                    "y": _position(position.get("y")),
                },
                "data": normalized_data,
            }
        )

    edge_ids: set[str] = set()
    pairs: set[str] = set()
    edges: list[dict[str, str]] = []
    for edge in source["edges"]:
        if not isinstance(edge, dict):
            raise ValueError("Connections must be unique and join existing blocks.")
        edge_id, source_id, target_id = edge.get("id"), edge.get("source"), edge.get("target")
        pair = f"{source_id}:{target_id}"
        if (
            not isinstance(edge_id, str)
            or not EDGE_ID_RE.fullmatch(edge_id)
            or edge_id in edge_ids
            or pair in pairs
            or source_id not in ids
            or target_id not in ids
        ):
            raise ValueError("Connections must be unique and join existing blocks.")
        edge_ids.add(edge_id)
        pairs.add(pair)
        edges.append({"id": edge_id, "source": source_id, "target": target_id})
    return {"nodes": nodes, "edges": edges}


def validate_graph(graph: dict[str, Any], certificates: list[str] | None = None) -> list[str]:
    certificates = certificates or []
    errors: list[str] = []
    domains: set[str] = set()
    incoming = lambda node_id: [edge for edge in graph["edges"] if edge["target"] == node_id]
    outgoing = lambda node_id: [edge for edge in graph["edges"] if edge["source"] == node_id]
    by_id = {node["id"]: node for node in graph["nodes"]}

    for edge in graph["edges"]:
        first, second = by_id.get(edge["source"]), by_id.get(edge["target"])
        if not first or not second or (first["type"], second["type"]) not in {
            ("domain", "rule"),
            ("rule", "service"),
        }:
            errors.append("Connect domain → path rule → service. Other connections are not supported.")

    for node in graph["nodes"]:
        data = node["data"]
        name = data.get("label") or node["type"]
        if node["type"] == "domain":
            domain = data["domain"]
            base = domain[2:] if domain.startswith("*.") else domain
            if not _hostname(base):
                errors.append(f"{name}: enter a valid domain without a protocol or path.")
            if domain in domains:
                errors.append(f"{name}: this domain already exists.")
            domains.add(domain)
            if domain in {"waypoint-internal.invalid", "*.invalid"}:
                errors.append(f"{name}: this domain is reserved for internal deployment checks.")
            if not outgoing(node["id"]):
                errors.append(f"{name}: connect at least one path rule.")
            tls = data["tls"]
            if tls and (not ID_RE.fullmatch(tls) or tls not in certificates):
                errors.append(f"{name}: choose an available certificate.")
            size = data.get("maxBodySizeMb", 1)
            if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 1024:
                errors.append(f"{name}: upload limit must be a whole number from 1 to 1024 MB.")
            if data["forceHttps"] and not tls:
                errors.append(f"{name}: HTTPS redirect requires a certificate.")
            paths: set[str] = set()
            for edge in outgoing(node["id"]):
                path = by_id.get(edge["target"], {}).get("data", {}).get("path")
                if path in paths:
                    errors.append(f"{name}: two rules use the same path.")
                paths.add(path)
        elif node["type"] == "rule":
            path = data["path"]
            if not PATH_RE.fullmatch(path) or ".." in path:
                errors.append(
                    f"{name}: use a path starting with / and containing only letters, numbers, /, _, ~, dots or hyphens."
                )
            if len(incoming(node["id"])) != 1:
                errors.append(f"{name}: connect exactly one domain.")
            if len(outgoing(node["id"])) != 1:
                errors.append(f"{name}: select exactly one destination service.")
        else:
            if not valid_host(data["host"]):
                errors.append(f"{name}: enter a valid IP address or hostname.")
            if data["hostHeader"] and not valid_host(data["hostHeader"]):
                errors.append(f"{name}: enter a valid upstream Host header.")
            port = data["port"]
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                errors.append(f"{name}: port must be between 1 and 65535.")
            if not incoming(node["id"]):
                errors.append(f"{name}: connect a path rule or remove this unused service.")
    return list(dict.fromkeys(errors))


def _quote(value: Any) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return f'"{escaped}"'


def compile_graph(
    graph: dict[str, Any],
    *,
    root: str,
    format: str = "standalone",
    certificate_root: str | None = None,
    http_port: int = 80,
    https_port: int = 443,
    public_https_port: int | None = None,
    resolver: str = "127.0.0.11",
    certificates: list[str] | None = None,
    ca_file: str = "/etc/ssl/certs/ca-certificates.crt",
    marker: str = "initial",
) -> str:
    certificates = certificates or []
    certificate_root = certificate_root or f"{root}/../certificates"
    public_https_port = https_port if public_https_port is None else public_https_port
    errors = validate_graph(graph, certificates)
    if errors:
        raise ValueError("\n".join(errors))
    if not MARKER_RE.fullmatch(marker):
        raise ValueError("Invalid deployment marker.")
    if not RESOLVER_RE.fullmatch(resolver):
        raise ValueError("NGINX_RESOLVER must contain IPv4 resolver addresses.")
    for port in (http_port, https_port, public_https_port):
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("Invalid Nginx listener port.")
    if format not in {"standalone", "include"}:
        raise ValueError("Invalid Nginx configuration format.")

    indent = "  " if format == "standalone" else ""
    lines = [
        "# Generated by Waypoint. Edit your visual workspace to change this file.",
        f"# Waypoint deployment: {marker}",
    ]
    if format == "standalone":
        lines += [
            "worker_processes auto;",
            f"pid {_quote(root + '/nginx.pid')};",
            f"error_log {_quote(root + '/error.log')} warn;",
            "events { worker_connections 1024; }",
            "http {",
            "  default_type application/octet-stream;",
            "  server_tokens off;",
            f"  client_body_temp_path {_quote(root + '/client_temp')};",
            f"  proxy_temp_path {_quote(root + '/proxy_temp')};",
        ]
    lines += [
        f"{indent}log_format waypoint_json escape=json '{{\"route_id\":\"$waypoint_route_id\",\"timestamp\":\"$time_iso8601\",\"method\":\"$request_method\",\"status\":$status,\"response_time\":$request_time,\"upstream\":\"$upstream_addr\"}}';",
        f'{indent}map $http_upgrade $waypoint_connection_upgrade {{ default upgrade; "" close; }}',
    ]
    if format == "standalone":
        lines += [
            "  server {",
            f"    listen {http_port} default_server;",
            "    server_name _;",
            '    set $waypoint_route_id "unmatched";',
            "    location / { return 404; }",
            "    location = /__waypoint_revision {",
            "      allow 127.0.0.1; deny all;",
            f'      return 200 "{marker}";',
            "    }",
            "  }",
        ]
    if format == "standalone" and any(
        node["type"] == "domain" and node["data"]["tls"] for node in graph["nodes"]
    ):
        lines += [
            "  server {",
            f"    listen {https_port} ssl default_server;",
            "    ssl_reject_handshake on;",
            "    return 404;",
            "  }",
        ]

    by_id = {node["id"]: node for node in graph["nodes"]}
    for domain in sorted((node for node in graph["nodes"] if node["type"] == "domain"), key=lambda n: n["id"]):
        data = domain["data"]
        if data["forceHttps"]:
            suffix = "" if public_https_port == 443 else f":{public_https_port}"
            lines += [
                "  server {",
                f"    listen {http_port};",
                f"    server_name {data['domain']};",
                f'    set $waypoint_route_id "{domain["id"]}";',
                f"    access_log {_quote(root + '/access.log')} waypoint_json;",
                f"    error_log {_quote(root + '/error.log')} warn;",
                f"    return 308 https://$host{suffix}$request_uri;",
                "  }",
            ]
        lines += [
            "  server {",
            *([] if data["forceHttps"] else [f"    listen {http_port};"]),
            f"    server_name {data['domain']};",
            f'    set $waypoint_route_id "{domain["id"]}";',
            f"    access_log {_quote(root + '/access.log')} waypoint_json;",
            f"    error_log {_quote(root + '/error.log')} warn;",
            f"    resolver {resolver} ipv6=off valid=30s;",
            "    resolver_timeout 5s;",
            f"    client_max_body_size {data.get('maxBodySizeMb', 1)}m;",
        ]
        if data["tls"]:
            lines += [
                f"    listen {https_port} ssl;",
                f"    ssl_certificate {_quote(certificate_root + '/' + data['tls'] + '/cert.pem')};",
                f"    ssl_certificate_key {_quote(certificate_root + '/' + data['tls'] + '/key.pem')};",
                "    ssl_protocols TLSv1.2 TLSv1.3;",
            ]
        domain_edges = sorted(
            (edge for edge in graph["edges"] if edge["source"] == domain["id"]),
            key=lambda edge: (by_id[edge["target"]]["data"]["path"], edge["target"]),
        )
        for edge in domain_edges:
            rule = by_id[edge["target"]]
            service_edge = next(item for item in graph["edges"] if item["source"] == rule["id"])
            service = by_id[service_edge["target"]]["data"]
            try:
                host = f"[{service['host']}]" if ipaddress.ip_address(service["host"]).version == 6 else service["host"]
            except ValueError:
                host = service["host"]
            lines += [
                f"    location ^~ {rule['data']['path']} {{",
                f'      set $waypoint_route_id "{rule["id"]}";',
                f"      set $destination {service['protocol']}://{host}:{service['port']};",
                "      proxy_pass $destination;",
                "      proxy_http_version 1.1;",
                f"      proxy_set_header Host {service['hostHeader'] or '$host'};",
                "      proxy_set_header X-Real-IP $remote_addr;",
                "      proxy_set_header X-Forwarded-For $remote_addr;",
                "      proxy_set_header X-Forwarded-Proto $scheme;",
                "      proxy_connect_timeout 10s;",
                "      proxy_read_timeout 60s;",
            ]
            if rule["data"]["websocket"]:
                lines += [
                    "      proxy_set_header Upgrade $http_upgrade;",
                    "      proxy_set_header Connection $waypoint_connection_upgrade;",
                ]
            else:
                lines.append('      proxy_set_header Connection "";')
            if service["protocol"] == "https":
                lines += [
                    "      proxy_ssl_server_name on;",
                    f"      proxy_ssl_name {service['host']};",
                    "      proxy_ssl_verify on;",
                    f"      proxy_ssl_trusted_certificate {_quote(ca_file)};",
                    "      proxy_ssl_verify_depth 4;",
                ]
            lines.append("    }")
        if not any(by_id[edge["target"]]["data"]["path"] == "/" for edge in domain_edges):
            lines.append("    location / { return 404; }")
        lines.append("  }")
    if format == "standalone":
        lines.append("}")
    lines.append("")
    return "\n".join(lines)


def clone_graph(graph: dict[str, Any]) -> dict[str, Any]:
    """Small public helper used by tests and integrations."""
    return deepcopy(graph)

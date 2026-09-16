"""Isolated Docker discovery and fixed-operation Nginx control agent."""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import socket
import struct
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse


MAX_RESPONSE = 4 * 1024 * 1024


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, timeout: float = 5.0):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def _unix_request_sync(
    socket_path: str,
    request_path: str,
    *,
    method: str = "GET",
    body: Any = None,
    timeout: float = 5.0,
) -> tuple[int, bytes]:
    connection = UnixHTTPConnection(socket_path, timeout)
    payload = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    try:
        connection.request(method, request_path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise RuntimeError("Response too large.")
        return response.status, data
    finally:
        connection.close()


async def request_json(
    socket_path: str,
    request_path: str,
    *,
    method: str = "GET",
    body: Any = None,
) -> Any:
    status, payload = await asyncio.to_thread(
        _unix_request_sync,
        socket_path,
        request_path,
        method=method,
        body=body,
    )
    try:
        value = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RuntimeError("Invalid JSON response.") from exc
    if status != 200:
        raise RuntimeError(value.get("error", "Docker discovery failed."))
    return value


def find_nginx_target(containers: list[dict[str, Any]], manager_id: str) -> dict[str, Any]:
    targets = [
        container
        for container in containers
        if container.get("State") == "running"
        and container.get("Labels", {}).get("waypoint.nginx-target") == manager_id
    ]
    if len(targets) != 1:
        raise RuntimeError(
            "Cannot identify one running Nginx target. Add a waypoint.nginx-target label matching this Waypoint instance."
        )
    return targets[0]


def merge_exposed_ports(container: dict[str, Any], inspected: dict[str, Any]) -> dict[str, Any]:
    ports: dict[str, dict[str, Any]] = {
        f"{port.get('PrivatePort')}/{port.get('Type')}": port
        for port in container.get("Ports", [])
    }
    for value in inspected.get("Config", {}).get("ExposedPorts", {}):
        parts = value.split("/", 1)
        if len(parts) != 2 or not parts[0].isdigit() or parts[1] not in {"tcp", "udp"}:
            continue
        port = {"PrivatePort": int(parts[0]), "Type": parts[1]}
        key = f"{port['PrivatePort']}/{port['Type']}"
        ports[key] = {**port, **ports.get(key, {})}
    return {**container, "Ports": list(ports.values())}


def discover_services(
    containers: list[dict[str, Any]],
    manager_id: str,
    target: str = "container",
) -> dict[str, Any]:
    if target not in {"container", "host"}:
        raise ValueError("DISCOVERY_TARGET must be container or host.")
    managers = [
        container
        for container in containers
        if container.get("State") == "running"
        and container.get("Labels", {}).get("waypoint.discovery") == manager_id
    ]
    if len(managers) != 1:
        raise RuntimeError(
            "Cannot identify one running Waypoint container. Check its waypoint.discovery label."
        )
    manager = managers[0]
    if target == "host":
        services: list[dict[str, Any]] = []
        seen: set[tuple[str, str, int]] = set()
        for container in containers:
            if container.get("State") != "running" or container.get("Id") == manager.get("Id"):
                continue
            if container.get("Labels", {}).get("waypoint.nginx-target") == manager_id:
                continue
            names = container.get("Names") or []
            name = names[0].removeprefix("/") if names else str(container.get("Id", ""))[:12]
            for port in container.get("Ports", []):
                public_port = port.get("PublicPort")
                if port.get("Type") != "tcp" or not isinstance(public_port, int):
                    continue
                address = port.get("IP") or "127.0.0.1"
                if address == "0.0.0.0":
                    address = "127.0.0.1"
                elif address == "::":
                    address = "::1"
                key = (name, address, public_port)
                if key in seen:
                    continue
                seen.add(key)
                services.append(
                    {
                        "id": f"{container.get('Id')}:host:{address}:{public_port}",
                        "name": name,
                        "host": address,
                        "port": public_port,
                        "networks": ["host-published"],
                    }
                )
        services.sort(key=lambda item: (item["name"].casefold(), item["port"], item["host"]))
        return {"networks": ["host-published"], "services": services}

    networks = [
        name
        for name in manager.get("NetworkSettings", {}).get("Networks", {})
        if name not in {"host", "none"}
    ]
    services: list[dict[str, Any]] = []
    for container in containers:
        if container.get("State") != "running" or container.get("Id") == manager.get("Id"):
            continue
        if container.get("Labels", {}).get("waypoint.nginx-target") == manager_id:
            continue
        container_networks = container.get("NetworkSettings", {}).get("Networks", {})
        shared = [network for network in networks if network in container_networks]
        if not shared:
            continue
        names = container.get("Names") or []
        name = names[0].removeprefix("/") if names else str(container.get("Id", ""))[:12]
        network = next((item for item in shared if item != "bridge"), shared[0])
        host = container_networks.get(network, {}).get("IPAddress") if network == "bridge" else name
        if not host:
            continue
        ports = sorted(
            {
                int(port["PrivatePort"])
                for port in container.get("Ports", [])
                if port.get("Type") == "tcp"
                and isinstance(port.get("PrivatePort"), int)
                and 1 <= port["PrivatePort"] <= 65535
            }
        )
        for port in ports or [None]:
            services.append(
                {
                    "id": f"{container.get('Id')}:{port if port is not None else 'unknown'}",
                    "name": name,
                    "host": host,
                    "port": port,
                    "networks": shared,
                }
            )
    services.sort(key=lambda item: (item["name"].casefold(), item["port"] or 0))
    return {"networks": networks, "services": services}


def _docker_output(buffer: bytes) -> str:
    chunks: list[bytes] = []
    offset = 0
    while offset + 8 <= len(buffer):
        length = struct.unpack(">I", buffer[offset + 4 : offset + 8])[0]
        if offset + 8 + length > len(buffer):
            return buffer.decode(errors="replace")
        chunks.append(buffer[offset + 8 : offset + 8 + length])
        offset += 8 + length
    return b"".join(chunks).decode(errors="replace") if offset == len(buffer) else buffer.decode(errors="replace")


async def _docker_request(
    socket_path: str,
    request_path: str,
    *,
    method: str = "GET",
    body: Any = None,
) -> bytes:
    status, payload = await asyncio.to_thread(
        _unix_request_sync,
        socket_path,
        request_path,
        method=method,
        body=body,
        timeout=15.0,
    )
    if not 200 <= status < 300:
        message = payload.decode(errors="replace")
        try:
            message = json.loads(message).get("message", message)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"Docker API {status}: {message}")
    return payload


async def _docker_exec(socket_path: str, container_id: str, command: list[str]) -> str:
    created = json.loads(
        await _docker_request(
            socket_path,
            f"/containers/{quote(container_id, safe='')}/exec",
            method="POST",
            body={"AttachStdout": True, "AttachStderr": True, "Cmd": command},
        )
    )
    if not created.get("Id"):
        raise RuntimeError("Docker did not create the Nginx command.")
    stream = await _docker_request(
        socket_path,
        f"/exec/{created['Id']}/start",
        method="POST",
        body={"Detach": False, "Tty": False},
    )
    inspected = json.loads(await _docker_request(socket_path, f"/exec/{created['Id']}/json"))
    output = _docker_output(stream)
    if inspected.get("ExitCode") != 0:
        raise RuntimeError(output.strip() or f"Nginx command exited {inspected.get('ExitCode')}.")
    return output


def create_discovery_app(
    *,
    docker_socket: str = "/var/run/docker.sock",
    manager_id: str = "waypoint",
    target: str = "container",
) -> FastAPI:
    if target not in {"container", "host"}:
        raise ValueError("DISCOVERY_TARGET must be container or host.")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    async def summaries() -> list[dict[str, Any]]:
        return json.loads(await _docker_request(docker_socket, "/containers/json"))

    @app.get("/services")
    async def services() -> dict[str, Any]:
        try:
            containers = []
            for container in await summaries():
                try:
                    inspected = json.loads(
                        await _docker_request(
                            docker_socket,
                            f"/containers/{quote(container['Id'], safe='')}/json",
                        )
                    )
                    containers.append(merge_exposed_ports(container, inspected))
                except Exception:
                    containers.append(container)
            return discover_services(containers, manager_id, target)
        except Exception as exc:
            raise HTTPException(503, f"Docker discovery unavailable: {exc}") from exc

    @app.post("/nginx/{action}")
    async def nginx_control(action: str) -> dict[str, str]:
        if action not in {"check", "reload", "reopen"}:
            raise HTTPException(404, "Not found.")
        try:
            target = find_nginx_target(await summaries(), manager_id)
            command = ["nginx", "-T"] if action == "check" else ["nginx", "-s", action]
            output = await _docker_exec(docker_socket, target["Id"], command)
            names = target.get("Names") or []
            return {
                "target": names[0].removeprefix("/") if names else target["Id"],
                "output": output,
            }
        except Exception as exc:
            raise HTTPException(503, f"Nginx control unavailable: {exc}") from exc

    @app.exception_handler(HTTPException)
    async def http_error(_request, exc: HTTPException) -> JSONResponse:
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    return app


app = create_discovery_app(
    docker_socket=os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock"),
    manager_id=os.environ.get("DISCOVERY_MANAGER_ID", "waypoint"),
    target=os.environ.get("DISCOVERY_TARGET", "container"),
)


def main() -> None:
    import uvicorn

    uds = os.environ.get("DISCOVERY_SOCKET", "/discovery/services.sock")
    os.makedirs(os.path.dirname(uds), exist_ok=True)
    try:
        os.unlink(uds)
    except FileNotFoundError:
        pass
    uvicorn.run(app, uds=uds, access_log=False)


if __name__ == "__main__":
    main()

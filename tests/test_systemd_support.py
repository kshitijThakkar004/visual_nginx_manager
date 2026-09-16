from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

from server.config import empty_graph
from server.discovery import discover_services
from server.index import Manager


def containers() -> list[dict]:
    return [
        {
            "Id": "manager",
            "Names": ["/waypoint"],
            "State": "running",
            "Labels": {"waypoint.discovery": "waypoint"},
            "NetworkSettings": {"Networks": {"proxy": {"IPAddress": "172.20.0.2"}}},
            "Ports": [],
        },
        {
            "Id": "application",
            "Names": ["/notes"],
            "State": "running",
            "Labels": {},
            "NetworkSettings": {"Networks": {"proxy": {"IPAddress": "172.20.0.3"}}},
            "Ports": [
                {"PrivatePort": 3000, "PublicPort": 13000, "IP": "0.0.0.0", "Type": "tcp"},
                {"PrivatePort": 3000, "PublicPort": 13000, "IP": "::", "Type": "tcp"},
                {"PrivatePort": 4000, "Type": "tcp"},
            ],
        },
    ]


def test_host_discovery_returns_only_host_published_ports() -> None:
    result = discover_services(containers(), "waypoint", "host")

    assert result["networks"] == ["host-published"]
    assert [(item["host"], item["port"]) for item in result["services"]] == [
        ("127.0.0.1", 13000),
        ("::1", 13000),
    ]


def test_container_discovery_contract_is_unchanged() -> None:
    result = discover_services(containers(), "waypoint")

    assert result["networks"] == ["proxy"]
    assert [(item["host"], item["port"]) for item in result["services"]] == [
        ("notes", 3000),
        ("notes", 4000),
    ]


def test_systemd_mode_generates_an_include_for_host_paths(tmp_path: Path) -> None:
    manager = Manager(
        data_dir=tmp_path,
        mode="systemd",
        shared_root="/var/lib/waypoint",
        control_socket="/run/waypoint/nginx.sock",
    )
    (tmp_path / "certificates").mkdir()

    generated = asyncio.run(manager.config(empty_graph(), "initial"))

    assert manager.uses_existing_nginx
    assert manager.active_file == tmp_path / "runtime" / "waypoint.conf"
    assert "events {" not in generated
    assert "# Waypoint deployment: initial" in generated
    assert "$waypoint_route_id" not in generated


def test_systemd_mode_uses_the_separate_control_socket(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def fake_request(socket: str, path: str, *, method: str = "GET", body=None):
        calls.append((socket, path, method))
        return {"output": "ok"}

    monkeypatch.setattr("server.index.request_json", fake_request)
    manager = Manager(
        data_dir=tmp_path,
        mode="systemd",
        discovery_socket="/discovery/services.sock",
        control_socket="/control/nginx.sock",
    )

    asyncio.run(manager.control_external("check"))

    assert calls == [("/control/nginx.sock", "/nginx/check", "POST")]


def test_rejects_unknown_discovery_target() -> None:
    with pytest.raises(ValueError, match="DISCOVERY_TARGET"):
        discover_services(containers(), "waypoint", "remote")


def test_systemd_bridge_exposes_only_fixed_commands(monkeypatch: pytest.MonkeyPatch) -> None:
    source = Path(__file__).parents[1] / "systemd" / "waypoint-systemd-control.py"
    spec = importlib.util.spec_from_file_location("waypoint_systemd_control", source)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    commands: list[list[str]] = []

    def fake_run(command: list[str]) -> str:
        commands.append(command)
        return "checked"

    monkeypatch.setattr(module, "run", fake_run)
    module.ControlHandler.nginx = "/usr/bin/nginx"
    module.ControlHandler.unit = "nginx.service"
    responses: list[tuple[int, dict[str, str]]] = []
    handler = object.__new__(module.ControlHandler)
    handler.respond = lambda status, value: responses.append((status, value))

    handler.path = "/nginx/reload"
    handler.do_POST()
    assert responses == [(200, {"target": "nginx.service", "output": "checked"})]
    assert commands == [
        ["/usr/bin/systemctl", "is-active", "--quiet", "nginx.service"],
        ["/usr/bin/nginx", "-t"],
        ["/usr/bin/systemctl", "reload", "nginx.service"],
    ]

    handler.path = "/nginx/restart"
    handler.do_POST()
    assert responses[-1] == (404, {"error": "Not found."})

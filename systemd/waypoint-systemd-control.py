#!/usr/bin/env python3
"""Root-side, fixed-operation bridge for a systemd-managed Nginx service."""

from __future__ import annotations

import argparse
import json
import os
import re
import socketserver
import subprocess
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import ClassVar


UNIT_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.service$")
MAX_OUTPUT = 4 * 1024 * 1024


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, timeout=20)
    output = (result.stdout + result.stderr)[:MAX_OUTPUT].decode(errors="replace")
    if result.returncode != 0:
        raise RuntimeError(output.strip() or f"Command exited {result.returncode}.")
    return output


class ControlHandler(BaseHTTPRequestHandler):
    nginx: ClassVar[str]
    unit: ClassVar[str]

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        action = self.path.removeprefix("/nginx/")
        if action not in {"check", "reload", "reopen"} or self.path != f"/nginx/{action}":
            self.respond(404, {"error": "Not found."})
            return
        try:
            run(["/usr/bin/systemctl", "is-active", "--quiet", self.unit])
            if action == "check":
                output = run([self.nginx, "-T"])
            elif action == "reload":
                run([self.nginx, "-t"])
                output = run(["/usr/bin/systemctl", "reload", self.unit])
            else:
                output = run(
                    [
                        "/usr/bin/systemctl",
                        "kill",
                        "--kill-whom=main",
                        "--signal=USR1",
                        self.unit,
                    ]
                )
            self.respond(200, {"target": self.unit, "output": output})
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            self.respond(503, {"error": f"Nginx control unavailable: {exc}"})

    def respond(self, status: int, value: dict[str, str]) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


class ControlServer(socketserver.UnixStreamServer):
    pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", default="/run/waypoint/nginx.sock")
    parser.add_argument("--nginx", default="/usr/sbin/nginx")
    parser.add_argument("--unit", default="nginx.service")
    args = parser.parse_args()

    if not os.path.isabs(args.nginx) or not Path(args.nginx).is_file():
        parser.error("--nginx must be an absolute path to the Nginx executable")
    if not UNIT_RE.fullmatch(args.unit):
        parser.error("--unit must be a valid .service unit name")
    socket_path = Path(args.socket)
    if not socket_path.is_absolute():
        parser.error("--socket must be an absolute path")
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)

    ControlHandler.nginx = args.nginx
    ControlHandler.unit = args.unit
    try:
        with ControlServer(str(socket_path), ControlHandler) as server:
            socket_path.chmod(0o600)
            server.serve_forever()
    finally:
        socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

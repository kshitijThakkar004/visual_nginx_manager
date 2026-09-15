"""FastAPI manager with the original Waypoint API and state-file contract."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import subprocess
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import http.client
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from .config import compile_graph, empty_graph, example_graph, normalize_graph, validate_graph
from .discovery import request_json
from .traffic import TrafficTailer


LOG = logging.getLogger("waypoint")
HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
}
WORKSPACE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
CONFIG_MARKER = re.compile(r"(?m)^# Waypoint deployment: [\w-]+$")


def configuration_body(text: str) -> str:
    """Deployment markers are operational metadata, not a routing change."""
    match = CONFIG_MARKER.search(text)
    if not match:
        return text
    marker = match.group().split(": ", 1)[1]
    text = CONFIG_MARKER.sub("# Waypoint deployment: revision", text, count=1)
    return text.replace(f'return 200 "{marker}";', 'return 200 "revision";')


def _atomic_write(file: Path, content: str, mode: int = 0o600) -> None:
    temp = file.with_name(file.name + "." + secrets.token_hex(6) + ".tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
    finally:
        if temp.exists():
            temp.unlink()


def _hash_password(password: str, salt: str) -> str:
    # Identical parameters to Node's scryptSync(password, salt, 64).
    return hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()


class Manager:
    def __init__(
        self,
        *,
        data_dir: str | Path = "./data",
        static_dir: str | Path = "./dist",
        mode: str | None = None,
        nginx: str = "nginx",
        http_port: int = 8080,
        https_port: int = 8443,
        resolver: str = "127.0.0.11",
        discovery_socket: str = "/discovery/services.sock",
        shared_root: str = "/etc/nginx/waypoint",
        initial_workspace: str | Path | None = None,
        manage_nginx: bool | None = None,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.root = self.data_dir / "runtime"
        self.static_dir = Path(static_dir).resolve()
        self.nginx = nginx
        self.http_port = int(http_port)
        self.https_port = int(https_port)
        self.resolver = resolver
        self.mode = mode or ("preview" if manage_nginx is False else "standalone")
        if self.mode not in {"preview", "standalone", "external"}:
            raise ValueError("NGINX_MODE must be standalone, external, or preview.")
        self.discovery_socket = discovery_socket
        self.shared_root = shared_root
        self.initial_workspace = initial_workspace
        self.state_file = self.data_dir / "state.json"
        self.active_file = self.root / ("waypoint.conf" if self.mode == "external" else "nginx.conf")
        self.lock = asyncio.Lock()
        self.sessions: dict[str, float] = {}
        self.failures: dict[str, tuple[int, float]] = {}
        self.nginx_failed = False
        self.process: subprocess.Popen | None = None
        self.rotation_task: asyncio.Task | None = None
        self.traffic = TrafficTailer(self.root / "access.log")
        self.state: dict[str, Any] = {}

    def workspace(self) -> dict[str, Any]:
        return self.state["workspaces"][self.state["workspaceId"]]

    def select_state(self, state: dict[str, Any]) -> dict[str, Any]:
        workspace = state["workspaces"][state["workspaceId"]]
        return {**state, **{key: workspace[key] for key in ("draft", "applied", "history", "configDraft")}}

    def update_workspace(self, **values: Any) -> dict[str, Any]:
        workspace_id = self.state["workspaceId"]
        workspaces = {**self.state["workspaces"], workspace_id: {**self.workspace(), **values}}
        return self.select_state({**self.state, "workspaces": workspaces})

    async def write_workspace_files(self) -> None:
        directory = self.data_dir / "workspaces"
        directory.mkdir(exist_ok=True)
        for workspace_id, workspace in self.state["workspaces"].items():
            folder = directory / workspace_id
            folder.mkdir(exist_ok=True)
            try:
                draft_config = workspace["configDraft"] or await self.config(workspace["draft"])
            except HTTPException:
                draft_config = "# Complete the visual routes before generating a configuration.\n"
            await asyncio.to_thread(_atomic_write, folder / "draft.conf", draft_config)
            if workspace["applied"]:
                await asyncio.to_thread(_atomic_write, folder / "deployed.conf", workspace["applied"]["config"])

    def rendered_config(self, generated: str, override: Any, marker: str) -> str:
        if override is None:
            return generated
        if not isinstance(override, str) or len(override.encode("utf-8")) > 512000 or "\x00" in override:
            raise HTTPException(400, "Configuration text must be under 500 KB and contain no NUL bytes.")
        matches = CONFIG_MARKER.findall(override)
        if len(matches) != 1:
            raise HTTPException(400, "Keep exactly one Waypoint deployment marker in the configuration.")
        original_marker = matches[0].split(": ", 1)[1]
        text = CONFIG_MARKER.sub(f"# Waypoint deployment: {marker}", override, count=1)
        return text.replace(f'return 200 "{original_marker}";', f'return 200 "{marker}";')

    async def start(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "logs").mkdir(exist_ok=True)
        (self.data_dir / "certificates").mkdir(parents=True, exist_ok=True)
        if self.state_file.exists():
            self.state = json.loads(self.state_file.read_text(encoding="utf-8"))
        else:
            if self.initial_workspace:
                graph = normalize_graph(json.loads(Path(self.initial_workspace).read_text(encoding="utf-8")))
            else:
                graph = empty_graph() if self.mode == "external" else example_graph()
            self.state = {"revision": 0, "draft": graph, "applied": None, "history": [], "auth": None}
        if "workspaces" not in self.state:
            self.state.update(
                workspaceId="default",
                liveWorkspaceId="default" if self.state.get("applied") else None,
                workspaces={"default": {
                    "name": "My infrastructure", "draft": normalize_graph(self.state["draft"]),
                    "applied": self.state.get("applied"), "history": self.state.get("history", []),
                    "configDraft": None,
                }},
                configDraft=None,
            )
        self.state = self.select_state(self.state)
        password = os.environ.get("ADMIN_PASSWORD")
        if not self.state.get("auth") and password:
            if len(password) < 12:
                raise ValueError("ADMIN_PASSWORD must be at least 12 characters.")
            salt = secrets.token_hex(16)
            self.state["auth"] = {"salt": salt, "hash": _hash_password(password, salt)}
        await self.persist(self.state)
        await self.write_workspace_files()
        live_id = self.state.get("liveWorkspaceId")
        live = self.state["workspaces"].get(live_id, {}).get("applied") if live_id else None
        marker = live["id"] if live else "initial"
        await self.write_active(live["config"] if live else await self.config(empty_graph(), marker))
        if self.mode == "standalone":
            await self.run_nginx(["-t"])
            self.process = subprocess.Popen(
                [self.nginx, "-p", str(self.root) + "/", "-c", str(self.active_file), "-g", "daemon off;"],
                stdin=subprocess.DEVNULL,
            )
            try:
                await self.confirm(marker)
            except Exception:
                self.process.terminate()
                raise
        elif self.mode == "external":
            try:
                await self.assert_external(marker)
                await self.control_external("reload")
            except Exception as exc:
                self.nginx_failed = True
                LOG.error("External Nginx is not ready: %s", exc)
        self.rotation_task = asyncio.create_task(self.rotate_logs())

    async def close(self) -> None:
        if self.rotation_task:
            self.rotation_task.cancel()
            try:
                await self.rotation_task
            except asyncio.CancelledError:
                pass
        if self.process and self.process.poll() is None:
            try:
                await self.run_nginx(["-s", "quit"])
                await asyncio.wait_for(asyncio.to_thread(self.process.wait), 3)
            except Exception:
                self.process.terminate()
                await asyncio.to_thread(self.process.wait)

    def public_state(self) -> dict[str, Any]:
        running = self.mode != "preview" and not self.nginx_failed
        if self.mode == "standalone" and self.process and self.process.poll() is not None:
            running = False
            self.nginx_failed = True
        live_id = self.state.get("liveWorkspaceId")
        live = self.state["workspaces"].get(live_id, {}).get("applied") if live_id else None
        return {
            "revision": self.state["revision"],
            "draft": self.state["draft"],
            "applied": self.state["applied"],
            "history": self.state["history"],
            "configDraft": self.state["configDraft"],
            "workspaceId": self.state["workspaceId"],
            "liveWorkspaceId": self.state.get("liveWorkspaceId"),
            "workspaces": [
                {"id": key, "name": value["name"]} for key, value in self.state["workspaces"].items()
            ],
            "liveConfig": live["config"] if live else None,
            "liveGraph": live["graph"] if live else empty_graph(),
            "liveOverride": live.get("configOverride") if live else None,
            "mode": self.mode,
            "nginxRunning": running,
            "ports": {"http": self.http_port, "https": self.https_port},
        }

    def certificates(self) -> list[str]:
        return [
            item.name
            for item in (self.data_dir / "certificates").iterdir()
            if item.is_dir() and re.fullmatch(r"[\w-]{1,80}", item.name, re.ASCII)
        ]

    async def config(self, graph: dict[str, Any], marker: str = "preview") -> str:
        try:
            external = self.mode == "external"
            return compile_graph(
                graph,
                root=self.shared_root + "/runtime" if external else str(self.root),
                format="include" if external else "standalone",
                certificate_root=(self.shared_root + "/certificates" if external else str(self.data_dir / "certificates")),
                http_port=self.http_port,
                https_port=self.https_port,
                public_https_port=int(os.environ.get("PUBLIC_HTTPS_PORT", self.https_port)),
                resolver=self.resolver,
                certificates=self.certificates(),
                marker=marker,
                ca_file=os.environ.get("NGINX_CA_FILE", "/etc/ssl/certs/ca-certificates.crt"),
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    async def persist(self, next_state: dict[str, Any]) -> None:
        await asyncio.to_thread(_atomic_write, self.state_file, json.dumps(next_state, separators=(",", ":")))
        self.state = next_state

    async def write_active(self, text: str) -> None:
        await asyncio.to_thread(_atomic_write, self.active_file, text, 0o644)

    async def run_nginx(self, args: list[str]) -> str:
        def invoke() -> str:
            result = subprocess.run(
                [self.nginx, "-p", str(self.root) + "/", "-c", str(self.active_file), *args],
                capture_output=True,
                text=True,
                timeout=15,
                check=True,
            )
            return result.stderr

        return await asyncio.to_thread(invoke)

    async def control_external(self, action: str) -> dict[str, Any]:
        return await request_json(self.discovery_socket, f"/nginx/{action}", method="POST")

    async def assert_external(self, marker: str) -> str:
        result = await self.control_external("check")
        output = result["output"]
        if f"# Waypoint deployment: {marker}" not in output:
            raise RuntimeError(f"The target Nginx does not include {self.shared_root}/runtime/waypoint.conf.")
        active = self.active_file.read_text(encoding="utf-8")
        domains = set(re.findall(r"^\s*server_name\s+([^;\s]+);", active, re.M))
        conflicts = re.findall(r'conflicting server name "([^"]+)"', output, re.I)
        if any(domain in domains for domain in conflicts):
            raise RuntimeError(
                "The target Nginx already defines one of these domains. Existing routes were left unchanged; remove only the overlapping server block before deploying it through Waypoint."
            )
        self.nginx_failed = False
        return output

    async def check(self, text: str) -> str:
        if self.mode == "preview":
            return "Preview mode: Nginx is not running. Only graph validation is available."
        if self.mode == "external":
            previous = self.active_file.read_text(encoding="utf-8")
            match = re.search(r"^# Waypoint deployment: ([\w-]+)$", text, re.M)
            try:
                await self.write_active(text)
                return await self.assert_external(match.group(1) if match else "")
            except Exception as exc:
                raise HTTPException(400, f"Nginx rejected this configuration:\n{exc}") from exc
            finally:
                await self.write_active(previous)
        candidate = self.root / ("candidate-" + secrets.token_hex(6) + ".conf")
        try:
            await asyncio.to_thread(_atomic_write, candidate, text)
            result = await asyncio.to_thread(
                subprocess.run,
                [self.nginx, "-t", "-p", str(self.root) + "/", "-c", str(candidate)],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr or "Nginx validation failed.")
            return result.stderr
        except Exception as exc:
            raise HTTPException(400, f"Nginx rejected this configuration:\n{exc}") from exc
        finally:
            candidate.unlink(missing_ok=True)

    async def confirm(self, marker: str) -> None:
        def probe() -> str:
            connection = http.client.HTTPConnection("127.0.0.1", self.http_port, timeout=0.5)
            try:
                connection.request(
                    "GET",
                    "/__waypoint_revision",
                    headers={"Host": "waypoint-internal.invalid", "Connection": "close"},
                )
                return connection.getresponse().read().decode()
            finally:
                connection.close()

        for _ in range(40):
            try:
                if await asyncio.to_thread(probe) == marker:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.1)
        raise RuntimeError("Nginx did not acknowledge the new configuration.")

    async def apply(self, graph: dict[str, Any], override: str | None = None) -> dict[str, Any]:
        if self.mode == "preview":
            raise HTTPException(400, "Deploy requires the Docker runtime. This server is in preview mode.")
        marker = "r-" + secrets.token_hex(8)
        text = self.rendered_config(await self.config(graph, marker), override, marker)
        live_id = self.state.get("liveWorkspaceId")
        live = self.state["workspaces"].get(live_id, {}).get("applied") if live_id else None
        if live and configuration_body(live["config"]) == configuration_body(text):
            raise HTTPException(400, "There are no configuration changes to deploy.")
        await self.check(text)
        previous = self.active_file.read_text(encoding="utf-8")
        try:
            await self.write_active(text)
            if self.mode == "external":
                await self.assert_external(marker)
                await self.control_external("reload")
            else:
                if self.nginx_failed or not self.process or self.process.poll() is not None:
                    raise RuntimeError("Nginx is not running. Restart the container before deploying.")
                await self.run_nginx(["-s", "reload"])
                await self.confirm(marker)
            self.nginx_failed = False
            applied = {
                "id": marker,
                "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "graph": graph,
                "config": text,
                "configOverride": override,
            }
            await self.persist(
                {**self.update_workspace(
                    draft=graph, configDraft=override, applied=applied,
                    history=([self.state["applied"]] if self.state["applied"] else []) + self.state["history"][:9],
                ), "revision": self.state["revision"] + 1,
                 "liveWorkspaceId": self.state["workspaceId"]}
            )
            try:
                await self.write_workspace_files()
            except Exception:
                LOG.exception("Deployment committed, but workspace configuration copy could not be updated")
        except Exception as exc:
            await self.write_active(previous)
            try:
                old_marker = live["id"] if live else "initial"
                if self.mode == "external":
                    await self.assert_external(old_marker)
                    await self.control_external("reload")
                else:
                    await self.run_nginx(["-s", "reload"])
                    await self.confirm(old_marker)
            except Exception as restore_exc:
                self.nginx_failed = True
                raise HTTPException(
                    500,
                    "Deployment failed and recovery could not be confirmed. Check the target Nginx and restore the saved configuration. "
                    + str(restore_exc),
                ) from exc
            raise HTTPException(500, "Deployment failed. The previous configuration was restored. " + str(exc)) from exc
        return self.public_state()

    def revision_check(self, body: dict[str, Any]) -> None:
        if body.get("revision") != self.state["revision"]:
            raise HTTPException(409, "This workspace changed in another tab. Reload before saving.")

    async def rotate_logs(self) -> None:
        while True:
            await asyncio.sleep(30)
            if self.mode == "preview" or self.nginx_failed:
                continue
            try:
                async with self.lock:
                    rotated = False
                    for name in ("access.log", "error.log"):
                        file = self.root / name
                        if file.exists() and file.stat().st_size > 10 * 1024 * 1024:
                            file.replace(file.with_name(name + ".1"))
                            rotated = True
                    if rotated:
                        if self.mode == "external":
                            await self.control_external("reopen")
                        else:
                            await self.run_nginx(["-s", "reopen"])
            except Exception:
                LOG.exception("Log rotation failed")


def create_app(**options: Any) -> FastAPI:
    manager = Manager(**options)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await manager.start()
        yield
        await manager.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.manager = manager

    @app.middleware("http")
    async def security(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method != "GET":
            origin = request.headers.get("origin")
            host = request.headers.get("host", "")
            allowed = {os.environ.get("PUBLIC_ORIGIN", f"http://{host}"), f"https://{host}"}
            if origin and origin not in allowed:
                response = JSONResponse({"error": "Request origin is not allowed."}, status_code=403)
            elif request.headers.get("sec-fetch-site") == "cross-site":
                response = JSONResponse({"error": "Cross-site requests are not allowed."}, status_code=403)
            else:
                response = await call_next(request)
        else:
            response = await call_next(request)
        for name, value in HEADERS.items():
            response.headers[name] = value
        return response

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers={"Cache-Control": "no-store"})

    @app.exception_handler(Exception)
    async def unexpected(_request: Request, exc: Exception):
        LOG.exception("Unhandled manager error", exc_info=exc)
        return JSONResponse({"error": "Server error. Check container logs."}, status_code=500, headers={"Cache-Control": "no-store"})

    async def body_of(request: Request) -> dict[str, Any]:
        if not request.headers.get("content-type", "").startswith("application/json"):
            raise HTTPException(415, "Use application/json.")
        payload = await request.body()
        if len(payload) > 1024 * 1024:
            raise HTTPException(413, "Request exceeds 1 MB.")
        try:
            value = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(400, "Invalid JSON.") from exc
        if not isinstance(value, dict):
            raise HTTPException(400, "Invalid JSON.")
        return value

    def normalize(value: Any) -> dict[str, Any]:
        try:
            return normalize_graph(value)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    def auth(request: Request) -> str:
        token = request.cookies.get("waypoint_session", "")
        if not token or manager.sessions.get(token, 0) <= time.time():
            raise HTTPException(401, "Sign in to continue.")
        return token

    def no_store(value: Any, status: int = 200) -> JSONResponse:
        return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})

    @app.get("/api/health")
    async def health():
        if manager.mode == "external":
            try:
                live_id = manager.state.get("liveWorkspaceId")
                live = manager.state["workspaces"].get(live_id, {}).get("applied") if live_id else None
                marker = live["id"] if live else "initial"
                await manager.assert_external(marker)
            except Exception:
                manager.nginx_failed = True
        state = manager.public_state()
        return no_store({"ok": state["nginxRunning"] or manager.mode == "preview"}, 503 if manager.nginx_failed else 200)

    @app.get("/api/session")
    async def session(request: Request):
        token = request.cookies.get("waypoint_session", "")
        return no_store({"authenticated": manager.sessions.get(token, 0) > time.time(), "needsSetup": not manager.state.get("auth")})

    @app.post("/api/login")
    async def login(request: Request):
        body = await body_of(request)
        async with manager.lock:
            ip = request.client.host if request.client else "unknown"
            now = time.time()
            manager.failures = {key: value for key, value in manager.failures.items() if value[1] >= now}
            count, until = manager.failures.get(ip, (0, now + 600))
            if count >= 10:
                raise HTTPException(429, "Too many attempts. Try again in 10 minutes.")
            password = body.get("password")
            if not isinstance(password, str) or len(password) > 1024:
                raise HTTPException(400, "Enter a valid password.")
            if not manager.state.get("auth"):
                if len(password) < 12:
                    raise HTTPException(400, "Choose a password with at least 12 characters.")
                salt = secrets.token_hex(16)
                await manager.persist({**manager.state, "auth": {"salt": salt, "hash": _hash_password(password, salt)}})
            else:
                stored = manager.state["auth"]
                if not hmac.compare_digest(stored["hash"], _hash_password(password, stored["salt"])):
                    manager.failures[ip] = (count + 1, until)
                    raise HTTPException(401, "Incorrect password.")
            manager.failures.pop(ip, None)
            manager.sessions = {key: expiry for key, expiry in manager.sessions.items() if expiry >= now}
            if len(manager.sessions) >= 100:
                manager.sessions.pop(next(iter(manager.sessions)))
            token = secrets.token_hex(32)
            manager.sessions[token] = now + 43200
            response = no_store({"ok": True})
            response.set_cookie(
                "waypoint_session",
                token,
                httponly=True,
                samesite="strict",
                secure=os.environ.get("COOKIE_SECURE") == "true",
                max_age=43200,
                path="/",
            )
            return response

    @app.post("/api/logout")
    async def logout(request: Request):
        manager.sessions.pop(auth(request), None)
        response = no_store({"ok": True})
        response.delete_cookie("waypoint_session", path="/")
        return response

    @app.get("/api/discovery")
    async def discovery(request: Request):
        auth(request)
        try:
            return no_store(await request_json(manager.discovery_socket, "/services"))
        except Exception as exc:
            raise HTTPException(
                503,
                "Service scan unavailable. Start the Docker discovery service and check its socket mount. " + str(exc),
            ) from exc

    @app.get("/api/state")
    async def state(request: Request):
        auth(request)
        return no_store({**manager.public_state(), "certificates": manager.certificates()})

    @app.get("/api/traffic")
    async def traffic(request: Request):
        auth(request)

        async def events():
            yield "event: ready\ndata: " + json.dumps(
                {"source": "waypoint", "connectedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
            ) + "\n\n"
            async for value in manager.traffic.stream():
                yield value

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/logs")
    async def logs(request: Request):
        auth(request)

        def tail(name: str) -> str:
            try:
                with (manager.root / name).open("rb") as stream:
                    stream.seek(0, 2)
                    stream.seek(max(0, stream.tell() - 16000))
                    return stream.read().decode(errors="replace")
            except FileNotFoundError:
                return ""

        return no_store({"access": tail("access.log"), "error": tail("error.log")})

    @app.post("/api/preview")
    async def preview(request: Request):
        auth(request)
        body = await body_of(request)
        graph = normalize(body.get("graph"))
        errors = validate_graph(graph, manager.certificates())
        override = body.get("config")
        if errors:
            return no_store({"graph": graph, "errors": errors, "config": ""})
        text = manager.rendered_config(await manager.config(graph), override, "preview")
        return no_store({"graph": graph, "errors": [], "config": text})

    @app.post("/api/validate")
    async def validate(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            graph = normalize(body.get("graph"))
            text = manager.rendered_config(await manager.config(graph), body.get("config"), "preview")
            return no_store({"output": await manager.check(text), "mode": manager.mode})

    @app.put("/api/draft")
    async def draft(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            manager.revision_check(body)
            graph = normalize(body.get("graph"))
            config = body.get("config")
            if config is not None:
                manager.rendered_config(await manager.config(graph), config, "preview")
            await manager.persist({**manager.update_workspace(draft=graph, configDraft=config), "revision": manager.state["revision"] + 1})
            await manager.write_workspace_files()
            return no_store(manager.public_state())

    @app.post("/api/apply")
    async def apply(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            manager.revision_check(body)
            return no_store(await manager.apply(normalize(body.get("graph")), body.get("config")))

    @app.post("/api/rollback")
    async def rollback(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            manager.revision_check(body)
            target = next((item for item in manager.state["history"] if item["id"] == body.get("id")), None)
            if not target:
                raise HTTPException(404, "Saved version not found.")
            return no_store(await manager.apply(target["graph"], target.get("configOverride")))

    @app.post("/api/workspaces")
    async def create_workspace(request: Request):
        auth(request)
        body = await body_of(request)
        name = body.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise HTTPException(400, "Enter a workspace name of 1–80 characters.")
        async with manager.lock:
            manager.revision_check(body)
            if len(manager.state["workspaces"]) >= 50:
                raise HTTPException(400, "The workspace limit is 50.")
            workspace_id = "ws-" + secrets.token_hex(8)
            workspaces = {**manager.state["workspaces"], workspace_id: {
                "name": name.strip(), "draft": empty_graph(), "applied": None,
                "history": [], "configDraft": None,
            }}
            await manager.persist(manager.select_state({**manager.state, "workspaces": workspaces,
                                                       "workspaceId": workspace_id, "revision": manager.state["revision"] + 1}))
            await manager.write_workspace_files()
            return no_store(manager.public_state())

    @app.put("/api/workspaces/select")
    async def select_workspace(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            manager.revision_check(body)
            workspace_id = body.get("id")
            if workspace_id not in manager.state["workspaces"]:
                raise HTTPException(404, "Workspace not found.")
            await manager.persist(manager.select_state({**manager.state, "workspaceId": workspace_id,
                                                       "revision": manager.state["revision"] + 1}))
            return no_store(manager.public_state())

    @app.put("/api/workspaces/rename")
    async def rename_workspace(request: Request):
        auth(request)
        body = await body_of(request)
        name = body.get("name")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise HTTPException(400, "Enter a workspace name of 1–80 characters.")
        async with manager.lock:
            manager.revision_check(body)
            await manager.persist({**manager.update_workspace(name=name.strip()), "revision": manager.state["revision"] + 1})
            return no_store(manager.public_state())

    @app.delete("/api/workspaces")
    async def delete_workspace(request: Request):
        auth(request)
        body = await body_of(request)
        async with manager.lock:
            manager.revision_check(body)
            workspace_id = manager.state["workspaceId"]
            if len(manager.state["workspaces"]) == 1 or workspace_id == manager.state.get("liveWorkspaceId"):
                raise HTTPException(400, "Keep the last workspace and the currently deployed workspace.")
            workspaces = {key: value for key, value in manager.state["workspaces"].items() if key != workspace_id}
            await manager.persist(manager.select_state({**manager.state, "workspaces": workspaces,
                "workspaceId": next(iter(workspaces)), "revision": manager.state["revision"] + 1}))
            # Saved files are retained so deletion is recoverable from a backup.
            return no_store(manager.public_state())

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"])
    async def unknown_api(rest: str):
        raise HTTPException(404, "API route not found.")

    @app.api_route("/{file_path:path}", methods=["GET", "HEAD"])
    async def static(file_path: str, request: Request):
        if "\x00" in file_path:
            raise HTTPException(400, "Invalid path.")
        target = (manager.static_dir / file_path).resolve()
        if not target.is_relative_to(manager.static_dir):
            raise HTTPException(403, "Invalid path.")
        if not target.is_file():
            if Path(file_path).suffix:
                raise HTTPException(404, "File not found.")
            target = manager.static_dir / "index.html"
        if not target.is_file():
            raise HTTPException(404, "File not found.")
        response = FileResponse(target)
        response.headers["Cache-Control"] = "no-cache" if target.suffix == ".html" else "public, max-age=3600"
        return response

    return app


app = create_app(
    data_dir=os.environ.get("DATA_DIR", "./data"),
    static_dir=os.environ.get("STATIC_DIR", "./dist"),
    mode=os.environ.get("NGINX_MODE") or ("preview" if os.environ.get("MANAGE_NGINX") == "false" else "standalone"),
    nginx=os.environ.get("NGINX_BIN", "nginx"),
    http_port=int(os.environ.get("PROXY_HTTP_PORT", "8080")),
    https_port=int(os.environ.get("PROXY_HTTPS_PORT", "8443")),
    resolver=os.environ.get("NGINX_RESOLVER", "127.0.0.11"),
    discovery_socket=os.environ.get("DISCOVERY_SOCKET", "/discovery/services.sock"),
    shared_root=os.environ.get("NGINX_SHARED_ROOT", "/etc/nginx/waypoint"),
    initial_workspace=os.environ.get("INITIAL_WORKSPACE"),
)


def main() -> None:
    import uvicorn

    uvicorn.run("server.index:app", host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "3001")), workers=1)


if __name__ == "__main__":
    main()

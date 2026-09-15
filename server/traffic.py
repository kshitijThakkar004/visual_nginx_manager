"""Safe, bounded access-log completion events for authenticated SSE clients."""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator


MAX_LINE = 16 * 1024
ROUTE_RE = re.compile(r"^[\w-]{1,100}$", re.ASCII)
METHOD_RE = re.compile(r"^[A-Z]{1,12}$")


def parse_traffic_line(line: str) -> dict[str, Any] | None:
    if not isinstance(line, str) or len(line) > MAX_LINE:
        return None
    try:
        value = json.loads(line)
        if not isinstance(value, dict):
            return None
        route_id, method = value.get("route_id"), value.get("method")
        if not isinstance(route_id, str) or not ROUTE_RE.fullmatch(route_id):
            return None
        if not isinstance(value.get("timestamp"), str):
            return None
        if not isinstance(method, str) or not METHOD_RE.fullmatch(method):
            return None
        if isinstance(value.get("status"), bool) or isinstance(value.get("response_time"), bool):
            return None
        status = float(value.get("status"))
        response_time = float(value.get("response_time"))
        if not math.isfinite(status) or not status.is_integer() or not math.isfinite(response_time):
            return None
        if not isinstance(value.get("upstream"), str):
            return None
        return {
            "routeId": route_id,
            "timestamp": value["timestamp"],
            "method": method,
            "status": int(status),
            "responseTime": response_time,
            "upstream": value["upstream"][:200],
        }
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


class TrafficTailer:
    def __init__(self, file: Path, *, poll_ms: int = 200, batch_ms: int = 250, max_batch: int = 100):
        self.file = Path(file)
        self.poll_ms = poll_ms
        self.batch_ms = batch_ms
        self.max_batch = max_batch
        self.identity: tuple[int, int] | None = None
        self.offset = 0
        self.partial = b""

    def poll(self, *, initial: bool = False) -> list[dict[str, Any]]:
        try:
            stat = self.file.stat()
        except FileNotFoundError:
            self.identity = None
            self.offset = 0
            self.partial = b""
            return []
        identity = (stat.st_dev, stat.st_ino)
        if initial and self.identity is None:
            self.identity, self.offset = identity, stat.st_size
            return []
        if self.identity != identity or stat.st_size < self.offset:
            self.identity, self.offset, self.partial = identity, 0, b""
        if stat.st_size <= self.offset:
            return []
        with self.file.open("rb") as stream:
            stream.seek(self.offset)
            payload = stream.read(min(stat.st_size - self.offset, 1024 * 1024))
        self.offset += len(payload)
        parts = (self.partial + payload).split(b"\n")
        self.partial = parts.pop()
        if len(self.partial) > MAX_LINE:
            self.partial = b""
        events = (parse_traffic_line(part.decode(errors="replace").strip()) for part in parts)
        return [event for event in events if event is not None]

    async def stream(self) -> AsyncIterator[str]:
        """Independent cursor per stream avoids one client consuming another's events."""
        cursor = TrafficTailer(self.file, poll_ms=self.poll_ms, batch_ms=self.batch_ms, max_batch=self.max_batch)
        await asyncio.to_thread(cursor.poll, initial=True)
        pending: list[dict[str, Any]] = []
        elapsed = 0
        ping_elapsed = 0
        while True:
            await asyncio.sleep(self.poll_ms / 1000)
            pending.extend(await asyncio.to_thread(cursor.poll))
            if len(pending) > 1000:
                pending = pending[-1000:]
            elapsed += self.poll_ms
            ping_elapsed += self.poll_ms
            if elapsed >= self.batch_ms and pending:
                while pending:
                    batch, pending = pending[: self.max_batch], pending[self.max_batch :]
                    yield f"event: traffic\ndata: {json.dumps(batch, separators=(',', ':'))}\n\n"
                elapsed = 0
            if ping_elapsed >= 15000:
                yield ": ping\n\n"
                ping_elapsed = 0

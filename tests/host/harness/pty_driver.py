#!/usr/bin/env python3
"""Drive a shipped dsh CLI through a real, privately owned Linux PTY.

One JSON request on stdin: argv, cwd, env, mode, steps, output_dir.
One JSON result on stdout. No fake Agent, Session, renderer or key decoder.
The only emulated component is the remote terminal's TSP hello/acks/events.
"""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

QUERY = b"\x1b_tsp;q;"
APC = re.compile(rb"\x1b_tsp;([a-z]);(.*?)\x1b\\", re.DOTALL)
DA1 = b"\x1b[?1;2c"
HELLO = {
    "r": "hello", "v": 1, "term": "tern", "ver": "0.1.0",
    "kinds": ["text", "row", "col", "card", "md", "editor", "input", "el"],
    "features": ["edit", "undo", "send", "settle"],
    "apc": 4096, "credits": 16, "cols": 100,
    "cell": {"w": 8, "h": 16}, "dark": True, "reduceMotion": False,
}


def frame(verb: str, body: dict) -> bytes:
    """Frame a remote terminal response, not a replacement program parser."""
    return b"\x1b_tsp;" + verb.encode("ascii") + b";" + json.dumps(
        body, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8") + b"\x1b\\"


def attach_controlling_tty() -> None:
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def set_size(fd: int, columns: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


class Driver:
    def __init__(self, spec: dict) -> None:
        self.spec = spec
        self.mode = spec.get("mode", "ansi")
        self.root = Path(spec["output_dir"]).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.master, slave = os.openpty()
        set_size(self.master, 100, 28)
        self.proc = subprocess.Popen(
            spec["argv"], cwd=spec["cwd"], env=spec["env"],
            stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, preexec_fn=attach_controlling_tty,
        )
        os.close(slave)
        self.raw = bytearray()
        self.scanned = 0
        self.hello_sent = False
        self.acks: set[tuple[str, int]] = set()
        self.events: list[dict] = []
        # Only complete, byte-for-byte reassembled frames are acknowledged.
        self.frames: list[dict] = []
        self.chunks: dict[tuple[bytes, bytes], bytearray] = {}
        self.wire_errors: list[str] = []
        self.nodes: dict[str, dict] = {}
        self.node_changes: list[dict] = []
        self.last_frame_end = 0
        self.actions: dict[str, str] = {}
        self.answer_id: str | None = None
        self.actions_sent: list[dict] = []
        self.captures: dict[str, dict] = {}
        self.last_wait_end = 0
        self.started = time.monotonic()

    def send(self, data: bytes) -> None:
        if not data:
            return
        view = memoryview(data)
        while view:
            written = os.write(self.master, view)
            view = view[written:]

    def handshake(self) -> None:
        if self.hello_sent or QUERY not in self.raw:
            return
        self.hello_sent = True
        if self.mode in ("native", "osc-hello"):
            if self.mode == "osc-hello":
                packet = b"\x1b]877;tsp;r;" + json.dumps(HELLO).encode() + b"\x1b\\"
            else:
                packet = frame("r", HELLO)
            self.send(packet)
        elif self.mode in ("da1", "late-hello", "invalid"):
            if self.mode == "invalid":
                self.send(frame("r", {"r": "unrecognized"}))
            self.send(DA1)
            if self.mode == "late-hello":
                time.sleep(0.02)
                self.send(frame("r", HELLO))
        elif self.mode == "timeout":
            return
        elif self.mode != "ansi":
            raise ValueError("unsupported terminal mode: " + self.mode)
        else:
            self.send(DA1)

    def collect_actions(self, document: object) -> None:
        """Discover actual negotiated el(tag:button) IDs in emitted TSP docs."""
        if not isinstance(document, dict):
            return
        props = document.get("p")
        if document.get("k") == "el" and isinstance(props, dict) and props.get("tag") == "button":
            label, ident = props.get("text"), document.get("id")
            if isinstance(label, str) and isinstance(ident, str) and ident.startswith("layer."):
                self.actions[label] = ident
        if document.get("k") in ("editor", "input"):
            ident = document.get("id")
            if isinstance(ident, str) and ident.startswith("layer."):
                self.answer_id = ident
        children = document.get("c")
        if isinstance(children, list):
            for child in children:
                self.collect_actions(child)

    def reassemble(self, verb: bytes, body: bytes) -> bytes | None:
        """Respect TSP c/m chunk headers; keep arbitrary payload bytes intact."""
        fields: dict[bytes, bytes] = {}
        rest = body
        while rest.startswith((b"c=", b"m=")):
            field, delimiter, tail = rest.partition(b";")
            if not delimiter:
                raise ValueError("unterminated TSP chunk parameter")
            name, equals, value = field.partition(b"=")
            if not equals or not value or name in fields:
                raise ValueError("malformed TSP chunk parameter")
            fields[name] = value
            rest = tail
        chunk = fields.get(b"c")
        if chunk is None:
            if fields:
                raise ValueError("TSP continuation without chunk identity")
            return body
        if fields.get(b"m", b"0") not in (b"0", b"1"):
            raise ValueError("invalid TSP continuation flag")
        key = (verb, chunk)
        if key not in self.chunks:
            self.chunks[key] = bytearray()
        self.chunks[key].extend(rest)
        if fields.get(b"m") == b"1":
            return None
        complete = bytes(self.chunks.pop(key))
        return complete

    def remember_node(self, document: object, frame_index: int) -> None:
        if not isinstance(document, dict):
            return
        ident = document.get("id")
        props = document.get("p")
        if isinstance(ident, str):
            self.nodes[ident] = {
                "k": document.get("k"),
                "p": dict(props) if isinstance(props, dict) else {},
            }
            self.note_node(ident, frame_index)
        children = document.get("c")
        if isinstance(children, list):
            for child in children:
                self.remember_node(child, frame_index)

    def note_node(self, ident: str, frame_index: int) -> None:
        node = self.nodes[ident]
        self.node_changes.append({
            "frame_index": frame_index, "id": ident,
            "k": node["k"], "p": dict(node["p"]),
        })

    def apply_frame(self, body: dict) -> None:
        index = len(self.frames) - 1
        for op in body.get("ops", []):
            if not isinstance(op, list) or not op:
                continue
            if op[0] == "add" and len(op) >= 5:
                self.remember_node(op[4], index)
                self.collect_actions(op[4])
            elif op[0] == "text" and len(op) >= 4 and isinstance(op[1], str):
                ident = op[1]
                if not isinstance(op[3], str):
                    continue
                node = self.nodes.setdefault(ident, {"k": "text", "p": {}})
                old = node["p"].get("text", "")
                node["p"]["text"] = old + op[3] if op[2] == "append" else op[3]
                self.note_node(ident, index)
            elif op[0] in ("props", "set", "prop", "patch") and len(op) >= 3 and isinstance(op[1], str):
                ident = op[1]
                node = self.nodes.get(ident)
                if node is None:
                    continue
                if isinstance(op[2], dict):
                    node["p"].update(op[2])
                elif len(op) >= 4 and isinstance(op[2], str):
                    node["p"][op[2]] = op[3]
                self.note_node(ident, index)
            elif op[0] == "del" and len(op) >= 2 and isinstance(op[1], str):
                ident = op[1]
                for child in list(self.nodes):
                    if child == ident or child.startswith(ident + "."):
                        del self.nodes[child]

    def scan(self) -> None:
        # An APC can span PTY reads; a single complete TSP frame can in turn
        # span multiple APC packets. ACK only the fully decoded frame.
        data = bytes(self.raw)
        for match in APC.finditer(data, self.scanned):
            verb = match.group(1)
            self.events.append({"out": verb.decode("ascii")})
            if verb == b"f":
                try:
                    payload = self.reassemble(verb, match.group(2))
                    if payload is not None:
                        body = json.loads(payload.decode("utf-8"))
                        if not isinstance(body, dict):
                            raise ValueError("non-object TSP frame")
                        self.frames.append(body)
                        self.apply_frame(body)
                        if self.spec.get("auto_ack", True):
                            surface, seq = body["sf"], body["s"]
                            ident = (surface, seq)
                            if ident not in self.acks:
                                self.acks.add(ident)
                                self.send(frame("e", {"ev": "ack", "sf": surface, "s": seq}))
                except (UnicodeDecodeError, ValueError, KeyError, TypeError) as error:
                    self.wire_errors.append(
                        "outgoing TSP frame at byte " + str(match.start()) + ": " + str(error))
            elif verb == b"e" and b'"ev":"error"' in match.group(2):
                self.wire_errors.append("terminal received outgoing TSP error event")
            self.scanned = match.end()
        self.handshake()

    def until_node(self, wanted: dict, seconds: float = 30, after: int = 0) -> None:
        """Wait for actual semantic node content/props, not quoted JSON bytes."""
        def matches(change: dict) -> bool:
            if change["frame_index"] < after:
                return False
            if "id" in wanted and wanted["id"] != change["id"]:
                return False
            props = change["p"]
            if "contains" in wanted and wanted["contains"] not in props.get("text", ""):
                return False
            for field in ("text", "cursor", "sendable"):
                if field in wanted and props.get(field) != wanted[field]:
                    return False
            return True

        limit = time.monotonic() + seconds
        while True:
            for change in self.node_changes:
                if matches(change):
                    self.last_frame_end = change["frame_index"] + 1
                    return
            if self.proc.poll() is not None:
                self.pump(0.02)
                if not any(matches(change) for change in self.node_changes):
                    raise AssertionError("child exited before semantic node: " + repr(wanted))
            if time.monotonic() > limit:
                raise TimeoutError("missing semantic node: " + repr(wanted))
            self.pump(0.02)

    def pump(self, duration: float = 0.05) -> None:
        if self.master < 0:
            return
        readable, _, _ = select.select([self.master], [], [], duration)
        if not readable:
            return
        try:
            data = os.read(self.master, 65536)
        except OSError:
            data = b""
        if data:
            self.raw.extend(data)
            self.scan()

    def until(self, expected: str, seconds: float = 25, start: int = 0) -> None:
        marker = expected.encode("utf-8")
        limit = time.monotonic() + seconds
        while self.raw.find(marker, start) < 0:
            if self.proc.poll() is not None:
                # A process may have terminated with unread PTY output.
                self.pump(0.02)
                if self.raw.find(marker, start) < 0:
                    raise AssertionError("child exited before expected output: " + expected)
            if time.monotonic() > limit:
                raise TimeoutError("missing PTY output: " + expected)
            self.pump(0.02)
        self.last_wait_end = self.raw.index(marker, start) + len(marker)

    def steps(self) -> None:
        for step in self.spec.get("steps", []):
            if "node_after" in step:
                self.until_node(step["node_after"], step.get("timeout_sec", 30), self.last_frame_end)
            elif "node" in step:
                self.until_node(step["node"], step.get("timeout_sec", 30))
            elif "wait_after" in step:
                self.until(step["wait_after"], step.get("timeout_sec", 30), self.last_wait_end)
            elif "wait" in step:
                self.until(step["wait"], step.get("timeout_sec", 30))
            elif "capture" in step:
                self.captures[str(step["capture"])] = {
                    "byte_offset": len(self.raw), "frame_count": len(self.frames),
                    "composer": dict(self.nodes.get("dock.composer.line.input", {}).get("p", {})),
                }
            elif "answer" in step:
                if self.answer_id is None:
                    raise AssertionError("question editor missing in real emitted SDK document")
                self.actions_sent.append({"label": "answer", "id": self.answer_id})
                self.send(frame("e", {
                    "ev": "send", "sf": "dsh", "id": self.answer_id, "text": str(step["answer"]),
                }))
            elif "release_approval" in step:
                if step["release_approval"] is not True:
                    raise ValueError("release_approval requires true")
                workspace = Path(self.spec["env"]["DSH_TUI_TEST_WORKSPACE"]).resolve()
                if workspace != self.root.parent:
                    raise AssertionError("approval barrier escaped the private PTY workspace")
                release = workspace / "approval-release.barrier"
                with release.open("x", encoding="utf-8") as marker:
                    marker.write("release\n")
                os.chmod(release, 0o600)
            elif "action" in step:
                wanted = str(step["action"])
                matches = [(key, value) for key, value in self.actions.items()
                           if key == wanted or key.endswith(") " + wanted)]
                if len(matches) != 1:
                    raise AssertionError("expected one real native action for "
                                         + repr(wanted) + ", found " + repr(matches))
                label, ident = matches[0]
                self.actions_sent.append({"label": label, "id": ident})
                self.send(frame("e", {"ev": "action", "sf": "dsh", "id": ident, "act": "click"}))
            elif "write" in step:
                self.send(step["write"].encode("utf-8"))
            elif "hex" in step:
                self.send(bytes.fromhex(step["hex"]))
            elif "event" in step:
                self.send(frame("e", step["event"]))
            elif "osc877" in step:
                self.send(b"\x1b]877;tsp;e;" + json.dumps(step["osc877"]).encode() + b"\x1b\\")
            elif "sleep_ms" in step:
                delay = time.monotonic() + step["sleep_ms"] / 1000
                while time.monotonic() < delay:
                    self.pump(min(0.02, delay - time.monotonic()))
            elif "resize" in step:
                set_size(self.master, step["resize"][0], step["resize"][1])
                os.killpg(self.proc.pid, signal.SIGWINCH)
            elif "signal" in step:
                os.killpg(self.proc.pid, getattr(signal, step["signal"]))
            else:
                raise ValueError("unknown PTY step: " + repr(step))

    def finish(self) -> dict:
        deadline = self.started + self.spec.get("timeout_sec", 65)
        while self.proc.poll() is None and time.monotonic() < deadline:
            self.pump(0.05)
        timed_out = self.proc.poll() is None
        if timed_out:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        exit_code = self.proc.wait(timeout=5)
        for _ in range(5):
            self.pump(0.01)
        if self.chunks:
            self.wire_errors.append("incomplete outgoing TSP chunks at child exit")
        return {
            "exit_code": exit_code,
            "timed_out": timed_out,
            "hello_sent": self.hello_sent,
            "acks": len(self.acks),
            "output": bytes(self.raw).decode("utf-8", errors="replace"),
            "wire_ops": self.events,
            "frames": self.frames,
            "wire_errors": self.wire_errors,
            "nodes": self.nodes,
            "actions_sent": self.actions_sent,
            "captures": self.captures,
        }

    def close(self) -> None:
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGKILL)
            self.proc.wait(timeout=5)
        if self.master >= 0:
            os.close(self.master)
            self.master = -1
        raw = self.root / "pty.bin"
        raw.write_bytes(self.raw)
        os.chmod(raw, 0o600)
        decoded = self.root / "pty.txt"
        decoded.write_text(bytes(self.raw).decode("utf-8", errors="replace"))
        os.chmod(decoded, 0o600)
        frames_file = self.root / "tsp-frames.json"
        frames_file.write_text(json.dumps(self.frames, ensure_ascii=False, indent=2))
        os.chmod(frames_file, 0o600)


def main() -> int:
    os.umask(0o077)
    spec = json.load(sys.stdin)
    driver = Driver(spec)
    failure = None
    result = None
    try:
        driver.steps()
        result = driver.finish()
    except (OSError, ValueError, AssertionError, TimeoutError) as error:
        failure = str(error)
    finally:
        driver.close()
    if result is None:
        result = {
            "exit_code": driver.proc.returncode,
            "timed_out": False,
            "hello_sent": driver.hello_sent,
            "acks": len(driver.acks),
            "output": bytes(driver.raw).decode("utf-8", errors="replace"),
            "actions_sent": driver.actions_sent,
            "captures": driver.captures,
            "frames": driver.frames,
            "wire_errors": driver.wire_errors,
            "nodes": driver.nodes,
        }
    if failure is not None:
        result["failure"] = failure
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 1 if failure or result["timed_out"] else 0


if __name__ == "__main__":
    sys.exit(main())

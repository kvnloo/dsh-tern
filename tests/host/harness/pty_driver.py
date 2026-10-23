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
    "kinds": ["text", "row", "col", "card", "md", "editor", "input", "button"],
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

    def scan(self) -> None:
        # Inspect the actual SDK output, so credits are returned for every
        # complete frame without assuming how DSH chooses to render it.
        data = bytes(self.raw)
        for match in APC.finditer(data, self.scanned):
            verb = match.group(1)
            self.events.append({"out": verb.decode("ascii")})
            if verb == b"f" and self.spec.get("auto_ack", True):
                try:
                    body = json.loads(match.group(2))
                    surface, seq = body["sf"], body["s"]
                    ident = (surface, seq)
                    if ident not in self.acks:
                        self.acks.add(ident)
                        self.send(frame("e", {"ev": "ack", "sf": surface, "s": seq}))
                except (UnicodeDecodeError, ValueError, KeyError, TypeError):
                    pass  # The full wire log records the unsupported frame.
            self.scanned = match.end()
        self.handshake()

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

    def until(self, expected: str, seconds: float = 25) -> None:
        marker = expected.encode("utf-8")
        limit = time.monotonic() + seconds
        while marker not in self.raw:
            if self.proc.poll() is not None:
                # A process may have terminated with unread PTY output.
                self.pump(0.02)
                if marker not in self.raw:
                    raise AssertionError("child exited before expected output: " + expected)
            if time.monotonic() > limit:
                raise TimeoutError("missing PTY output: " + expected)
            self.pump(0.02)

    def steps(self) -> None:
        for step in self.spec.get("steps", []):
            if "wait" in step:
                self.until(step["wait"], step.get("timeout_sec", 30))
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
            elif "eof" in step:
                os.close(self.master)
                self.master = -1
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
        return {
            "exit_code": exit_code,
            "timed_out": timed_out,
            "hello_sent": self.hello_sent,
            "acks": len(self.acks),
            "output": bytes(self.raw).decode("utf-8", errors="replace"),
            "wire_ops": self.events,
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
        }
    if failure is not None:
        result["failure"] = failure
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 1 if failure or result["timed_out"] else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Seal private LIVE or REPLAY acceptance artifacts with an exact provenance manifest.

Full SDK and Session recordings remain INSIDE the owner-only archive.
redacted-wire.jsonl is metadata-only and safe for narrower review; it omits
content, auth fields, model output and prompt text. Never auto-upload.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile
from typing import Any

SHA = re.compile(r"^[0-9a-f]{40}$")


def owner_only(path: Path) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise ValueError("symlink evidence refused: " + str(path))
    if info.st_uid != os.getuid():
        raise ValueError("evidence not owned by invoking user: " + str(path))
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise ValueError("world/group-readable private evidence refused: " + str(path))


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for packet in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(packet)
    return h.hexdigest()


def redacted_wire(src: Path, dest: Path) -> dict[str, int]:
    counts = {"in": 0, "out": 0}
    with dest.open("x", encoding="utf-8") as output:
        for i, line in enumerate(src.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"SDK recorder line {i}: {error}") from error
            if not isinstance(row, dict) or row.get("dir") not in counts:
                raise ValueError(f"SDK recorder line {i}: invalid direction")
            direction = row["dir"]
            counts[direction] += 1
            body = json.dumps(row.get("body"), sort_keys=True, ensure_ascii=False).encode("utf-8")
            output.write(json.dumps({
                "direction": direction,
                "verb": row.get("verb"),
                "body_utf8_bytes": len(body),
                "body_sha256": hashlib.sha256(body).hexdigest(),
            }, ensure_ascii=False) + "\n")
    dest.chmod(0o600)
    return counts


def make_manifest(root: Path) -> dict[str, Any]:
    control = root / "control"
    sha = (control / "git-sha").read_text().strip()
    mode = (control / "evidence-mode").read_text().strip()
    build = (control / "tern-version").read_text().strip()
    binary_hash = (control / "tern-binary-sha256").read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", binary_hash):
        raise ValueError("missing binary SHA-256 of exact Tern executable")
    build += " sha256=" + binary_hash
    if not SHA.fullmatch(sha):
        raise ValueError("missing exact 40-hex Git source SHA")
    if mode not in ("live", "replay"):
        raise ValueError("capture mode must be live or replay")
    if not build:
        raise ValueError("missing exact Tern build/version")
    files = []
    for item in sorted(root.rglob("*")):
        owner_only(item)
        if item.is_dir():
            continue
        if not item.is_file():
            raise ValueError("unexpected non-file evidence: " + str(item))
        files.append({
            "path": str(item.relative_to(root)),
            "sha256": digest(item),
            "bytes": item.stat().st_size,
        })
    return {
        "schema": "dsh.tsp.evidence.1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "git_sha": sha,
        "tern_build": build,
        "private": True,
        "source_kind": "actual-process" if mode == "live" else "surface-replay",
        "commands_file": "control/replies.tsv",
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    root = args.evidence_dir.resolve(strict=True)
    out = args.out.absolute()
    try:
        owner_only(root)
        if root == out or root in out.parents:
            raise ValueError("output archive must live outside evidence directory")
        if out.exists():
            raise ValueError("refusing to overwrite existing evidence archive")
        if (root / "manifest.json").exists() or (root / "redacted-wire.jsonl").exists():
            raise ValueError("evidence was already sealed; refuse silent mutation")
        mode = (root / "control" / "evidence-mode").read_text().strip()
        wire = root / "log" / ("dsh-sdk-wire.jsonl" if mode == "live" else "replay-source.jsonl")
        if not wire.exists():
            raise ValueError("SDK recording missing for the labelled evidence mode")
        owner_only(wire)
        counts = redacted_wire(wire, root / "redacted-wire.jsonl")
        manifest = make_manifest(root)
        manifest["record_counts"] = counts
        target = root / "manifest.json"
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        target.chmod(0o600)
        os.umask(0o077)
        out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tarfile.open(out, mode="x:gz") as bundle:
            for member in sorted(root.rglob("*")):
                if member.is_file():
                    bundle.add(member, arcname=str(member.relative_to(root)), recursive=False)
        out.chmod(0o600)
        print(json.dumps({
            "archive": str(out), "manifest": str(target),
            "git_sha": manifest["git_sha"], "tern_build": manifest["tern_build"],
            "mode": manifest["mode"], "records": counts,
        }))
        return 0
    except (OSError, ValueError, tarfile.TarError) as error:
        print("evidence bundle REFUSED: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

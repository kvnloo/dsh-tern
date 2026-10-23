#!/usr/bin/env python3
"""Seal a private, explicit Tern/DSH proof allowlist; NEVER upload anything.

Usage: evidence_bundle.py --evidence-dir PRIVATE_DIR --out NEW_ARCHIVE.tar.gz
       [--include-fixtures]

Inputs are required owner-only metadata in control/{git-sha,tern-version,
tern-binary-sha256,launcher.json,capture.json,evidence-mode,replies.tsv},
private command snapshots, logs, SDK wire, and (for functional local live
captures) physical Session JSONL. launcher.json attests source_sha,
artifact_sha256, location, hash_origin and provenance. capture.json carries
capture_id, scope, model_id, workspace_start, collector and wire_file.

No traversal of runtime/, home/, cache/, config/, sockets, or unknown files.
Only allowlisted owner-only files are archived; optional fixture payloads need
--include-fixtures. Decoded SDK JSON body hash/size is NOT a raw wire hash.
A consistent copied input snapshot, manifest, and redacted metadata are staged outside the evidence tree;
the complete archive is linked into place atomically without replacement.
Failed attempts leave input untouched and are retryable.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from typing import Any

SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA64 = re.compile(r"[0-9a-f]{64}\Z")
SNAPSHOT = re.compile(r"[A-Za-z0-9._-]+-(state|tree|dump|css|a11y|stats|shot)\.json\Z")
SESSION = re.compile(r"session(?:\.v[1-9][0-9]*)?\.jsonl\Z")
IMAGE = re.compile(r"[A-Za-z0-9._-]+\.(png|webp|jpg|jpeg)\Z")
FIXTURES = ("fixtures/cordis.yml", "fixtures/deterministic.json")
REQUIRED = (
    "control/git-sha", "control/tern-version", "control/tern-binary-sha256",
    "control/launcher.json", "control/capture.json", "control/evidence-mode",
    "control/replies.tsv", "log/sway.log", "log/tern-serve.log",
)
CONTROL = {
    "control/mode", "control/private-wayland-display", "control/quit.json",
    "control/foreground-shell.json", "control/sway-info.json", "control/exit.json",
    "control/commands.json", "control/pre-run-state.json",
    "control/shells-before.json", "control/shells-after.json",
    "control/shells-before-run.json",
}
LOGS = {
    "log/sway.log", "log/tern-serve.log", "log/tern-ctl.err",
    "log/metadata.jsonl", "log/dsh-sdk-wire.jsonl", "log/replay-source.jsonl",
    "log/dsh-exit.log", "log/dsh-process.log",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def owner_only(path: Path, directory: bool | None = None) -> None:
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), "symlink evidence refused: " + str(path))
    require(info.st_uid == os.getuid(), "evidence not owned by invoker: " + str(path))
    require(not (info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)),
            "group/world access refused: " + str(path))
    if directory is True:
        require(stat.S_ISDIR(info.st_mode), "expected evidence directory: " + str(path))
    elif directory is False:
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                "nonregular/hardlinked evidence refused: " + str(path))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as src:
        for part in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(part)
    return digest.hexdigest()


def load_object(path: Path) -> dict[str, Any]:
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), "expected JSON object at " + str(path))
    return value


def collect(root: Path, include_fixtures: bool) -> dict[str, Path]:
    """Enumerate ONLY approved data areas; never walk the workspace tree."""
    owner_only(root, True)
    chosen: dict[str, Path] = {}

    def admit(relative: str, required: bool = False) -> None:
        path = root / relative
        if not path.exists() and not path.is_symlink():
            require(not required, "missing required artifact: " + relative)
            return
        owner_only(path, False)
        chosen[relative] = path

    for relative in REQUIRED:
        owner_only(root / relative.split("/")[0], True)
        admit(relative, True)
    for relative in CONTROL | LOGS:
        admit(relative)
    ctl = root / "control"
    for entry in ctl.iterdir():
        if SNAPSHOT.fullmatch(entry.name):
            admit("control/" + entry.name)
    sessions = root / "sessions"
    if sessions.exists() or sessions.is_symlink():
        owner_only(sessions, True)
        for path in sessions.rglob("*"):
            # This is a purpose-specific Session area, never the home/cache tree.
            owner_only(path, path.is_dir() if not path.is_symlink() else None)
            if path.is_file() and SESSION.fullmatch(path.name):
                admit(path.relative_to(root).as_posix())
    images = root / "tern"
    if images.exists() or images.is_symlink():
        owner_only(images, True)
        for path in images.iterdir():
            if IMAGE.fullmatch(path.name):
                admit("tern/" + path.name)
    if include_fixtures:
        folder = root / "fixtures"
        owner_only(folder, True)
        for relative in FIXTURES:
            admit(relative)
    return chosen


def snapshot_inputs(chosen: dict[str, Path], stage: Path) -> tuple[Path, dict[str, Path]]:
    """Copy only admitted regular inputs to an invocation-owned sealed view."""
    root = stage / "inputs"
    root.mkdir(mode=0o700)
    captured: dict[str, Path] = {}
    for relative, source in sorted(chosen.items()):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        owner_only(source, False)
        # Refuse a symlink substitution between enumeration and the open.
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            with os.fdopen(fd, "rb") as stream:
                before = os.fstat(stream.fileno())
                require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                        before.st_uid == os.getuid() and
                        not (before.st_mode & (stat.S_IRWXG | stat.S_IRWXO)),
                        "input changed during snapshot: " + relative)
                # Create 0600 immediately; do not rely on the caller's umask.
                with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT |
                                       os.O_EXCL, 0o600), "wb") as dest:
                    shutil.copyfileobj(stream, dest, 1024 * 1024)
                after = os.fstat(stream.fileno())
                current = source.lstat()
                def identity(info: os.stat_result) -> tuple[int, ...]:
                    return (info.st_dev, info.st_ino, info.st_size,
                            info.st_mtime_ns, info.st_ctime_ns, info.st_mode)
                require(identity(before) == identity(after) == identity(current),
                        "input changed during snapshot: " + relative)
        except BaseException:
            # fdopen closes its own descriptor; a failure before fdopen should
            # leave cleanup to TemporaryDirectory without touching evidence.
            raise
        captured[relative] = target
    return root, captured


def redacted_wire(src: Path, dest: Path) -> dict[str, int]:
    counts = {"in": 0, "out": 0}
    with src.open(encoding="utf-8") as stream, dest.open("x", encoding="utf-8") as output:
        for number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"SDK recorder line {number}: {error}") from error
            require(isinstance(row, dict) and row.get("dir") in counts,
                    f"SDK recorder line {number}: missing direction")
            counts[row["dir"]] += 1
            # This is a canonical decoded JSON hash, not packet/physical byte proof.
            body = json.dumps(row.get("body"), sort_keys=True, ensure_ascii=False,
                              separators=(",", ":")).encode("utf-8")
            output.write(json.dumps({
                "direction": row["dir"], "verb": row.get("verb"),
                "decoded_body_utf8_bytes": len(body),
                "decoded_body_sha256": hashlib.sha256(body).hexdigest(),
                "encoding": "canonical-decoded-json-not-raw-wire",
            }, ensure_ascii=False) + "\n")
    dest.chmod(0o600)
    return counts


def manifest(root: Path, chosen: dict[str, Path], stage: Path,
             include_fixtures: bool) -> tuple[dict[str, Any], Path | None]:
    sha = (root / "control/git-sha").read_text(encoding="utf-8").strip()
    mode = (root / "control/evidence-mode").read_text(encoding="utf-8").strip()
    version = (root / "control/tern-version").read_text(encoding="utf-8").strip()
    binary_sha = (root / "control/tern-binary-sha256").read_text(encoding="utf-8").strip()
    build = load_object(root / "control/launcher.json")
    capture = load_object(root / "control/capture.json")
    require(bool(SHA40.fullmatch(sha)), "missing exact source Git SHA")
    require(mode in ("live", "replay"), "evidence-mode must be live or replay")
    require(bool(version) and bool(SHA64.fullmatch(binary_sha)),
            "exact Tern version and binary SHA256 required")
    require(build.get("source_sha") == sha and
            bool(SHA64.fullmatch(str(build.get("artifact_sha256", "")))) and
            build.get("location") in ("local", "remote") and
            build.get("hash_origin") in ("measured-locally", "declared-remote") and
            isinstance(build.get("provenance"), str) and bool(build["provenance"].strip()),
            "launcher source/build SHA, location, hash origin and provenance required")
    require((build["location"] == "local") == (build["hash_origin"] == "measured-locally"),
            "remote artifact hash must not be described as measured locally")
    require(capture.get("capture_id") and isinstance(capture["capture_id"], str) and
            capture.get("model_id") and isinstance(capture["model_id"], str) and
            capture.get("collector") in ("local-process", "remote-uncollected"),
            "capture ID, exact model ID and explicit collector required")
    require((build["location"] == "local") == (capture["collector"] == "local-process"),
            "launcher location disagrees with evidence collector")
    scope = capture.get("scope")
    require(scope in ("startup-no-prompt", "live-functional", "replay-only"),
            "invalid capture scope")
    require((mode == "replay") == (scope == "replay-only"),
            "replay must remain separately labelled; cannot claim a live launch")
    workspace = capture.get("workspace_start")
    require(isinstance(workspace, dict) and isinstance(workspace.get("empty"), bool) and
            (type(workspace.get("prior_events")) is int or
             (build["location"] == "remote" and workspace.get("prior_events") is None)),
            "explicit starting workspace metadata missing")
    if build["location"] == "local" and mode == "live":
        require(workspace["empty"] is True and workspace["prior_events"] == 0,
                "local live fixture must start from a verified empty workspace")
    wire_name = capture.get("wire_file")
    if mode == "replay":
        require(wire_name == "log/replay-source.jsonl" and wire_name in chosen,
                "replay requires privately captured replay-source.jsonl")
        require("log/dsh-sdk-wire.jsonl" not in chosen and
                "log/metadata.jsonl" not in chosen and
                not any(p.startswith("sessions/") for p in chosen),
                "REPLAY ONLY archive must not contain live DSH SDK/Session records")
    elif build["location"] == "local":
        require(wire_name == "log/dsh-sdk-wire.jsonl" and
                wire_name in chosen and "log/metadata.jsonl" in chosen,
                "local live evidence requires SDK wire and metadata recorder")
    else:
        require(wire_name is None and
                "log/dsh-sdk-wire.jsonl" not in chosen and
                "log/metadata.jsonl" not in chosen and
                not any(p.startswith("sessions/") for p in chosen),
                "uncopied remote DSH SDK/Session logs must not be labelled local captures")
    if mode == "live":
        require("log/replay-source.jsonl" not in chosen,
                "live evidence must not bundle replay-source.jsonl")
    if mode == "live" and scope == "live-functional" and build["location"] == "local":
        require(any(path.startswith("sessions/") for path in chosen),
                "functional local run requires actual persisted Session JSONL")
    # Snapshot hashes are fixed BEFORE redaction. Even if redaction or another
    # thread mutates the copied input, the seal must refuse rather than claim
    # counts from different bytes than its archived wire.
    entries = [
        {"path": name, "sha256": sha256(path), "bytes": path.stat().st_size}
        for name, path in sorted(chosen.items())
    ]
    counts: dict[str, int] = {"in": 0, "out": 0}
    redacted: Path | None = None
    if wire_name:
        redacted = stage / "redacted-wire.jsonl"
        counts = redacted_wire(chosen[wire_name], redacted)
    for entry in entries:
        path = chosen[entry["path"]]
        require(path.stat().st_size == entry["bytes"] and
                sha256(path) == entry["sha256"],
                "input snapshot changed after redaction: " + entry["path"])
    if redacted:
        entries.append({"path": "redacted-wire.jsonl", "sha256": sha256(redacted),
                        "bytes": redacted.stat().st_size})
    source_kind = (
        "surface-replay" if mode == "replay" else
        "actual-process" if build["location"] == "local" else
        "remote-uncollected"
    )
    result = {
        "schema": "dsh.tsp.evidence.2",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "private": True, "mode": mode, "source_kind": source_kind,
        "scope": scope, "capture_id": capture["capture_id"],
        "git_sha": sha, "tern_version": version,
        "tern_binary_sha256": binary_sha, "model_id": capture["model_id"],
        "workspace_start": workspace, "launcher": build,
        "collector": capture["collector"], "wire_file": wire_name,
        "record_counts": counts, "include_fixtures": include_fixtures,
        "files": entries,
    }
    return result, redacted


def seal(root: Path, out: Path, include_fixtures: bool) -> dict[str, Any]:
    owner_only(root, True)
    require(not out.exists() and not out.is_symlink(), "refusing archive overwrite")
    # Resolve the whole destination parent, including any symlinked ancestors.
    # A lexical comparison against resolved root is NOT a containment check.
    candidate = out.parent.resolve(strict=False)
    require(candidate != root and root not in candidate.parents,
            "archive must be outside evidence tree")
    # Do not even create a directory within evidence before rejecting output.
    out.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = out.parent.resolve(strict=True)
    require(parent != root and root not in parent.parents,
            "archive must be outside evidence tree")
    require(not out.parent.is_symlink(), "symlink archive directory refused")
    out = parent / out.name
    require(not out.exists() and not out.is_symlink(), "refusing archive overwrite")
    # Bind publication to the verified directory fd, not a path that an
    # ancestor could redirect after containment checking.
    directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        chosen = collect(root, include_fixtures)
        with tempfile.TemporaryDirectory(prefix=".dsh-proof-", dir=parent) as tmp:
            stage = Path(tmp)
            snapshot_root, snapshot = snapshot_inputs(chosen, stage)
            result, redacted = manifest(snapshot_root, snapshot, stage, include_fixtures)
            marker = stage / "manifest.json"
            marker.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                              encoding="utf-8")
            marker.chmod(0o600)
            archive = stage / "complete.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                for relative, path in sorted(snapshot.items()):
                    owner_only(path, False)
                    tar.add(path, arcname=relative, recursive=False)
                if redacted:
                    tar.add(redacted, arcname="redacted-wire.jsonl", recursive=False)
                tar.add(marker, arcname="manifest.json", recursive=False)
            archive.chmod(0o600)
            # A staged input could mutate during redaction, hashing or tar.
            # Verify the completed tar, not only the disk paths.
            with tarfile.open(archive, "r:gz") as sealed:
                for entry in result["files"]:
                    member = sealed.getmember(entry["path"])
                    stream = sealed.extractfile(member)
                    require(stream is not None and member.size == entry["bytes"],
                            "archive member size mismatch: " + entry["path"])
                    verify = hashlib.sha256()
                    for packet in iter(lambda: stream.read(1024 * 1024), b""):
                        verify.update(packet)
                    require(verify.hexdigest() == entry["sha256"],
                            "evidence changed during seal: " + entry["path"])
            # Exclusive hard-link publication; an existing archive is never
            # replaced. All intermediate paths are invocation-owned.
            os.link(archive, out.name, dst_dir_fd=directory_fd,
                    follow_symlinks=False)
        return result
    finally:
        os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--include-fixtures", action="store_true",
                        help="opt in to only fixtures/cordis.yml and fixtures/deterministic.json")
    args = parser.parse_args()
    try:
        # Check original root before resolve(), which otherwise hides symlinks.
        given = args.evidence_dir.absolute()
        owner_only(given, True)
        root = given.resolve(strict=True)
        result = seal(root, args.out.absolute(), args.include_fixtures)
        print(json.dumps({
            "archive": str(args.out.absolute()), "git_sha": result["git_sha"],
            "tern_version": result["tern_version"],
            "mode": result["mode"], "scope": result["scope"],
            "source_kind": result["source_kind"],
            "records": result["record_counts"],
            "manifest": "manifest.json inside archive; tar -xOzf ARCHIVE manifest.json",
        }))
        return 0
    except (OSError, ValueError, tarfile.TarError, json.JSONDecodeError) as error:
        print("evidence bundle REFUSED: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

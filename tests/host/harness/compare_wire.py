#!/usr/bin/env python3
"""Compare two LIVE SDK JSONL captures under one verified Tern build.

This deliberately compares observable application behavior, not copied SDK
parser/reconciler internals. It refuses replay-only evidence and any capture
without program-open and frame output. Inputs stay on disk; no network access.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any


def records(path: Path) -> list[dict[str, Any]]:
    entries = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{number}: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number}: expected SDK JSONL object")
            entries.append(value)
    if not entries:
        raise ValueError(f"{path}: empty SDK record")
    return entries


def program_surface(rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
    opens = [record for record in rows if record.get("dir") == "out" and record.get("verb") == "o"]
    frames = [record for record in rows if record.get("dir") == "out" and record.get("verb") == "f"]
    if not opens or not frames:
        raise ValueError(name + ": not a LIVE SDK program-open + frame recording")
    ids: set[str] = set()
    roles: set[str] = set()
    kinds: set[str] = set()
    all_text = []
    sequences: dict[str, list[int]] = {}
    for entry in frames:
        frame = entry.get("body", {})
        if not isinstance(frame, dict):
            raise ValueError(name + ": malformed frame body in recorded SDK output")
        surface, sequence = frame.get("sf"), frame.get("s")
        if not isinstance(surface, str) or not isinstance(sequence, int):
            raise ValueError(name + ": frame without string surface / numeric sequence")
        sequences.setdefault(surface, []).append(sequence)
        for operation in frame.get("ops", []):
            if not isinstance(operation, list) or not operation:
                continue
            if operation[0] in ("add", "set", "text") and len(operation) > 1:
                if isinstance(operation[1], str):
                    ids.add(operation[1])
            # The recursive JSON wire tree is the SDK's published output,
            # not a recreated parser or application state machine.
            if operation[0] == "add" and len(operation) >= 5:
                stack = [operation[4]]
                while stack:
                    node = stack.pop()
                    if not isinstance(node, dict):
                        continue
                    kind = node.get("k")
                    props = node.get("p", {})
                    if isinstance(kind, str):
                        kinds.add(kind)
                    if isinstance(props, dict):
                        role = props.get("role")
                        text = props.get("text")
                        if isinstance(role, str):
                            roles.add(role)
                        if isinstance(text, str):
                            all_text.append(text)
                    stack.extend(node.get("c", []) if isinstance(node.get("c"), list) else [])
            elif operation[0] == "set" and len(operation) >= 3:
                props = operation[2]
                if isinstance(props, dict):
                    if isinstance(props.get("text"), str):
                        all_text.append(props["text"])
                    if isinstance(props.get("role"), str):
                        roles.add(props["role"])
            elif operation[0] == "text" and len(operation) >= 4:
                if isinstance(operation[3], str):
                    all_text.append(operation[3])
    for surface, items in sequences.items():
        if items != list(range(1, len(items) + 1)):
            raise ValueError(name + ": non-monotonic SDK frame sequences on " + surface)
    return {
        "opens": len(opens), "frames": len(frames),
        "surface_ids": sorted(sequences), "semantic_ids": sorted(ids),
        "roles": sorted(roles), "kinds": sorted(kinds),
        "wire_text": "\n".join(all_text),
    }


def manifest(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("manifest must be a JSON object")
    if value.get("mode") != "live":
        raise ValueError(str(path) + ": replay is not live-program evidence")
    if not isinstance(value.get("tern_build"), str) or not value["tern_build"]:
        raise ValueError(str(path) + ": missing exact Tern build")
    if not isinstance(value.get("git_sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", value["git_sha"]):
        raise ValueError(str(path) + ": missing exact source commit")
    return value


def compare(args: argparse.Namespace) -> dict[str, Any]:
    dsh_meta = manifest(args.dsh_manifest)
    peer_meta = manifest(args.peer_manifest)
    if dsh_meta["tern_build"] != peer_meta["tern_build"]:
        raise ValueError("incompatible Tern builds: refuse the differential")
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    prompts = fixture.get("prompts") if isinstance(fixture, dict) else None
    if not isinstance(prompts, list) or not prompts or not all(
        isinstance(prompt, str) and prompt for prompt in prompts
    ):
        raise ValueError("fixture needs non-empty prompts[]")
    dsh = program_surface(records(args.dsh), "dsh")
    peer = program_surface(records(args.peer), "hermes/omp")
    cases = []
    for prompt in prompts:
        dsh_present = prompt in dsh["wire_text"]
        peer_present = prompt in peer["wire_text"]
        cases.append({"prompt": prompt, "dsh_rendered": dsh_present, "peer_rendered": peer_present})
    required_roles = ["user", "assistant"]
    role_classes = {
        name: sorted(value for value in required_roles if
                     any(value in role.lower() for role in surface["roles"]))
        for name, surface in [("dsh", dsh), ("peer", peer)]
    }
    differences = []
    differences.extend("missing prompt in live capture: " + json.dumps(case)
                       for case in cases if not case["dsh_rendered"] or not case["peer_rendered"])
    for name, surface in [("dsh", dsh), ("peer", peer)]:
        if not surface["semantic_ids"]:
            differences.append(name + ": no stable SDK semantic node ids")
        if not surface["kinds"]:
            differences.append(name + ": no rendered native kinds")
        if not role_classes[name]:
            differences.append(name + ": no user/assistant role evidence")
    return {
        "mode": "live-differential",
        "tern_build": dsh_meta["tern_build"],
        "source_sha": {"dsh": dsh_meta["git_sha"], "peer": peer_meta["git_sha"]},
        "cases": cases,
        "role_classes": role_classes,
        "app_summary": {
            "dsh": {key: val for key, val in dsh.items() if key != "wire_text"},
            "peer": {key: val for key, val in peer.items() if key != "wire_text"},
        },
        "differences": differences,
        "pass": not differences,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh", type=Path, required=True)
    parser.add_argument("--peer", type=Path, required=True)
    parser.add_argument("--dsh-manifest", type=Path, required=True)
    parser.add_argument("--peer-manifest", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(args)
    except (ValueError, OSError, TypeError) as error:
        print("differential REFUSED: " + str(error), file=sys.stderr)
        return 2
    args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.out.open("x", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    args.out.chmod(0o600)
    print(json.dumps({"pass": result["pass"], "differences": result["differences"]}))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate LIVE, no-prompt DSH versus Hermes/OMP TSP startup (not turn parity).

Usage: compare_wire.py --dsh DSH.jsonl --peer PEER.jsonl
  --dsh-manifest DSH-manifest.json --peer-manifest PEER-manifest.json
  --out NEW.json

Inputs are *decoded SDK JSONL* plus provenance manifests; this tool cannot
recover physical APC byte lengths from JSON. Both manifests must attest exact
binary hashes, source SHA, deterministic model ID, initially empty workspace,
independent capture IDs and original wire file SHA256. Refuses replay, missing
or tampered evidence. Verifies q/r hello, editor capabilities, inline open,
actual recursive add-node IDs, per-open frames, cumulative ACK/credit windows,
and no protocol errors. Does NOT test native edit/send, prompts, model quality,
raw byte framing or functional response parity. Output is created exclusively.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")


def require(ok: bool, reason: str) -> None:
    if not ok:
        raise ValueError(reason)


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for part in iter(lambda: stream.read(1 << 20), b""):
            h.update(part)
    return h.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path}: expected object")
    return value


def manifest(path: Path, wire: Path) -> dict[str, Any]:
    data = read_json(path)
    require(data.get("mode") == "live" and data.get("source_kind") == "actual-process",
            f"{path}: replay/remote-only evidence is not a local live process")
    require(data.get("scope") == "startup-no-prompt",
            f"{path}: only explicit startup-no-prompt evidence is comparable")
    require(bool(HEX40.fullmatch(str(data.get("git_sha", "")))),
            f"{path}: exact source SHA missing")
    require(nonempty(data.get("tern_version")) and
            bool(HEX64.fullmatch(str(data.get("tern_binary_sha256", "")))),
            f"{path}: exact Tern version and binary SHA256 required")
    require(nonempty(data.get("model_id")), f"{path}: explicit model ID required")
    start = data.get("workspace_start")
    require(isinstance(start, dict) and start.get("empty") is True and
            type(start.get("prior_events")) is int and start["prior_events"] == 0,
            f"{path}: explicit empty starting workspace/prior_events=0 required")
    require(nonempty(data.get("capture_id")), f"{path}: unique capture ID required")
    name = data.get("wire_file")
    require(nonempty(name), f"{path}: wire_file path required")
    files = data.get("files")
    require(isinstance(files, list), f"{path}: evidence file hash list required")
    matches = [f for f in files if isinstance(f, dict) and f.get("path") == name]
    require(len(matches) == 1 and bool(HEX64.fullmatch(str(matches[0].get("sha256", "")))),
            f"{path}: recorded wire hash missing or ambiguous")
    require(matches[0]["sha256"] == file_sha256(wire),
            f"{path}: wire does not match sealed SHA256 (stale/replayed/wrong file)")
    return data


def records(path: Path) -> list[dict[str, Any]]:
    require(path.stat().st_size <= 64 * 1024 * 1024, f"{path}: oversized startup wire")
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            require(line_no <= 20000, f"{path}: oversized startup record count")
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_no}: {error}") from error
            require(isinstance(row, dict) and row.get("dir") in ("in", "out") and
                    nonempty(row.get("verb")) and isinstance(row.get("body"), dict),
                    f"{path}:{line_no}: SDK dir, verb and object body required")
            rows.append(row)
    require(bool(rows), f"{path}: empty wire")
    return rows


def recursive_ids(raw: Any, ids: set[str], name: str) -> None:
    require(isinstance(raw, dict), f"{name}: add must contain a real wire node")
    ident = raw.get("id")
    require(nonempty(ident), f"{name}: wire node missing its actual node.id")
    ids.add(ident)
    require(nonempty(raw.get("k")), f"{name}: node {ident} missing kind")
    children = raw.get("c", [])
    require(isinstance(children, list), f"{name}: node {ident} malformed children")
    for child in children:
        recursive_ids(child, ids, name)


def surface(rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
    query: dict[str, Any] | None = None
    hello: dict[str, Any] | None = None
    opens: dict[str, dict[str, Any]] = {}
    discovered: set[str] = set()
    counts = {"q": 0, "r": 0, "o": 0, "f": 0, "ack": 0}
    for index, record in enumerate(rows):
        direction, verb, body = record["dir"], record["verb"], record["body"]
        if verb == "e" and body.get("ev") == "error" or verb in ("error", "x"):
            raise ValueError(f"{name}: TSP protocol error at record {index}")
        if (direction, verb) == ("out", "q"):
            require(query is None and hello is None and not opens,
                    f"{name}: repeated/late q hello")
            require(body.get("q") == "hello" and body.get("v") == 1,
                    f"{name}: wrong q hello/version")
            query = body
            counts["q"] += 1
        elif (direction, verb) == ("in", "r"):
            require(query is not None and hello is None and not opens,
                    f"{name}: r hello without its prior q")
            require(body.get("r") == "hello" and body.get("v") == 1 and
                    body.get("term") == "tern" and nonempty(body.get("ver")),
                    f"{name}: incompatible r hello")
            kinds, features = body.get("kinds"), body.get("features")
            require(isinstance(kinds, list) and "editor" in kinds and
                    isinstance(features, list) and {"edit", "send"} <= set(
                        x for x in features if isinstance(x, str)),
                    f"{name}: negotiated native editor/send capabilities absent")
            require(type(body.get("credits")) is int and body["credits"] > 0,
                    f"{name}: invalid initial credit limit")
            require(type(body.get("apc")) is int and body["apc"] > 0,
                    f"{name}: invalid negotiated APC limit")
            hello = body
            counts["r"] += 1
        elif (direction, verb) == ("out", "o"):
            require(hello is not None, f"{name}: open before successful hello")
            ident = body.get("sf", body.get("id"))
            require(nonempty(ident) and body.get("mode") == "inline",
                    f"{name}: expected real inline surface open")
            require(ident not in opens, f"{name}: repeated surface open in startup capture")
            opens[ident] = {"seq": 0, "acked": 0, "frames": 0, "ids": set()}
            counts["o"] += 1
        elif (direction, verb) == ("out", "f"):
            ident, seq, ops = body.get("sf"), body.get("s"), body.get("ops")
            require(isinstance(ident, str) and ident in opens,
                    f"{name}: frame for unopened surface")
            state = opens[ident]
            require(type(seq) is int and seq == state["seq"] + 1,
                    f"{name}: nonmonotonic per-open frame sequence")
            require(isinstance(ops, list), f"{name}: malformed frame ops")
            for op in ops:
                require(isinstance(op, list) and nonempty(op[0] if op else None),
                        f"{name}: malformed operation")
                if op[0] == "add":
                    require(len(op) == 5, f"{name}: malformed add operation")
                    recursive_ids(op[4], state["ids"], name)
                elif op[0] == "text":
                    # SDK wire Op text has exactly 3 fields [text, nodeId, value].
                    require(len(op) == 3 and nonempty(op[1]) and isinstance(op[2], str),
                            f"{name}: malformed 3-field text operation")
                elif op[0] in ("set", "props", "del", "move", "settle"):
                    require(len(op) >= 2 and nonempty(op[1]),
                            f"{name}: operation lacks target ID")
            state["seq"] = seq
            state["frames"] += 1
            require(state["seq"] - state["acked"] <= hello["credits"],
                    f"{name}: frame credit overrun ({ident})")
            counts["f"] += 1
        elif (direction, verb) == ("in", "e") and body.get("ev") == "ack":
            ident, seq = body.get("sf"), body.get("s")
            require(isinstance(ident, str) and ident in opens,
                    f"{name}: ACK for unopened surface")
            state = opens[ident]
            require(type(seq) is int and state["acked"] < seq <= state["seq"],
                    f"{name}: replayed, regressed or future cumulative ACK")
            state["acked"] = seq
            counts["ack"] += 1
        elif verb in ("q", "r", "o", "f") and direction != {
            "q": "out", "r": "in", "o": "out", "f": "out",
        }[verb]:
            raise ValueError(f"{name}: wrong TSP direction for {verb}")
    require(query is not None and hello is not None and bool(opens) and
            counts["f"] > 0 and counts["ack"] > 0,
            f"{name}: startup q/r/open/frames/cumulative ACK evidence incomplete")
    for ident, state in opens.items():
        require(bool(state["ids"]), f"{name}: surface {ident} has no actual node.id")
        discovered.update(state["ids"])
    return {
        "query_v": query["v"],
        "hello": {key: hello[key] for key in ("v", "term", "ver", "kinds",
                                            "features", "credits", "apc")},
        "counts": counts,
        "per_open": {key: {"frames": state["frames"], "acked": state["acked"],
                           "last_sequence": state["seq"],
                           "semantic_ids": sorted(state["ids"])}
                     for key, state in opens.items()},
        "real_node_ids": sorted(discovered),
    }


def compare(args: argparse.Namespace) -> dict[str, Any]:
    dsh_meta = manifest(args.dsh_manifest, args.dsh)
    peer_meta = manifest(args.peer_manifest, args.peer)
    require(dsh_meta["capture_id"] != peer_meta["capture_id"],
            "duplicate capture ID is not independent live evidence")
    require(file_sha256(args.dsh) != file_sha256(args.peer),
            "identical wire cannot establish an independent application differential")
    require(dsh_meta["tern_version"] == peer_meta["tern_version"] and
            dsh_meta["tern_binary_sha256"] == peer_meta["tern_binary_sha256"],
            "different Tern executable/version: refuse startup differential")
    require(dsh_meta["model_id"] == peer_meta["model_id"],
            "different explicit deterministic model IDs")
    dsh = surface(records(args.dsh), "dsh")
    peer = surface(records(args.peer), "peer")
    differences = []
    if dsh["query_v"] != peer["query_v"] or dsh["hello"] != peer["hello"]:
        differences.append("q/r negotiated protocol/capabilities differ")
    return {
        "scope": "startup-protocol-only-not-edit-send-or-model-parity",
        "tern_version": dsh_meta["tern_version"],
        "tern_binary_sha256": dsh_meta["tern_binary_sha256"],
        "model_id": dsh_meta["model_id"],
        "git_sha": {"dsh": dsh_meta["git_sha"], "peer": peer_meta["git_sha"]},
        "startup": {"dsh": dsh, "peer": peer},
        "differences": differences,
        "pass": not differences,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    for field in ("dsh", "peer", "dsh-manifest", "peer-manifest", "out"):
        p.add_argument("--" + field, type=Path, required=True)
    args = p.parse_args()
    try:
        result = compare(args)
        args.out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with args.out.open("x", encoding="utf-8") as output:
            json.dump(result, output, indent=2, ensure_ascii=False)
            output.write("\n")
        args.out.chmod(0o600)
    except (ValueError, OSError, TypeError, KeyError, json.JSONDecodeError) as error:
        print("startup differential REFUSED: " + str(error), file=sys.stderr)
        return 2
    print(json.dumps({"pass": result["pass"], "differences": result["differences"],
                      "scope": result["scope"]}))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())

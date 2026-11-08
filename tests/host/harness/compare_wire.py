#!/usr/bin/env python3
"""Validate LIVE, no-prompt DSH versus Hermes/OMP TSP startup (not turn parity).

Usage: compare_wire.py --dsh DSH.jsonl --peer PEER.jsonl
  --dsh-manifest DSH-manifest.json --peer-manifest PEER-manifest.json
  --out NEW.json

Inputs are *decoded SDK JSONL* plus provenance manifests; this tool cannot
recover physical APC byte lengths from JSON. Both manifests must attest exact
binary hashes, source SHA, deterministic model ID, initially empty workspace,
independent capture IDs and original wire file SHA256. Refuses replay, missing
or tampered evidence. Verifies offered q versions/program features and selected r, inline open,
actual recursive add-node IDs, per-open frames, cumulative ACK/credit windows,
CLOSE/late ACK and no protocol errors. Does NOT test native edit/send, prompts, model quality,
raw byte framing or functional response parity. Output is created exclusively.
"""
from __future__ import annotations

import argparse
import base64
import binascii
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


def tern_semver(value: Any, origin: str) -> str:
    """Normalize the CLI's 'Tern 0.9.5' versus SDK r.ver '0.9.5'."""
    require(nonempty(value), f"{origin}: Tern version missing")
    match = re.fullmatch(r"(?i)(?:tern\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?)",
                         value.strip())
    require(match is not None, f"{origin}: unrecognized Tern version format")
    return match.group(1)


def read_json(path: Path) -> dict[str, Any]:
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    require(isinstance(value, dict), f"{path}: expected object")
    return value


def manifest(path: Path, wire: Path, require_plugin: bool = False) -> dict[str, Any]:
    data = read_json(path)
    require(data.get("mode") == "live" and data.get("source_kind") == "actual-process",
            f"{path}: replay/remote-only evidence is not a local live process")
    require(data.get("scope") == "startup-no-prompt",
            f"{path}: only explicit startup-no-prompt evidence is comparable")
    require(bool(HEX40.fullmatch(str(data.get("git_sha", "")))),
            f"{path}: exact source SHA missing")
    if require_plugin:
        plugin = data.get("plugin")
        require(isinstance(plugin, dict) and
                bool(HEX40.fullmatch(str(plugin.get("source_sha", "")))) and
                bool(HEX64.fullmatch(str(plugin.get("artifact_sha256", "")))) and
                plugin.get("location") == "local" and
                plugin.get("hash_origin") == "measured-locally",
                f"{path}: independent exact DSH plugin source/artifact required")
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
    allowed = {"q", "r", "o", "f", "e", "x", "b", "error"}
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
                    row.get("verb") in allowed,
                    f"{path}:{line_no}: invalid SDK direction/verb")
            verb, body = row["verb"], row.get("body")
            if verb == "b":
                params = row.get("params")
                require(row["dir"] == "out" and isinstance(body, str) and
                        isinstance(params, dict) and nonempty(params.get("id")) and
                        nonempty(params.get("mime")),
                        f"{path}:{line_no}: invalid SDK blob body/params")
                try:
                    base64.b64decode(body, validate=True)
                except (ValueError, binascii.Error) as error:
                    raise ValueError(f"{path}:{line_no}: malformed blob base64") from error
            else:
                require(isinstance(body, dict),
                        f"{path}:{line_no}: SDK {verb} body must be an object")
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
    counts = {"q": 0, "r": 0, "o": 0, "f": 0, "ack": 0, "b": 0, "x": 0}
    for index, record in enumerate(rows):
        direction, verb, body = record["dir"], record["verb"], record["body"]
        if verb == "error" or (verb == "e" and body.get("ev") == "error"):
            raise ValueError(f"{name}: TSP protocol error at record {index}")
        if (direction, verb) == ("out", "q"):
            require(query is None and hello is None and not opens,
                    f"{name}: repeated/late q hello")
            versions = body.get("v")
            features = body.get("features")
            require(body.get("q") == "hello" and isinstance(versions, list) and
                    versions and all(type(v) is int and v > 0 for v in versions) and
                    len(set(versions)) == len(versions) and nonempty(body.get("app")) and
                    isinstance(body.get("ver"), str) and isinstance(features, list) and
                    all(nonempty(x) for x in features) and
                    {"edit", "undo", "send"} <= set(features),
                    f"{name}: invalid SDK q versions/program editor/send offers")
            query = body
            counts["q"] += 1
        elif (direction, verb) == ("in", "r"):
            require(query is not None and hello is None and not opens,
                    f"{name}: r hello without its prior q")
            require(body.get("r") == "hello" and type(body.get("v")) is int and
                    body["v"] in query["v"] and body.get("term") == "tern" and
                    nonempty(body.get("ver")),
                    f"{name}: incompatible r hello")
            kinds, features = body.get("kinds"), body.get("features")
            require(isinstance(kinds, list) and
                    {"editor", "input"} <= set(x for x in kinds if isinstance(x, str)) and
                    isinstance(features, list) and all(nonempty(x) for x in features),
                    f"{name}: negotiated native editor/input kinds absent")
            # This startup oracle covers the observed Tern credit window (1..2);
            # never silently treat an implausible negotiated window as a pass.
            require(type(body.get("credits")) is int and 1 <= body["credits"] <= 2,
                    f"{name}: invalid startup credit limit (expected 1..2)")
            require(type(body.get("apc")) is int and body["apc"] > 0,
                    f"{name}: invalid negotiated APC limit")
            hello = body
            counts["r"] += 1
        elif (direction, verb) == ("out", "b"):
            require(hello is not None, f"{name}: blob before negotiation")
            counts["b"] += 1
        elif (direction, verb) == ("out", "o"):
            require(hello is not None, f"{name}: open before successful hello")
            ident = body.get("sf", body.get("id"))
            require(nonempty(ident) and body.get("mode") == "inline",
                    f"{name}: expected real inline surface open")
            require(ident not in opens, f"{name}: repeated surface open in startup capture")
            opens[ident] = {
                "seq": 0, "acked": 0, "frames": 0, "ids": set(),
                "closed": False, "close_keep": None,
            }
            counts["o"] += 1
        elif (direction, verb) == ("out", "f"):
            ident, seq, ops = body.get("sf"), body.get("s"), body.get("ops")
            require(isinstance(ident, str) and ident in opens,
                    f"{name}: frame for unopened surface")
            state = opens[ident]
            require(not state["closed"], f"{name}: frame emitted after surface close")
            require(type(seq) is int and seq == state["seq"] + 1,
                    f"{name}: nonmonotonic per-open frame sequence")
            require(isinstance(ops, list), f"{name}: malformed frame ops")
            # @stencil-hq/tern public Op variants, also used by the real SDK
            # retention/credit tests. Inspect exact tuple arity and value types;
            # rejecting unknown tags is deliberate, but focus/null-focus and
            # other documented variants are not "unknown" protocol errors.
            for op in ops:
                require(isinstance(op, list) and bool(op) and nonempty(op[0]),
                        f"{name}: malformed SDK operation")
                tag = op[0]
                if tag == "add":
                    require(len(op) == 5 and nonempty(op[1]) and nonempty(op[2]) and
                            (op[3] is None or nonempty(op[3])) and
                            isinstance(op[4], dict) and op[4].get("id") == op[1],
                            f"{name}: malformed add id/parent/anchor/wire node")
                    recursive_ids(op[4], state["ids"], name)
                elif tag == "text":
                    require(len(op) == 4 and nonempty(op[1]) and
                            op[2] in ("replace", "append") and isinstance(op[3], str),
                            f"{name}: malformed 4-field text operation")
                elif tag == "set":
                    require(len(op) == 3 and nonempty(op[1]) and isinstance(op[2], dict),
                            f"{name}: malformed set props")
                elif tag == "splice":
                    require(len(op) == 5 and nonempty(op[1]) and
                            type(op[2]) is int and op[2] >= 0 and
                            type(op[3]) is int and op[3] >= 0 and isinstance(op[4], str),
                            f"{name}: malformed splice offset/delete/text")
                elif tag == "move":
                    require(len(op) == 4 and nonempty(op[1]) and nonempty(op[2]) and
                            (op[3] is None or nonempty(op[3])),
                            f"{name}: malformed move id/parent/anchor")
                elif tag in ("del", "settle"):
                    require(len(op) == 2 and nonempty(op[1]),
                            f"{name}: malformed {tag} node ID")
                elif tag == "focus":
                    # The native composer in the retained b675 TSP recording
                    # really emits ["focus","dock.composer.line.input"] in frame2;
                    # ["focus",null] is a supported unfocus, not a bad ID.
                    require(len(op) == 2 and (op[1] is None or nonempty(op[1])),
                            f"{name}: malformed focus target (string or null)")
                elif tag == "reveal":
                    require(len(op) == 3 and nonempty(op[1]) and
                            op[2] in ("start", "end", "nearest"),
                            f"{name}: malformed reveal target/alignment")
                elif tag == "scroll":
                    require(len(op) == 3 and nonempty(op[1]) and
                            op[2] in ("line-up", "line-down", "page-up",
                                      "page-down", "start", "end") and
                            "scroll" in hello["features"],
                            f"{name}: malformed scroll direction or unoffered feature")
                elif tag in ("suspend", "resume"):
                    require(len(op) == 1, f"{name}: malformed {tag} operation")
                else:
                    raise ValueError(f"{name}: unsupported SDK operation {tag!r}")
            state["seq"] = seq
            state["frames"] += 1
            require(state["seq"] - state["acked"] <= hello["credits"],
                    f"{name}: frame credit overrun ({ident})")
            counts["f"] += 1
        elif (direction, verb) == ("out", "x"):
            ident = body.get("id", body.get("sf"))
            require(nonempty(ident) and ident in opens and
                    type(body.get("keep")) is bool,
                    f"{name}: malformed or unowned CLOSE")
            state = opens[ident]
            require(not state["closed"], f"{name}: repeated surface CLOSE")
            state["closed"] = True
            state["close_keep"] = body["keep"]
            counts["x"] += 1
        elif (direction, verb) == ("in", "e") and body.get("ev") == "ack":
            ident, seq = body.get("sf"), body.get("s")
            require(isinstance(ident, str) and ident in opens,
                    f"{name}: ACK for unopened surface")
            state = opens[ident]
            # The terminal can drain an already-in-flight ACK after an x CLOSE.
            require(type(seq) is int and state["acked"] < seq <= state["seq"],
                    f"{name}: replayed, regressed or future cumulative ACK")
            state["acked"] = seq
            counts["ack"] += 1
        elif (direction, verb) == ("in", "e"):
            require(nonempty(body.get("ev")),
                    f"{name}: malformed inbound event")
        elif verb in ("q", "r", "o", "f", "x", "b", "e"):
            raise ValueError(f"{name}: wrong TSP direction for {verb}")
    require(query is not None and hello is not None and bool(opens) and
            counts["f"] > 0 and counts["ack"] > 0 and counts["x"] == len(opens),
            f"{name}: complete startup q/r/open/frames/ACK/CLOSE evidence missing")
    for ident, state in opens.items():
        require(bool(state["ids"]), f"{name}: surface {ident} has no actual node.id")
        discovered.update(state["ids"])
    return {
        "query_v": query["v"],
        "hello": {key: hello[key] for key in ("v", "term", "ver", "kinds",
                                            "features", "credits", "apc")},
        "counts": counts,
        "per_open": {
            key: {"frames": state["frames"], "acked": state["acked"],
                  "last_sequence": state["seq"], "closed": state["closed"],
                  "close_keep": state["close_keep"],
                  "semantic_ids": sorted(state["ids"])}
            for key, state in opens.items()
        },
        "real_node_ids": sorted(discovered),
    }


def compare(args: argparse.Namespace) -> dict[str, Any]:
    dsh_meta = manifest(args.dsh_manifest, args.dsh, require_plugin=True)
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
    for label, meta, capture in (("dsh", dsh_meta, dsh), ("peer", peer_meta, peer)):
        require(tern_semver(meta["tern_version"], label + " manifest") ==
                tern_semver(capture["hello"]["ver"], label + " SDK reply"),
                f"{label}: sealed Tern version does not match live r.ver")
    differences = []
    if dsh["query_v"] != peer["query_v"] or dsh["hello"] != peer["hello"]:
        differences.append("q/r negotiated protocol/capabilities differ")
    return {
        "scope": "startup-protocol-only-not-edit-send-or-model-parity",
        "tern_version": dsh_meta["tern_version"],
        "tern_binary_sha256": dsh_meta["tern_binary_sha256"],
        "model_id": dsh_meta["model_id"],
        "git_sha": {"dsh": dsh_meta["git_sha"], "peer": peer_meta["git_sha"]},
        "dsh_plugin": dsh_meta["plugin"],
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

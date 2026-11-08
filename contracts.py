"""Contract v1 seams (schemas in contracts/). Stdlib only: the plugin has no runtime dependencies.

Schema validators for adapter/pack manifests and the game context, the library SQL, and the registry
(discover_adapters, discover_packs, match_file, scan_library) per CONTRACTS §1, §4, §5, §9.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import zipfile
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

CONTRACT = 1
_HERE = Path(__file__).resolve().parent
_CONTRACTS = _HERE / "contracts"

LIBRARY_SQL = (_CONTRACTS / "library.sql").read_text(encoding="utf-8")


def _load_schema(name: str) -> dict:
    return json.loads((_CONTRACTS / name).read_text(encoding="utf-8"))


# ---------- minimal JSON Schema (the subset our three schemas use) ----------

_TYPES = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool, "null": type(None)}


def _type_ok(value: Any, t: str) -> bool:
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    return isinstance(value, _TYPES[t])


def _check(value: Any, schema: dict, path: str, errors: list[str]) -> None:
    where = path or "$"
    if "const" in schema and value != schema["const"]:
        errors.append(f"{where}: must be {schema['const']!r}")
        return
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{where}: {value!r} not one of {schema['enum']}")
        return
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            errors.append(f"{where}: expected {'/'.join(types)}")
            return
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: too short")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{where}: {value!r} does not match {schema['pattern']}")
    if isinstance(value, int) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{where}: below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{where}: above {schema['maximum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: needs at least {schema['minItems']} item(s)")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{where}: items must be unique")
        if "items" in schema:
            for i, item in enumerate(value):
                _check(item, schema["items"], f"{where}[{i}]", errors)
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{where}: needs at least {schema['minProperties']} key(s)")
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{where}.{key}: required")
        for key, item in value.items():
            if key in props:
                _check(item, props[key], f"{where}.{key}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where}.{key}: unknown key")
            elif isinstance(schema.get("additionalProperties"), dict):
                _check(item, schema["additionalProperties"], f"{where}.{key}", errors)
    for rule in schema.get("allOf", []):
        cond = rule.get("if")
        if cond is not None and not _matches(value, cond):
            continue
        _check(value, rule.get("then", rule), path, errors)


def _matches(value: Any, schema: dict) -> bool:
    errs: list[str] = []
    _check(value, schema, "", errs)
    return not errs


def _validator(schema_name: str):
    schema = _load_schema(schema_name)

    def validate(obj: Any) -> list[str]:
        errors: list[str] = []
        _check(obj, schema, "", errors)
        return errors

    return validate


validate_adapter_manifest = _validator("adapter-manifest.schema.json")
validate_pack_manifest = _validator("pack-manifest.schema.json")
validate_game_context = _validator("game-context.schema.json")


# ---------- registry types (fixed) ----------

@dataclass(frozen=True)
class Adapter:
    id: str
    path: Path
    manifest: dict


@dataclass(frozen=True)
class Pack:
    id: str
    path: Path
    manifest: dict


@dataclass(frozen=True)
class Match:
    adapter: str
    system: str
    path: Path
    inner: str | None
    code: str | None
    header_title: str | None


@dataclass
class ScanReport:
    titles: int = 0
    unsupported: dict[str, int] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)   # "path: reason"


# ---------- registry (CONTRACTS §1, §4, §5, §9) ----------

_log = logging.getLogger("emulator_catalog.contracts")
HEADER_READ_MAX = 64 * 1024  # §9: never read more than this from a file's header


def _claims(adapters: list[Adapter]) -> list[tuple[Adapter, dict]]:
    """(adapter, system) pairs in claim order: higher priority first, then alphabetical adapter id."""
    ordered = sorted(adapters, key=lambda a: (-int(a.manifest.get("priority", 0)), a.id))
    return [(a, s) for a in ordered for s in a.manifest["systems"]]


def _claimed(ext: str, adapters: list[Adapter]) -> bool:
    return any(ext in s["extensions"] for _, s in _claims(adapters))


def _header_ok(head: bytes, header: dict | None) -> bool:
    if not header:
        return True
    want = bytes.fromhex(header["hex"])
    return head[header["offset"]:header["offset"] + len(want)] == want


def _ascii_field(head: bytes, spec: dict | None) -> str | None:
    if not spec:
        return None
    raw = head[spec["offset"]:spec["offset"] + spec["length"]]
    return raw.decode("ascii", errors="ignore").strip("\x00 ") or None


def _match_head(head: bytes, ext: str, path: Path, inner: str | None, adapters: list[Adapter]) -> Match | None:
    for adapter, system in _claims(adapters):
        if ext in system["extensions"] and _header_ok(head, system.get("header")):
            return Match(adapter=adapter.id, system=system["id"], path=path, inner=inner,
                         code=_ascii_field(head, system.get("codeAt")),
                         header_title=_ascii_field(head, system.get("titleAt")))
    return None


def _log_conflicts(adapters: list[Adapter]) -> None:
    owners: dict[str, list[str]] = {}
    for a in adapters:
        for s in a.manifest["systems"]:
            owners.setdefault(s["id"], []).append(a.id)
    for system_id, ids in owners.items():
        if len(ids) > 1:
            _log.warning("system %s is claimed by %s; the highest priority wins", system_id, ", ".join(ids))


def discover_adapters(root: Path) -> list[Adapter]:
    """CONTRACTS §1. Every adapters/<id>/manifest.json that validates and whose id == folder name, sorted by id.
    Invalid folders are logged and skipped, never raised."""
    found: list[Adapter] = []
    root = Path(root)
    if not root.is_dir():
        return found
    for sub in sorted(root.iterdir()):
        if not sub.is_dir():
            continue
        mf = sub / "manifest.json"
        if not mf.is_file():
            _log.info("adapter %s skipped: no manifest.json", sub.name)
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            _log.warning("adapter %s skipped: %s", sub.name, exc)
            continue
        errors = validate_adapter_manifest(m)
        if errors:
            _log.warning("adapter %s skipped: %s", sub.name, "; ".join(errors))
            continue
        if m["id"] != sub.name:
            _log.warning("adapter %s skipped: id %r does not match the folder name", sub.name, m["id"])
            continue
        found.append(Adapter(id=m["id"], path=sub, manifest=m))
    found.sort(key=lambda a: a.id)
    _log_conflicts(found)
    return found


def discover_packs(root: Path, adapters: list[Adapter]) -> list[Pack]:
    """CONTRACTS §4. Valid packs/<id>/manifest.json whose adapter is in `adapters`."""
    root = Path(root)
    if not root.is_dir():
        return []
    installed = {a.id for a in adapters}
    out: list[Pack] = []
    for sub in sorted(root.iterdir()):
        mf = sub / "manifest.json"
        if not sub.is_dir() or not mf.is_file():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            _log.warning("pack %s skipped: %s", sub.name, exc)
            continue
        errors = validate_pack_manifest(m)
        if errors:
            _log.warning("pack %s skipped: %s", sub.name, "; ".join(errors))
            continue
        if m["id"] != sub.name:
            _log.warning("pack %s skipped: id %r does not match the folder name", sub.name, m["id"])
            continue
        if m["adapter"] not in installed:
            _log.info("pack %s skipped: adapter %s is not installed", sub.name, m["adapter"])
            continue
        out.append(Pack(id=m["id"], path=sub, manifest=m))
    return sorted(out, key=lambda p: p.id)


def match_file(path: Path, adapters: list[Adapter]) -> Match | None:
    """CONTRACTS §1 matching. Reads at most 64 KB of header; zips are read in memory (never extracted)."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext == ".zip":
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                inner_ext = PurePosixPath(info.filename).suffix.lower()
                if info.is_dir() or not _claimed(inner_ext, adapters):
                    continue
                with z.open(info) as fh:
                    return _match_head(fh.read(HEADER_READ_MAX), inner_ext, path, info.filename, adapters)
        return None
    if not _claimed(ext, adapters):
        return None  # unclaimed files are never opened
    with path.open("rb") as fh:
        return _match_head(fh.read(HEADER_READ_MAX), ext, path, None, adapters)


def _game_bytes(m: Match) -> bytes:
    if m.inner is None:
        return Path(m.path).read_bytes()
    with zipfile.ZipFile(m.path) as z:
        return z.read(m.inner)


def _pack_for(m: Match, digest: str, packs: list[Pack]) -> str | None:
    for p in packs:
        if p.manifest["adapter"] != m.adapter:
            continue
        rule = p.manifest["match"]
        if m.code and m.code in rule.get("codes", []):
            return p.id
        if digest in rule.get("sha1", []):
            return p.id
    return None


def scan_library(db, roots: list[Path], adapters: list[Adapter], packs: list[Pack]) -> ScanReport:
    """CONTRACTS §5. Read-only on user files. Upserts roots/titles/unsupported; marks vanished titles missing.
    .sav files are skipped entirely: never opened, read or hashed, and not counted as unsupported."""
    report = ScanReport()
    now = datetime.now(timezone.utc).isoformat()
    all_seen: set[str] = set()
    for root in roots:
        root = Path(root)
        db.execute("INSERT INTO roots(path, kind, added_at, scanned_at) VALUES (?, 'folder', ?, ?) "
                   "ON CONFLICT(path) DO UPDATE SET scanned_at = excluded.scanned_at", (str(root), now, now))
        root_id = db.execute("SELECT id FROM roots WHERE path = ?", (str(root),)).fetchone()[0]
        seen: set[str] = set()
        unsupported: dict[str, int] = {}
        if root.is_dir():
            for f in sorted(root.iterdir()):
                ext = f.suffix.lower()
                if ext == ".sav" or not f.is_file():
                    continue
                try:
                    m = match_file(f, adapters)
                    if m is None:
                        unsupported[ext] = unsupported.get(ext, 0) + 1
                        continue
                    data = _game_bytes(m)
                except (OSError, zipfile.BadZipFile, KeyError) as exc:
                    report.skipped.append(f"{f}: {exc}")
                    continue
                digest = hashlib.sha1(data).hexdigest()
                tid = digest[:16]
                db.execute(
                    "INSERT INTO titles (id, root_id, path, inner, name, system, adapter, code, header_title, pack, "
                    "size, seen_at, missing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0) "
                    "ON CONFLICT(id) DO UPDATE SET root_id=excluded.root_id, path=excluded.path, inner=excluded.inner, "
                    "name=excluded.name, system=excluded.system, adapter=excluded.adapter, code=excluded.code, "
                    "header_title=excluded.header_title, pack=excluded.pack, size=excluded.size, "
                    "seen_at=excluded.seen_at, missing=0",
                    (tid, root_id, str(m.path), m.inner, m.path.stem, m.system, m.adapter, m.code,
                     m.header_title, _pack_for(m, digest, packs), len(data), now))
                seen.add(tid)
        else:
            report.skipped.append(f"{root}: not a folder")
        present = {r[0] for r in db.execute("SELECT id FROM titles WHERE root_id = ?", (root_id,))}
        for tid in present - seen:
            db.execute("UPDATE titles SET missing = 1 WHERE id = ?", (tid,))
        db.execute("DELETE FROM unsupported WHERE root_id = ?", (root_id,))
        db.executemany("INSERT INTO unsupported(root_id, ext, count) VALUES (?,?,?)",
                       [(root_id, e, c) for e, c in unsupported.items()])
        for e, c in unsupported.items():
            report.unsupported[e] = report.unsupported.get(e, 0) + c
        all_seen |= seen
    db.commit()
    report.titles = len(all_seen)
    return report

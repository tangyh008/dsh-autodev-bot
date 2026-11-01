#!/usr/bin/env python3
"""Rebuild the five DevBot Agent presets from DSH's standard preset.

Why this exists
---------------
The Web profile disables the deployment-global tool rows and expects every
session preset to declare its own tools (see
`packages/bundle/web-app/cordis.patch.yml`: "Web surface disables them here and
lets each session mount a preset instead"). DevBot presets that declare only
`persona` + `tool-fs` therefore leave their Agent with read-only fs tools and no
bash/write/skill/web surface, which blocks every real delivery.

This script copies the standard preset's plugin list verbatim, keeps DevBot's
own role persona rows (the source of truth stays this repository), replaces the
standard `tool-fs` row with a full read/write/edit row, and drops the plugin
installer rows (a DevBot role must not install host plugins on its own).

Run after a DSH upgrade or when role personas change:

    python3 scripts/sync-presets.py          # writes cordis.patch.yml in place
    DSH_CHECKOUT=/path/to/deepseek-harness python3 scripts/sync-presets.py

The generated region is delimited in `cordis.patch.yml` by the BEGIN/END
comments; everything outside it is preserved.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PATCH_FILE = REPO_ROOT / "cordis.patch.yml"
DSH_CHECKOUT = os.environ.get("DSH_CHECKOUT")
if not DSH_CHECKOUT:
    sys.exit("需要 DSH_CHECKOUT 环境变量指向 deepseek-harness checkout")
DSH_CHECKOUT = Path(DSH_CHECKOUT)
STANDARD_PATCH = DSH_CHECKOUT / "packages/bundle/web-app/presets/standard.patch.yml"

BEGIN = "# BEGIN GENERATED devbot presets (scripts/sync-presets.py) — do not edit by hand"
END = "# END GENERATED devbot presets"

PRESET_ROW = re.compile(r"^    - id: preset-devbot-(?P<role>[a-z]+)$")
PLUGIN_ROW = re.compile(r"^          - id: (?P<id>[a-z0-9-]+)$")
HEADER_FIELD = re.compile(r"^        (?P<key>id|name|description|order):")

# Standard-preset plugin ids intentionally excluded from DevBot roles.
DROP_PLUGIN_IDS = {"tool-plugin-manager", "tool-plugin-market"}

FS_ROW = """\
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              read: true
              readImage: true
              write: true
              edit: true
""".splitlines()


def read_lines(path: Path) -> list[str]:
    if not path.is_file():
        sys.exit(f"missing input: {path}")
    return path.read_text(encoding="utf-8").splitlines()


def split_plugin_chunks(lines: list[str], plugins_at: int) -> list[tuple[str, list[str]]]:
    """Split the plugin list that starts after `plugins_at` into (id, raw lines)."""
    chunks: list[tuple[str, list[str]]] = []
    current_id: str | None = None
    current: list[str] = []
    for line in lines[plugins_at + 1:]:
        match = PLUGIN_ROW.match(line)
        if match is not None:
            if current_id is not None:
                chunks.append((current_id, current))
            current_id = match.group("id")
            current = [line]
            continue
        if current_id is not None:
            current.append(line)
    if current_id is not None:
        chunks.append((current_id, current))
    # Trim trailing blank lines that belong to the file, not the last row.
    while chunks and chunks[-1][1] and chunks[-1][1][-1].strip() == "":
        chunks[-1][1].pop()
    return chunks


def standard_plugins() -> list[tuple[str, list[str]]]:
    lines = read_lines(STANDARD_PATCH)
    plugins_at = next((i for i, line in enumerate(lines) if line == "        plugins:"), None)
    if plugins_at is None:
        sys.exit(f"standard preset has no plugins: block: {STANDARD_PATCH}")
    chunks = split_plugin_chunks(lines, plugins_at)
    ids = [chunk_id for chunk_id, _ in chunks]
    for required in ("persona", "tool-fs"):
        if required not in ids:
            sys.exit(f"standard preset lost its {required!r} row: {ids}")
    return chunks


def parse_devbot_presets(lines: list[str]) -> list[dict[str, object]]:
    starts = [i for i, line in enumerate(lines) if PRESET_ROW.match(line)]
    if not starts:
        sys.exit("cordis.patch.yml has no preset-devbot-* rows")
    presets: list[dict[str, object]] = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(lines)
        block = lines[start:end]
        while block and block[-1].strip() == "":
            block.pop()
        header: dict[str, str] = {}
        plugins_at = None
        for offset, line in enumerate(block):
            if line == "        plugins:":
                plugins_at = offset
                break
            field = HEADER_FIELD.match(line)
            if field is not None:
                header[field.group("key")] = line
        if plugins_at is None or header.get("id") is None:
            sys.exit(f"malformed preset block: {' '.join(block[:1])}")
        chunks = split_plugin_chunks(block, plugins_at)
        persona = [raw for chunk_id, raw in chunks if chunk_id == "persona"]
        if not persona:
            sys.exit(f"preset row {block[0].strip()} has no persona")
        header["row_id"] = block[0]
        header["role"] = PRESET_ROW.match(block[0]).group("role")  # short role, e.g. lead
        presets.append({"header": header, "persona": persona[0]})
    return presets


def build_preset(preset: dict[str, object], std: list[tuple[str, list[str]]]) -> list[str]:
    header = preset["header"]  # type: ignore[assignment]
    out: list[str] = [header["row_id"]]  # type: ignore[index]
    out.append("      name: '@deepseek-ai/dsh-agent-preset'")
    out.append("      config:")
    out.append(header["id"])  # type: ignore[index]
    if not header["id"].strip().startswith("id: devbot-"):
        sys.exit(f"preset id line lost its value: {header['id']!r}")
    out.append(header["name"])  # type: ignore[index]
    out.append(header["description"])  # type: ignore[index]
    out.append(header["order"])  # type: ignore[index]
    out.append("        plugins:")
    out.extend(preset["persona"])  # type: ignore[arg-type]
    for chunk_id, raw in std:
        if chunk_id == "persona":
            continue
        if chunk_id == "tool-fs":
            out.extend(FS_ROW)
            continue
        if chunk_id in DROP_PLUGIN_IDS:
            continue
        out.extend(raw)
    return out


def main() -> None:
    std = standard_plugins()
    lines = read_lines(PATCH_FILE)

    # Preserve everything before the first preset row, including its comments,
    # but drop markers from a previous run so the script is idempotent.
    first_preset = next(i for i, line in enumerate(lines) if PRESET_ROW.match(line))
    head = [line for line in lines[:first_preset] if line not in (BEGIN, END)]
    while head and head[-1].strip() == "":
        head.pop()
    if head[-1].strip() != "":
        head.append("")

    presets = parse_devbot_presets(lines)
    generated: list[str] = [BEGIN]
    for preset in presets:
        generated.extend(build_preset(preset, std))
        generated.append("")
    generated[-1] = END
    generated.append("")

    PATCH_FILE.write_text("\n".join(head + generated) + "\n", encoding="utf-8")
    print(f"rebuilt {len(presets)} presets from {STANDARD_PATCH}")
    print(f"standard rows copied: {len(std)}; dropped: {', '.join(sorted(DROP_PLUGIN_IDS))}")


if __name__ == "__main__":
    main()

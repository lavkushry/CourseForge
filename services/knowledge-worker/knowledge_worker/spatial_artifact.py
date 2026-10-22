"""Build one explorable 3D scene from a single spatial candidate.

The scene is a glTF of labeled boxes plus a scene graph. Every node label has
to be supported by that candidate's OCR, transcript, or concept text. This
module is not imported by the indexing pipeline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

_TOKEN = re.compile(r"[a-z0-9]+")
_SLUG = re.compile(r"[^a-z0-9]+")


class SpatialArtifactError(ValueError):
    """The candidate cannot be turned into a scene without inventing labels."""


@dataclass(frozen=True)
class SceneNode:
    label: str
    parent: str | None
    concept_id: str
    translation: tuple[float, float, float]
    scale: tuple[float, float, float]
    color: tuple[float, float, float, float]


def slugify(title: str) -> str:
    """Match knowledge.slugify: lowercase, non-alnum to hyphens, max 80."""
    slug = _SLUG.sub("-", title.lower().strip()).strip("-")
    if not slug:
        slug = "concept"
    return slug[:80]


def concept_id_for(lecture_id: str, label: str) -> str:
    """Stable id for one source label. Not a row in knowledge_concepts."""
    digest = hashlib.sha256(f"{lecture_id}:{slugify(label)}".encode("utf-8")).hexdigest()[:16]
    return f"kco_{digest}"


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def label_supported(label: str, evidence: str) -> bool:
    """True when every word of label appears, in order, in the evidence."""
    need = _tokens(label)
    if not need:
        return False
    found = 0
    for token in _tokens(evidence):
        if token == need[found]:
            found += 1
            if found == len(need):
                return True
    return False


def evidence_text(candidate: dict[str, Any]) -> str:
    parts = [
        str(candidate.get("ocr_snippet") or ""),
        str(candidate.get("vision_snippet") or ""),
        str(candidate.get("screen_text") or ""),
    ]
    extra = candidate.get("evidence")
    if isinstance(extra, list):
        parts.extend(str(item) for item in extra)
    return "\n".join(part for part in parts if part.strip())


def _require_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SpatialArtifactError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise SpatialArtifactError(f"{field} must be an integer millisecond timestamp or null")
    if value < 0:
        raise SpatialArtifactError(f"{field} must be >= 0")
    return value


def _parse_nodes(candidate: dict[str, Any], lecture_id: str, evidence: str) -> list[dict[str, Any]]:
    raw_nodes = candidate.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise SpatialArtifactError("nodes must list the labels to place, each supported by the evidence")
    declared = candidate.get("concept_ids")
    if declared is not None and not isinstance(declared, list):
        raise SpatialArtifactError("concept_ids must be a list of strings")
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_nodes:
        if not isinstance(item, dict):
            raise SpatialArtifactError("each node must be an object")
        label = _require_str(item.get("label"), "node.label")
        if label in seen:
            raise SpatialArtifactError(f"duplicate label {label!r}")
        seen.add(label)
        if not label_supported(label, evidence):
            raise SpatialArtifactError(f"label {label!r} is not supported by the candidate evidence")
        parent = item.get("parent")
        if parent is not None:
            parent = _require_str(parent, "node.parent")
        concept_id = item.get("concept_id")
        if concept_id is None or concept_id == "":
            concept_id = concept_id_for(lecture_id, label)
        else:
            concept_id = _require_str(concept_id, "node.concept_id")
        expected = concept_id_for(lecture_id, label)
        if concept_id != expected:
            raise SpatialArtifactError(
                f"concept id {concept_id!r} does not match the lecture label {label!r}"
            )
        parsed.append({"label": label, "parent": parent, "concept_id": concept_id})
    labels = {node["label"] for node in parsed}
    for node in parsed:
        parent = node["parent"]
        if parent is None:
            continue
        if parent not in labels:
            raise SpatialArtifactError(f"parent {parent!r} is not a label in this scene")
        if parent == node["label"]:
            raise SpatialArtifactError(f"label {parent!r} cannot parent itself")
    _reject_cycles(parsed)
    if declared is not None:
        got = [node["concept_id"] for node in parsed]
        if list(declared) != got:
            raise SpatialArtifactError("concept_ids must match the node concept ids in order")
    return parsed


def _reject_cycles(nodes: Sequence[dict[str, Any]]) -> None:
    parent_of = {node["label"]: node["parent"] for node in nodes}
    for label in parent_of:
        seen: set[str] = set()
        current: str | None = label
        while current is not None:
            if current in seen:
                raise SpatialArtifactError(f"parent cycle includes {label!r}")
            seen.add(current)
            current = parent_of.get(current)


def _layout(nodes: Sequence[dict[str, Any]]) -> list[SceneNode]:
    children: dict[str, list[dict[str, Any]]] = {node["label"]: [] for node in nodes}
    roots: list[dict[str, Any]] = []
    for node in nodes:
        parent = node["parent"]
        if parent is None:
            roots.append(node)
        else:
            children[parent].append(node)
    sizes: dict[str, tuple[float, float, float]] = {}

    def measure(label: str) -> tuple[float, float, float]:
        kids = children[label]
        if not kids:
            width = max(1.6, min(4.4, 0.34 * len(label) + 0.8))
            sizes[label] = (width, 0.9, 0.75)
            return sizes[label]
        measured = [measure(kid["label"]) for kid in kids]
        gap = 0.18
        pad_x = 0.42
        pad_y = 0.62
        pad_z = 0.4
        width = sum(item[0] for item in measured) + gap * (len(measured) - 1) + 2 * pad_x
        height = max(item[1] for item in measured) + pad_y
        depth = max(item[2] for item in measured) + pad_z
        sizes[label] = (round(width, 4), round(height, 4), round(depth, 4))
        return sizes[label]

    for root in roots:
        measure(root["label"])

    placed: dict[str, tuple[float, float, float]] = {}

    def place(label: str, center: tuple[float, float, float]) -> None:
        placed[label] = tuple(round(axis, 4) for axis in center)  # type: ignore[assignment]
        kids = children[label]
        if not kids:
            return
        gap = 0.18
        total = sum(sizes[kid["label"]][0] for kid in kids) + gap * (len(kids) - 1)
        cursor = center[0] - total / 2
        parent_size = sizes[label]
        for kid in kids:
            kid_size = sizes[kid["label"]]
            child_center = (
                cursor + kid_size[0] / 2,
                center[1] - (parent_size[1] - kid_size[1]) / 2 + 0.12,
                center[2] + (parent_size[2] - kid_size[2]) / 2 - 0.08,
            )
            place(kid["label"], child_center)
            cursor += kid_size[0] + gap

    span = sum(sizes[root["label"]][0] for root in roots) + 0.8 * (len(roots) - 1)
    cursor = -span / 2
    for root in roots:
        root_size = sizes[root["label"]]
        place(root["label"], (cursor + root_size[0] / 2, 0.0, 0.0))
        cursor += root_size[0] + 0.8

    palette = (
        (0.18, 0.36, 0.56, 0.55),
        (0.16, 0.48, 0.46, 0.62),
        (0.45, 0.36, 0.18, 0.7),
        (0.55, 0.28, 0.22, 0.78),
        (0.36, 0.28, 0.48, 0.84),
    )
    depth_of: dict[str, int] = {}

    def depth(label: str) -> int:
        if label in depth_of:
            return depth_of[label]
        parent = next(node["parent"] for node in nodes if node["label"] == label)
        depth_of[label] = 0 if parent is None else depth(parent) + 1
        return depth_of[label]

    scene: list[SceneNode] = []
    for node in nodes:
        label = node["label"]
        scene.append(
            SceneNode(
                label=label,
                parent=node["parent"],
                concept_id=node["concept_id"],
                translation=placed[label],
                scale=sizes[label],
                color=palette[depth(label) % len(palette)],
            )
        )
    return scene


def _cube_blob() -> tuple[bytes, int, int]:
    positions = [
        -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
        -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]
    indices = [
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
        2, 6, 7, 2, 7, 3, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
    ]
    pos = struct.pack(f"<{len(positions)}f", *positions)
    idx = struct.pack(f"<{len(indices)}H", *indices)
    return pos + idx, len(pos), len(indices)


def _gltf_document(scene: Sequence[SceneNode], lecture_id: str) -> tuple[dict[str, Any], bytes]:
    blob, pos_len, index_count = _cube_blob()
    meshes = []
    materials = []
    nodes = []
    for index, node in enumerate(scene):
        materials.append(
            {
                "name": node.label,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [round(channel, 4) for channel in node.color],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.8,
                },
                "alphaMode": "BLEND",
                "doubleSided": True,
            }
        )
        meshes.append(
            {
                "name": node.label,
                "primitives": [
                    {
                        "attributes": {"POSITION": 0},
                        "indices": 1,
                        "material": index,
                    }
                ],
            }
        )
        nodes.append(
            {
                "name": node.label,
                "mesh": index,
                "translation": list(node.translation),
                "scale": list(node.scale),
                "extras": {
                    "concept_id": node.concept_id,
                    "parent": node.parent,
                    "lecture_id": lecture_id,
                },
            }
        )
    document = {
        "asset": {
            "version": "2.0",
            "generator": "courseforge-spatial-artifact",
            "extras": {"lecture_id": lecture_id},
        },
        "scene": 0,
        "scenes": [{"name": lecture_id, "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": pos_len, "target": 34962},
            {"buffer": 0, "byteOffset": pos_len, "byteLength": len(blob) - pos_len, "target": 34963},
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 8,
                "type": "VEC3",
                "min": [-0.5, -0.5, -0.5],
                "max": [0.5, 0.5, 0.5],
            },
            {
                "bufferView": 1,
                "componentType": 5123,
                "count": index_count,
                "type": "SCALAR",
            },
        ],
    }
    return document, blob


def _glb(document: dict[str, Any], blob: bytes) -> bytes:
    json_bytes = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    blob += b"\x00" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    header = struct.pack("<4sII", b"glTF", 2, total)
    json_chunk = struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
    bin_chunk = struct.pack("<I4s", len(blob), b"BIN\x00") + blob
    return header + json_chunk + bin_chunk


def glb_json(data: bytes) -> dict[str, Any]:
    """Read the JSON chunk from a GLB this module wrote."""
    if data[:4] != b"glTF":
        raise SpatialArtifactError("not a glTF binary")
    length = struct.unpack_from("<I", data, 8)[0]
    if length != len(data):
        raise SpatialArtifactError("glTF length does not match the file")
    offset = 12
    chunk_len, chunk_type = struct.unpack_from("<I4s", data, offset)
    if chunk_type != b"JSON":
        raise SpatialArtifactError("glTF JSON chunk missing")
    raw = data[offset + 8 : offset + 8 + chunk_len].rstrip(b" ")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise SpatialArtifactError("glTF JSON chunk must be an object")
    return parsed


def _scene_payload(scene: Sequence[SceneNode], provenance: dict[str, Any]) -> dict[str, Any]:
    return {
        "lecture_id": provenance["lecture_id"],
        "lecture_title": provenance["lecture_title"],
        "labels": [node.label for node in scene],
        "nodes": [
            {
                "label": node.label,
                "parent": node.parent,
                "concept_id": node.concept_id,
                "translation": list(node.translation),
                "scale": list(node.scale),
                "color": [round(channel, 4) for channel in node.color],
            }
            for node in scene
        ],
    }


def _viewer_html(scene_payload: dict[str, Any], provenance: dict[str, Any]) -> str:
    scene_json = json.dumps(scene_payload, ensure_ascii=False).replace("<", "\\u003c")
    labels = "".join(f"<li>{_html(label)}</li>" for label in provenance["labels"])
    start = provenance["start_ms"]
    end = provenance["end_ms"]
    time_line = (
        f"{start} ms – {end} ms"
        if start is not None and end is not None
        else _html(str(provenance["time_note"]))
    )
    title = _html(str(provenance["lecture_title"] or provenance["lecture_id"]))
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — spatial scene</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; font: 15px/1.4 system-ui, sans-serif; background: #090e19; color: #e7eef8; }}
  header, aside {{ padding: 16px 20px; }}
  header {{ border-bottom: 1px solid #243044; }}
  h1 {{ font-size: 18px; margin: 0 0 6px; }}
  p {{ margin: 4px 0; color: #b7c3d6; }}
  main {{ display: grid; grid-template-columns: minmax(0, 1fr) 280px; min-height: calc(100vh - 92px); }}
  canvas {{ width: 100%; height: 100%; display: block; background: #0c1422; touch-action: none; }}
  aside {{ border-left: 1px solid #243044; }}
  img {{ width: 100%; border-radius: 8px; background: #000; }}
  ul {{ padding-left: 18px; }}
  code {{ color: #f2d2c4; }}
  @media (max-width: 800px) {{
    main {{ grid-template-columns: 1fr; }}
    canvas {{ height: 70vh; }}
    aside {{ border-left: 0; border-top: 1px solid #243044; }}
  }}
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <p>Lecture <code>__LECTURE_ID__</code></p>
  <p>__TIME_LINE__</p>
  <p>Drag to rotate. Scroll to zoom.</p>
</header>
<main>
  <canvas id="scene" width="960" height="640"></canvas>
  <aside>
    <p>Keyframe</p>
    <img src="__KEYFRAME__" alt="Lecture keyframe">
    <p>Labels in this scene</p>
    <ul>__LABELS__</ul>
  </aside>
</main>
<script>
const SCENE = __SCENE_JSON__;
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
let rotY = -0.55;
let rotX = 0.42;
let dist = 1;
function resize() {{
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(2, Math.floor(rect.width * dpr));
  canvas.height = Math.max(2, Math.floor(rect.height * dpr));
  draw();
}}
function project(x, y, z) {{
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y1 = y * cx - z1 * sx;
  const z2 = y * sx + z1 * cx;
  const f = 8 / (8 + z2 / dist);
  return [canvas.width / 2 + x1 * f * 42 * dist, canvas.height / 2 - y1 * f * 42 * dist, z2];
}}
function draw() {{
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const faces = [];
  for (const node of SCENE.nodes) {{
    const [tx, ty, tz] = node.translation;
    const [sx, sy, sz] = node.scale;
    const corners = [];
    for (const xi of [-0.5, 0.5]) {{
      for (const yi of [-0.5, 0.5]) {{
        for (const zi of [-0.5, 0.5]) {{
          corners.push(project(tx + xi * sx, ty + yi * sy, tz + zi * sz));
        }}
      }}
    }}
    const quads = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
    for (const quad of quads) {{
      const pts = quad.map((index) => corners[index]);
      const depth = pts.reduce((sum, pt) => sum + pt[2], 0) / pts.length;
      faces.push({{ pts, depth, color: node.color, label: node.label, anchor: project(tx, ty + sy / 2, tz) }});
    }}
  }}
  faces.sort((a, b) => b.depth - a.depth);
  const labeled = new Set();
  for (const face of faces) {{
    ctx.beginPath();
    face.pts.forEach((pt, index) => index ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1]));
    ctx.closePath();
    const [r, g, b, a] = face.color;
    ctx.fillStyle = `rgba(${{Math.round(r*255)}},${{Math.round(g*255)}},${{Math.round(b*255)}},${{a}})`;
    ctx.strokeStyle = "rgba(231,238,248,0.55)";
    ctx.lineWidth = 1.25;
    ctx.fill();
    ctx.stroke();
    if (!labeled.has(face.label)) {{
      labeled.add(face.label);
      ctx.fillStyle = "#f7fbff";
      ctx.font = `${{Math.max(12, Math.round(canvas.width / 70))}}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(face.label, face.anchor[0], face.anchor[1]);
    }}
  }}
}}
let drag = null;
canvas.addEventListener("pointerdown", (event) => {{
  drag = {{ x: event.clientX, y: event.clientY, rotY, rotX }};
  canvas.setPointerCapture(event.pointerId);
}});
canvas.addEventListener("pointermove", (event) => {{
  if (!drag) return;
  rotY = drag.rotY + (event.clientX - drag.x) * 0.008;
  rotX = Math.max(-1.2, Math.min(1.2, drag.rotX + (event.clientY - drag.y) * 0.008));
  draw();
}});
canvas.addEventListener("pointerup", () => {{ drag = null; }});
canvas.addEventListener("wheel", (event) => {{
  event.preventDefault();
  dist = Math.max(0.45, Math.min(2.4, dist * (event.deltaY > 0 ? 0.92 : 1.08)));
  draw();
}}, {{ passive: false }});
window.addEventListener("resize", resize);
resize();
</script>
</body>
</html>
"""
    html = html.replace("{{", "{").replace("}}", "}")
    return (
        html.replace("__TITLE__", title)
        .replace("__LECTURE_ID__", _html(str(provenance["lecture_id"])))
        .replace("__TIME_LINE__", time_line)
        .replace("__KEYFRAME__", _html(str(provenance["keyframe_path"])))
        .replace("__LABELS__", labels)
        .replace("__SCENE_JSON__", scene_json)
    )


def _html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def generate_artifact(
    candidate: dict[str, Any],
    out_dir: Path,
    *,
    keyframe_file: Path | None = None,
) -> dict[str, Any]:
    """Write a GLB, scene graph, provenance, and a standalone viewer."""
    if not isinstance(candidate, dict):
        raise SpatialArtifactError("candidate must be a JSON object")
    lecture_id = _require_str(candidate.get("lecture_id"), "lecture_id")
    evidence = evidence_text(candidate)
    if not evidence.strip():
        raise SpatialArtifactError("candidate has no OCR, vision, or transcript evidence")
    nodes = _parse_nodes(candidate, lecture_id, evidence)
    scene = _layout(nodes)
    start_ms = _optional_int(candidate.get("start_ms"), "start_ms")
    end_ms = _optional_int(candidate.get("end_ms"), "end_ms")
    keyframe_time_ms = _optional_int(candidate.get("keyframe_time_ms"), "keyframe_time_ms")
    if start_ms is not None and end_ms is not None and end_ms < start_ms:
        raise SpatialArtifactError("end_ms is earlier than start_ms")
    out_dir.mkdir(parents=True, exist_ok=True)
    keyframe_name = "keyframe"
    if keyframe_file is not None:
        if not keyframe_file.is_file():
            raise SpatialArtifactError(f"keyframe not found: {keyframe_file}")
        keyframe_name = f"keyframe{keyframe_file.suffix.lower() or '.img'}"
        destination = out_dir / keyframe_name
        if keyframe_file.resolve() != destination.resolve():
            shutil.copyfile(keyframe_file, destination)
    elif candidate.get("keyframe_path"):
        keyframe_name = Path(str(candidate["keyframe_path"])).name
    provenance = {
        "lecture_id": lecture_id,
        "lecture_title": str(candidate.get("lecture_title") or ""),
        "course": str(candidate.get("course") or ""),
        "library_key": str(candidate.get("library_key") or ""),
        "claim_name": str(candidate.get("claim_name") or ""),
        "concept_ids": [node.concept_id for node in scene],
        "start_ms": start_ms,
        "end_ms": end_ms,
        "keyframe_time_ms": keyframe_time_ms,
        "keyframe_id": candidate.get("keyframe_id"),
        "keyframe_path": keyframe_name,
        "keyframe_source": str(candidate.get("keyframe_source") or ""),
        "labels": [node.label for node in scene],
        "source_evidence": [
            str(candidate.get("ocr_snippet") or ""),
            str(candidate.get("vision_snippet") or ""),
            str(candidate.get("screen_text") or ""),
        ],
        "time_status": "measured" if start_ms is not None and end_ms is not None else "unmeasured",
        "time_note": str(candidate.get("time_note") or ""),
        "reason": str(candidate.get("reason") or ""),
        "artifact_path": "scene.glb",
        "scene_path": "scene.json",
        "viewer_path": "viewer.html",
    }
    provenance["source_evidence"] = [part for part in provenance["source_evidence"] if part.strip()]
    document, blob = _gltf_document(scene, lecture_id)
    payload = _scene_payload(scene, provenance)
    (out_dir / "scene.glb").write_bytes(_glb(document, blob))
    (out_dir / "scene.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out_dir / "provenance.json").write_text(
        json.dumps(provenance, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (out_dir / "viewer.html").write_text(_viewer_html(payload, provenance), encoding="utf-8")
    return provenance


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate one 3D scene from a spatial candidate")
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--keyframe", type=Path, default=None)
    args = parser.parse_args(list(argv) if argv is not None else None)
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))
    if not isinstance(candidate, dict):
        raise SpatialArtifactError("candidate must be a JSON object")
    keyframe = args.keyframe
    if keyframe is None and candidate.get("keyframe_path"):
        raw = Path(str(candidate["keyframe_path"]))
        keyframe = raw if raw.is_file() else args.candidate.parent / raw
        if not keyframe.is_file():
            keyframe = None
    provenance = generate_artifact(candidate, args.out, keyframe_file=keyframe)
    json.dump(
        {
            "ok": True,
            "lecture_id": provenance["lecture_id"],
            "labels": provenance["labels"],
            "artifact_path": str(args.out / provenance["artifact_path"]),
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SpatialArtifactError as exc:
        print(f"spatial artifact: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

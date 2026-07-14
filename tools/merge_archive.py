"""Архив объектов, пропавших из источника.

Сравнивает свежую выгрузку с предыдущей опубликованной (ветка gh-pages) и ведёт
`archive.geojson`: объект, который был в прошлой версии, но исчез из источника,
попадает в архив; если он потом снова появляется в выгрузке — из архива убирается.

Паспорта архивных проектов (ps/<UIN>.json) копируются из прошлой публикации,
иначе карточка архивного объекта осталась бы пустой.

  python tools/merge_archive.py --new build/site/data --prev build/prev/data

Без --prev (или если предыдущей публикации нет) архив просто переносится как есть.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path
from typing import Any

ARCHIVE_NAME = "archive.geojson"
PROJECTS_NAME = "projects_web.geojson"


def load_features(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("features") or []


def key_of(feature: dict[str, Any]) -> str | None:
    props = feature.get("properties") or {}
    return props.get("uin") or (str(props["id"]) if props.get("id") is not None else None)


def write_collection(path: Path, features: list[dict[str, Any]]) -> None:
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": "stroimprosto_projects_archive",
                "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
                "features": features,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new", type=Path, required=True, help="каталог свежих данных")
    parser.add_argument("--prev", type=Path, help="каталог предыдущей публикации (gh-pages)")
    args = parser.parse_args()

    new_dir: Path = args.new
    prev_dir: Path | None = args.prev if args.prev and (args.prev / PROJECTS_NAME).exists() else None

    today = date.today().isoformat()
    current = {key_of(f) for f in load_features(new_dir / PROJECTS_NAME)}
    current.discard(None)

    archived: dict[str, dict[str, Any]] = {}

    if prev_dir is None:
        print("предыдущая публикация не найдена — архив остаётся прежним", flush=True)
        for feature in load_features(new_dir / ARCHIVE_NAME):
            key = key_of(feature)
            if key and key not in current:
                archived[key] = feature
    else:
        # объекты, уже лежавшие в архиве: остаются, пока не вернулись в источник
        for feature in load_features(prev_dir / ARCHIVE_NAME):
            key = key_of(feature)
            if key and key not in current:
                archived[key] = feature

        # объекты, которые были в прошлой публикации, но исчезли из источника
        prev_meta_path = prev_dir / "metadata.json"
        last_seen = today
        if prev_meta_path.exists():
            last_seen = (json.loads(prev_meta_path.read_text(encoding="utf-8"))
                         .get("generated_at") or today)[:10]

        for feature in load_features(prev_dir / PROJECTS_NAME):
            key = key_of(feature)
            if not key or key in current or key in archived:
                continue
            props = feature.setdefault("properties", {})
            props["archived"] = True
            props["archived_at"] = today
            props["last_seen"] = last_seen
            archived[key] = feature

        # паспорта архивных проектов — из прошлой публикации
        copied = 0
        for key in archived:
            target = new_dir / "ps" / f"{key}.json"
            source = prev_dir / "ps" / f"{key}.json"
            if not target.exists() and source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                copied += 1
        if copied:
            print(f"скопировано паспортов архивных проектов: {copied}", flush=True)

    features = sorted(archived.values(), key=lambda f: (f["properties"].get("archived_at") or "",
                                                        key_of(f) or ""))
    write_collection(new_dir / ARCHIVE_NAME, features)

    new_today = sum(1 for f in features if (f["properties"] or {}).get("archived_at") == today)
    meta_path = new_dir / "metadata.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["archived_count"] = len(features)
        meta["archived_new"] = new_today
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({"archived_total": len(features), "archived_new": new_today},
                     ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

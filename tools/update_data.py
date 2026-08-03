"""Полное обновление данных карты строек с stroimprosto.mos.ru.

Источник (POST, form-encoded, нужны Origin/Referer):
  ws/getprojects.php     — индекс проектов на карте
  ws/psSearchIndex.php   — атрибуты проектов
  ws/getProjectCard.php  — карточка: геометрия + атрибуты
  ws/getPSData.php       — паспорт проекта: организации, ТЭП, документы, кадастр

С 20.07.2026 источник показывает на карте только часть объектов (2.8 тыс. вместо
9.6 тыс.; вычищены почти все «Планируемые»), но карточки убранных объектов по id
по-прежнему отдаются. Поэтому качаем по объединению «индекс карты + ранее
известные id» (--prev: каталог прошлой публикации), а объектам вне индекса
ставим признак `off_map`. Список id переносится из выгрузки в выгрузку через
known_ids.json.

Результат (каталог --out):
  projects_web.geojson  полигоны (упрощённые) + точки-фолбэки
  metadata.json         счётчики, списки округов/районов/статусов, generated_at
  ps/<UIN>.json         паспорт проекта
  ps_index.json         список UIN, у которых паспорт непустой
  org_index.json        индекс организаций для фильтра
  known_ids.json        все id, по которым карточка отдалась (вход для следующего запуска)

Сайт доступен только с российских IP — запускать с российского адреса.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, mapping
from shapely.ops import unary_union
from shapely.validation import make_valid

WS = "https://stroimprosto.mos.ru/tb/prod/strpr_map/mapControl/ws"
HEADERS = {
    "Accept": "*/*",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Origin": "https://stroimprosto.mos.ru",
    "Referer": "https://stroimprosto.mos.ru/map/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
}

WEB_FIELDS = (
    "id", "uin", "name", "area", "district", "address", "res_complex", "state",
    "fno_name", "fno_codes", "job_type", "fin_source", "input_fact", "input_plan",
    "lat", "lng",
)
ORG_FIELDS = ("role", "name", "inn", "ogrn", "address")
TEP_FIELDS = ("name", "val", "unit")
DOC_FIELDS = (
    "docType", "docParentId", "docRasporNum", "docRasporDate", "docYear", "docState",
    "documentLink", "docNameGk", "docSummaGk", "docPartnerGk",
    "docZaklDateGk", "docStartDateGk", "docEndDateGk", "evZayavNum", "evZayavDate",
)
SIMPLIFY_TOLERANCE = 0.000004  # ~0.4 м, столько же, сколько в первой сборке карты
ORG_PREFIX_RE = re.compile(r"^(ооо|ао|пао|зао|оао|нко|ано|фгбу|гбу|гау|гку|мку|фку|ип)\s+")
QUOTES_RE = re.compile(r"^[\"'«»\s]+|[\"'«»\s]+$")


def log(message: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {message}", flush=True)


def post(session: requests.Session, endpoint: str, data: dict[str, Any] | None = None,
         attempts: int = 5) -> Any:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            response = session.post(f"{WS}/{endpoint}", headers=HEADERS, data=data or {}, timeout=45)
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"POST {endpoint} {data or ''}: {last}") from last


# --- геометрия -------------------------------------------------------------

def finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def polygon_from_ring(raw_ring: Any) -> Polygon | None:
    if not isinstance(raw_ring, list):
        return None
    ring = [(float(x), float(y)) for x, y in raw_ring if finite(x) and finite(y)]
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    if len(ring) < 4:
        return None
    polygon = Polygon(ring)
    if not polygon.is_valid:
        fixed = make_valid(polygon)
        if fixed.geom_type == "Polygon":
            polygon = fixed
        elif fixed.geom_type == "MultiPolygon":
            polygon = max(fixed.geoms, key=lambda geom: geom.area)
        else:
            polygon = polygon.buffer(0)
    if polygon.is_empty or polygon.area == 0:
        return None
    return polygon


def polygonal_part(geometry: Any) -> MultiPolygon | Polygon | None:
    if geometry is None or geometry.is_empty:
        return None
    if geometry.geom_type == "Polygon":
        return geometry
    if geometry.geom_type == "MultiPolygon":
        parts = [part for part in geometry.geoms if not part.is_empty]
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    if isinstance(geometry, GeometryCollection):
        parts: list[Polygon] = []
        for part in geometry.geoms:
            piece = polygonal_part(part)
            if piece is None:
                continue
            if piece.geom_type == "Polygon":
                parts.append(piece)
            else:
                parts.extend(list(piece.geoms))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return None


def rings_to_geometry(raw_rings: Any) -> tuple[MultiPolygon | Polygon | None, int]:
    if not isinstance(raw_rings, list):
        return None, 0
    polygons = [poly for poly in (polygon_from_ring(ring) for ring in raw_rings) if poly is not None]
    if not polygons:
        return None, len(raw_rings)
    geometry = polygons[0] if len(polygons) == 1 else unary_union(polygons)
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    return polygonal_part(geometry), len(raw_rings)


# --- скачивание ------------------------------------------------------------

def fetch_card(session: requests.Session, project_id: int) -> dict[str, Any]:
    card = post(session, "getProjectCard.php", {"id": project_id})
    return card if isinstance(card, dict) else {}


def fetch_ps(session: requests.Session, uin: str) -> dict[str, Any]:
    payload = post(session, "getPSData.php", {"psID": uin, "byUIN": 1})
    return payload if isinstance(payload, dict) else {}


def run_pool(items: list[Any], worker, workers: int, label: str) -> tuple[dict[Any, Any], list[dict[str, str]]]:
    results: dict[Any, Any] = {}
    errors: list[dict[str, str]] = []
    total = len(items)
    session = requests.Session()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(worker, session, item): item for item in items}
        for done, future in enumerate(as_completed(futures), start=1):
            item = futures[future]
            try:
                results[item] = future.result()
            except Exception as exc:  # noqa: BLE001
                errors.append({"item": str(item), "error": repr(exc)})
            if done == 1 or done % 500 == 0 or done == total:
                log(f"{label} {done}/{total}, ошибок {len(errors)}")
    return results, errors


# --- паспорта проектов -----------------------------------------------------

def pick(source: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: source[field] for field in fields
            if source.get(field) not in (None, "", [])}


def trim_ps(payload: dict[str, Any]) -> dict[str, Any]:
    orgs = [pick(item, ORG_FIELDS) for item in (payload.get("orgs") or []) if isinstance(item, dict)]
    tep = [pick(item, TEP_FIELDS) for item in (payload.get("power_data") or []) if isinstance(item, dict)]
    docs = [pick(item, DOC_FIELDS) for item in (payload.get("docs") or []) if isinstance(item, dict)]
    result: dict[str, Any] = {"uin": payload.get("uin")}
    if orgs:
        result["orgs"] = orgs
    if tep:
        result["tep"] = tep
    if docs:
        result["docs"] = docs
    if payload.get("cadastr"):
        result["cadastr"] = payload["cadastr"]
    schedule = payload.get("schedule")
    if isinstance(schedule, dict) and any(schedule.values()):
        result["schedule"] = schedule
    return result


def has_content(trimmed: dict[str, Any]) -> bool:
    return any(key in trimmed for key in ("orgs", "tep", "docs", "cadastr"))


def org_key(name: str) -> str:
    return re.sub(r"\s+", " ", str(name or "")).strip().lower()


def org_search_key(name: str) -> str:
    key = QUOTES_RE.sub("", org_key(name))
    key = ORG_PREFIX_RE.sub("", key)
    return QUOTES_RE.sub("", key)


def build_org_index(ps_by_uin: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Индекс организаций: имя → список UIN. Ключи считаются так же, как в app.js."""
    by_key: dict[str, dict[str, Any]] = {}
    uins_by_key: dict[str, set[str]] = defaultdict(set)
    for uin, trimmed in ps_by_uin.items():
        for org in trimmed.get("orgs") or []:
            name = org.get("name")
            if not name:
                continue
            key = org_key(name)
            by_key.setdefault(key, {"name": name, "key": key, "searchKey": org_search_key(name)})
            uins_by_key[key].add(uin)
    index = []
    for key, entry in by_key.items():
        uins = sorted(uins_by_key[key])
        index.append({**entry, "count": len(uins), "uins": uins})
    index.sort(key=lambda item: (-item["count"], item["key"]))
    return index


# --- сборка ----------------------------------------------------------------

def write_json(path: Path, payload: Any, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    separators = (",", ":") if compact else None
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=separators,
                   indent=None if compact else 2),
        encoding="utf-8",
    )


def load_previous_ids(prev_dir: Path | None) -> set[int]:
    """id из прошлой публикации: known_ids.json плюс сами объекты projects_web.geojson.

    Архив не трогаем: там объекты, у которых карточка уже не отдавалась."""
    if prev_dir is None:
        return set()
    ids: set[int] = set()
    known_path = prev_dir / "known_ids.json"
    if known_path.exists():
        try:
            ids.update(int(value) for value in json.loads(known_path.read_text(encoding="utf-8")))
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            log(f"known_ids.json прочитать не удалось ({exc!r}) — берём id из projects_web.geojson")
    projects_path = prev_dir / "projects_web.geojson"
    if projects_path.exists():
        data = json.loads(projects_path.read_text(encoding="utf-8"))
        for feature in data.get("features") or []:
            value = (feature.get("properties") or {}).get("id")
            if value is not None:
                ids.add(int(value))
    return ids


def previous_project_count(prev_dir: Path | None) -> int:
    if prev_dir is None:
        return 0
    meta_path = prev_dir / "metadata.json"
    if not meta_path.exists():
        return 0
    try:
        return int(json.loads(meta_path.read_text(encoding="utf-8")).get("project_count") or 0)
    except (ValueError, TypeError, json.JSONDecodeError):
        return 0


def build(out_dir: Path, workers: int, min_index: int, min_projects: int,
          prev_dir: Path | None, max_shrink: float, allow_shrink: bool) -> dict[str, Any]:
    session = requests.Session()
    log("индекс проектов…")
    index = post(session, "getprojects.php")
    search_index = {int(item["id"]): item for item in post(session, "psSearchIndex.php")
                    if item.get("id") is not None}
    map_ids = {int(item["id"]) for item in index if item.get("id") is not None}
    log(f"проектов на карте источника: {len(map_ids)}")
    if len(map_ids) < min_index:
        raise SystemExit(
            f"на карте всего {len(map_ids)} проектов (порог {min_index}) — "
            "похоже на сбой источника, обновление отменено"
        )

    known_ids = load_previous_ids(prev_dir)
    project_ids = sorted(map_ids | known_ids)
    off_map_ids = set(project_ids) - map_ids
    if off_map_ids:
        log(f"известны по прошлой выгрузке, но убраны с карты источника: {len(off_map_ids)}")

    cards, card_errors = run_pool(project_ids, fetch_card, workers, "карточки")

    features: list[dict[str, Any]] = []
    polygon_count = 0
    point_count = 0
    off_map_count = 0
    for project_id in project_ids:
        card = cards.get(project_id) or {}
        if not card:
            continue
        merged = {**search_index.get(project_id, {}), **card}
        props: dict[str, Any] = {}
        if project_id in off_map_ids:
            props["off_map"] = True
            off_map_count += 1
        for field in WEB_FIELDS:
            value = merged.get(field)
            props[field] = ", ".join(str(part) for part in value) if isinstance(value, list) else value

        geometry, ring_count = rings_to_geometry(merged.get("polygons"))
        if geometry is not None:
            geometry = geometry.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            props["ring_count"] = ring_count
            props["geom_source"] = "polygon"
            polygon_count += 1
        elif finite(merged.get("lng")) and finite(merged.get("lat")):
            geometry = Point(float(merged["lng"]), float(merged["lat"]))
            props["ring_count"] = 0
            props["geom_source"] = "point_fallback"
            point_count += 1
        else:
            continue
        features.append({"type": "Feature", "properties": props, "geometry": mapping(geometry)})

    if len(features) < min_projects:
        raise SystemExit(
            f"собрано всего {len(features)} объектов (порог {min_projects}) — обновление отменено"
        )

    prev_count = previous_project_count(prev_dir)
    if prev_count and not allow_shrink and len(features) < prev_count * (1 - max_shrink):
        raise SystemExit(
            f"собрано {len(features)} объектов против {prev_count} в прошлой публикации "
            f"(допустимая убыль — до {max_shrink:.0%}) — обновление отменено; "
            "если сокращение настоящее, перезапустить с --allow-shrink"
        )

    write_json(out_dir / "known_ids.json",
               sorted(int(f["properties"]["id"]) for f in features
                      if f["properties"].get("id") is not None))

    write_json(out_dir / "projects_web.geojson", {
        "type": "FeatureCollection",
        "name": "stroimprosto_projects_web",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    })

    uins = [feature["properties"]["uin"] for feature in features if feature["properties"].get("uin")]
    uins = list(dict.fromkeys(uins))
    log(f"паспорта проектов: {len(uins)}")
    raw_ps, ps_errors = run_pool(uins, fetch_ps, workers, "паспорта")

    ps_dir = out_dir / "ps"
    ps_dir.mkdir(parents=True, exist_ok=True)
    trimmed_by_uin: dict[str, dict[str, Any]] = {}
    with_content: list[str] = []
    for uin in uins:
        trimmed = trim_ps(raw_ps.get(uin) or {})
        write_json(ps_dir / f"{uin}.json", trimmed)
        if has_content(trimmed):
            trimmed_by_uin[uin] = trimmed
            with_content.append(uin)

    write_json(out_dir / "ps_index.json", sorted(with_content))
    write_json(out_dir / "org_index.json", build_org_index(trimmed_by_uin))

    metadata = {
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "https://stroimprosto.mos.ru/map/",
        "project_count": len(features),
        "map_count": len(map_ids),
        "off_map_count": off_map_count,
        "polygon_count": polygon_count,
        "point_fallback_count": point_count,
        "ps_with_content": len(with_content),
        "organization_count": len(build_org_index(trimmed_by_uin)),
        "crs": "EPSG:4326",
        "card_errors": len(card_errors),
        "ps_errors": len(ps_errors),
        "states": sorted({f["properties"]["state"] for f in features if f["properties"].get("state")}),
        "districts": sorted({f["properties"]["district"] for f in features if f["properties"].get("district")}),
        "areas": sorted({f["properties"]["area"] for f in features if f["properties"].get("area")}),
    }
    write_json(out_dir / "metadata.json", metadata, compact=False)
    if card_errors or ps_errors:
        write_json(out_dir / "fetch_errors.json", {"cards": card_errors, "ps": ps_errors}, compact=False)
    log(json.dumps({k: v for k, v in metadata.items()
                    if k not in ("states", "districts", "areas")}, ensure_ascii=False))
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="каталог для data/")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--prev", type=Path,
                        help="каталог прошлой публикации (build/prev/data): источник известных id")
    parser.add_argument("--min-index", type=int, default=1500,
                        help="страховка: меньше объектов в индексе карты — считаем источник сломанным")
    parser.add_argument("--min-projects", type=int, default=2000,
                        help="страховка: меньше собранных объектов — не публикуем")
    parser.add_argument("--max-shrink", type=float, default=0.2,
                        help="допустимая убыль объектов против прошлой публикации (доля)")
    parser.add_argument("--allow-shrink", action="store_true",
                        help="разрешить публикацию, даже если объектов стало сильно меньше")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    prev_dir = args.prev if args.prev and args.prev.exists() else None
    build(args.out, args.workers, args.min_index, args.min_projects,
          prev_dir, args.max_shrink, args.allow_shrink)
    return 0


if __name__ == "__main__":
    sys.exit(main())

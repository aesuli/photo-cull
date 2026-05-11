#!/usr/bin/env python3
"""
Photo Culling Web App with Pillow Thumbnails
============================================

* Browse a directory tree of photos
* View each image and give it a rating (1‑5)
* Store ratings in <data_dir>/.ratings.db (SQLite)
* Generate thumbnails on‑demand and keep them cached in
    <data_dir>/.cache/<relative_path>.jpg

Requirements
------------
    pip install cherrypy pillow
"""

import io
import sqlite3
import sys
import threading
import time
import zipfile
import cherrypy
from html import escape
from pathlib import Path
from datetime import datetime
from urllib.parse import quote
from cherrypy.lib import static as cherrypy_static
from PIL import Image, ImageOps


def _resource_root() -> Path:
    """Return the directory that contains bundled runtime resources."""
    if hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).parent


def _license_path() -> Path | None:
    """Return the first available license file path across script and bundled runs."""
    candidates = [
        _resource_root() / "LICENSE",
        Path(__file__).with_name("LICENSE"),
        Path(sys.argv[0]).resolve().parent / "LICENSE",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None

def is_image_file(fname: str) -> bool:
    """Return True for common image extensions."""
    IMG_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff"}
    return Path(fname).suffix.lower() in IMG_EXTS

def safe_join(root: Path, rel_path: str) -> Path:
    """
    Return an absolute Path that is guaranteed to stay inside `root`.
    Raises ValueError if the resulting path would escape the root.
    """
    # Resolve any '..' and symlinks
    new_path = (root / rel_path).resolve()
    if not str(new_path).startswith(str(root.resolve())):
        raise ValueError("Attempted path traversal")
    return new_path


def _format_exif_datetime(exif_value: str):
    """Convert EXIF datetime (YYYY:MM:DD HH:MM:SS) to date/time strings."""
    try:
        dt = datetime.strptime(str(exif_value).strip(), "%Y:%m:%d %H:%M:%S")
    except (TypeError, ValueError):
        return None
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")


def _rational_to_float(value):
    """Convert EXIF rational values to float when possible."""
    try:
        if isinstance(value, tuple) and len(value) == 2 and value[1]:
            return float(value[0]) / float(value[1])
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _extract_exif_shot_datetime(exif):
    """Return (date, time) from EXIF shot timestamp tags, or None if unavailable."""
    for tag in (36867, 36868, 306):  # DateTimeOriginal, DateTimeDigitized, DateTime
        dt_parts = _format_exif_datetime(exif.get(tag))
        if dt_parts:
            return dt_parts
    return None

class ApiHandler:
    """CherryPy sub-handler providing JSON endpoints for the SPA."""

    def __init__(self, photo_app: "PhotoCullingApp"):
        self._app = photo_app

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def tree(self, dir=""):
        """Return immediate sub-directories of *dir* (relative to base_dir).
        Each item: {name, path, hasChildren}
        """
        try:
            abs_dir = safe_join(self._app.base_dir, dir)
        except ValueError:
            raise cherrypy.HTTPError(403, "Forbidden")
        if not abs_dir.is_dir():
            raise cherrypy.HTTPError(404, "Not Found")
        result = []
        try:
            entries = sorted(abs_dir.iterdir(), key=lambda p: p.name.lower())
        except PermissionError:
            return result
        for entry in entries:
            if entry.is_dir() and not entry.name.startswith("."):
                rel_path = str(entry.relative_to(self._app.base_dir)).replace("\\", "/")
                try:
                    has_children = any(
                        e.is_dir() and not e.name.startswith(".")
                        for e in entry.iterdir()
                    )
                except PermissionError:
                    has_children = False
                result.append({
                    "name": entry.name,
                    "path": rel_path,
                    "hasChildren": has_children,
                })
        return result

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def images(self, dir="", load_id=""):
        """Return image files in *dir* (relative to base_dir).
        Each item: {name, path, date, time, exif, rating}
        """
        load_id = str(load_id or "").strip()
        try:
            abs_dir = safe_join(self._app.base_dir, dir)
        except ValueError:
            raise cherrypy.HTTPError(403, "Forbidden")
        if not abs_dir.is_dir():
            raise cherrypy.HTTPError(404, "Not Found")
        result = []
        try:
            entries = sorted(abs_dir.iterdir(), key=lambda p: p.name.lower())
        except PermissionError:
            return result
        image_entries = [e for e in entries if e.is_file() and is_image_file(e.name)]
        total_images = len(image_entries)
        self._app._set_load_progress(
            load_id,
            phase="Checking metadata",
            processed=0,
            total=total_images,
            done=False,
        )

        try:
            self._app._sync_directory_metadata(
                abs_dir,
                image_entries,
                progress_callback=lambda processed, total: self._app._set_load_progress(
                    load_id,
                    phase="Checking metadata",
                    processed=processed,
                    total=total,
                    done=False,
                ),
            )
            self._app._set_load_progress(
                load_id,
                phase="Loading images",
                processed=0,
                total=total_images,
                done=False,
            )
            for index, entry in enumerate(image_entries, start=1):
                rel_path = str(entry.relative_to(self._app.base_dir)).replace("\\", "/")
                modified_date, modified_time, exif_info = self._app._get_image_metadata_for_images(entry)
                rating = self._app._get_rating(entry)
                result.append({
                    "name": entry.name,
                    "path": rel_path,
                    "date": modified_date,
                    "time": modified_time,
                    "exif": exif_info,
                    "rating": rating,
                })
                self._app._set_load_progress(
                    load_id,
                    phase="Loading images",
                    processed=index,
                    total=total_images,
                    done=False,
                )
        except Exception as exc:
            self._app._set_load_progress(
                load_id,
                phase="Failed to load images",
                processed=0,
                total=total_images,
                done=True,
                error=str(exc),
            )
            raise

        self._app._set_load_progress(
            load_id,
            phase="Loaded images",
            processed=total_images,
            total=total_images,
            done=True,
        )
        return result

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def load_progress(self, load_id=""):
        """Return folder image-loading progress for a client-generated request id."""
        return self._app._get_load_progress(load_id)

    @cherrypy.expose
    @cherrypy.tools.json_in()
    @cherrypy.tools.json_out()
    def rate(self):
        """Set a rating for one or more images.
        Payload: {"paths": ["relative/path.jpg", ...], "rating": "1".."5" or ""}
        """
        payload = cherrypy.request.json or {}
        paths = payload.get("paths", [])
        rating = str(payload.get("rating", "")).strip()

        if rating not in {"", "1", "2", "3", "4", "5"}:
            raise cherrypy.HTTPError(400, "Invalid rating")

        if not isinstance(paths, list):
            raise cherrypy.HTTPError(400, "Invalid paths")

        updated = 0
        for rel_path in paths:
            if not isinstance(rel_path, str):
                continue
            try:
                abs_path = safe_join(self._app.base_dir, rel_path)
            except ValueError:
                continue
            if not abs_path.is_file() or not is_image_file(abs_path.name):
                continue

            if rating == "":
                self._app._clear_rating(abs_path)
            else:
                self._app._set_rating(abs_path, rating)
            updated += 1

        return {"ok": True, "updated": updated, "rating": rating}

    @cherrypy.expose
    @cherrypy.tools.json_in()
    def download(self):
        """Download selected images as a file (single) or ZIP (multiple)."""
        payload = cherrypy.request.json or {}
        paths = payload.get("paths", [])
        keep_structure = bool(payload.get("keepStructure", True))
        current_dir = str(payload.get("dir", "")).strip().replace("\\", "/")

        if not isinstance(paths, list):
            raise cherrypy.HTTPError(400, "Invalid paths")

        valid_abs_paths = []
        for rel_path in paths:
            if not isinstance(rel_path, str):
                continue
            try:
                abs_path = safe_join(self._app.base_dir, rel_path)
            except ValueError:
                continue
            if not abs_path.is_file() or not is_image_file(abs_path.name):
                continue
            valid_abs_paths.append(abs_path)

        if not valid_abs_paths:
            raise cherrypy.HTTPError(400, "No valid images selected")

        # Single selection: return the original file as an attachment.
        if len(valid_abs_paths) == 1:
            one = valid_abs_paths[0]
            return cherrypy_static.serve_file(
                str(one), disposition="attachment", name=one.name
            )

        if current_dir in {"", "/"}:
            archive_name = "files.zip"
        else:
            normalized_dir = current_dir.strip("/")
            safe_dir = normalized_dir.replace("/", "_")
            archive_name = f"files_{safe_dir}.zip"

        zip_buffer = io.BytesIO()
        added = set()
        with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for abs_path in valid_abs_paths:
                rel = str(abs_path.relative_to(self._app.base_dir)).replace("\\", "/")
                arcname = rel if keep_structure else Path(rel).name
                if arcname in added:
                    stem = Path(arcname).stem
                    suffix = Path(arcname).suffix
                    n = 2
                    while True:
                        candidate = f"{stem}_{n}{suffix}"
                        if candidate not in added:
                            arcname = candidate
                            break
                        n += 1
                zf.write(abs_path, arcname=arcname)
                added.add(arcname)

        data = zip_buffer.getvalue()
        cherrypy.response.headers["Content-Type"] = "application/zip"
        cherrypy.response.headers["Content-Disposition"] = f'attachment; filename="{archive_name}"'
        cherrypy.response.headers["Content-Length"] = str(len(data))
        return data


class PhotoCullingApp:
    """
    CherryPy application for browsing & rating images.
    Handles thumbnail creation and caching transparently.
    """

    THUMB_MAX_SIZE = (400, 400) 
    THUMB_QUALITY = 85 

    def __init__(self, base_dir: Path, data_dir: Path):
        self.base_dir = base_dir
        self.data_dir = data_dir
        self.license_path = _license_path()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / ".ratings.db"
        self.cache_dir = self.data_dir / ".cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._load_progress_lock = threading.Lock()
        self._load_progress: dict[str, dict] = {}
        self._init_db()
        self.api = ApiHandler(self)

    def _init_db(self):
        with sqlite3.connect(self.db_path) as con:
            con.execute(
                "CREATE TABLE IF NOT EXISTS ratings "
                "(path TEXT PRIMARY KEY, rating TEXT NOT NULL)"
            )
            con.execute(
                "CREATE TABLE IF NOT EXISTS image_metadata "
                "(path TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT '', "
                "time TEXT NOT NULL DEFAULT '', exif TEXT NOT NULL DEFAULT '')"
            )

    def _rating_key(self, abs_path: Path) -> str:
        """Return a key relative to the base_dir."""
        return str(abs_path.relative_to(self.base_dir))

    def _get_rating(self, abs_path: Path) -> str:
        key = self._rating_key(abs_path)
        with sqlite3.connect(self.db_path) as con:
            row = con.execute(
                "SELECT rating FROM ratings WHERE path = ?", (key,)
            ).fetchone()
        return row[0] if row else ""

    def _set_rating(self, abs_path: Path, rating: str):
        key = self._rating_key(abs_path)
        with sqlite3.connect(self.db_path) as con:
            con.execute(
                "INSERT INTO ratings (path, rating) VALUES (?, ?) "
                "ON CONFLICT(path) DO UPDATE SET rating = excluded.rating",
                (key, rating),
            )

    def _clear_rating(self, abs_path: Path):
        key = self._rating_key(abs_path)
        with sqlite3.connect(self.db_path) as con:
            con.execute("DELETE FROM ratings WHERE path = ?", (key,))

    def _file_modified_metadata(self, abs_path: Path):
        """Return (date, time) derived from file modification timestamp."""
        try:
            modified_dt = datetime.fromtimestamp(abs_path.stat().st_mtime)
            return modified_dt.strftime("%Y-%m-%d"), modified_dt.strftime("%H:%M")
        except OSError:
            return "", ""

    def _extract_exif_metadata_from_file(self, abs_path: Path):
        """Return (shot_date, shot_time, exif_info) extracted from EXIF metadata."""
        shot_date = ""
        shot_time = ""
        exif_info = ""
        try:
            with Image.open(abs_path) as img:
                exif = img.getexif()
                if exif:
                    shot_dt = _extract_exif_shot_datetime(exif)
                    if shot_dt:
                        shot_date, shot_time = shot_dt

                    exif_parts = []

                    make = str(exif.get(271, "")).strip()
                    model = str(exif.get(272, "")).strip()
                    camera = " ".join(part for part in (make, model) if part)
                    if camera:
                        exif_parts.append(camera)

                    iso = exif.get(34855)
                    if iso:
                        exif_parts.append(f"ISO {iso}")

                    focal = _rational_to_float(exif.get(37386))
                    if focal:
                        exif_parts.append(f"{focal:.0f}mm")

                    fnum = _rational_to_float(exif.get(33437))
                    if fnum:
                        exif_parts.append(f"f/{fnum:.1f}")

                    exposure = _rational_to_float(exif.get(33434))
                    if exposure:
                        if exposure >= 1:
                            exif_parts.append(f"{exposure:.1f}s")
                        else:
                            denom = round(1 / exposure) if exposure > 0 else 0
                            if denom > 0:
                                exif_parts.append(f"1/{denom}s")

                    if exif_parts:
                        exif_info = " | ".join(exif_parts)
        except Exception:
            pass
        return shot_date, shot_time, exif_info

    def _get_db_image_metadata(self, abs_path: Path):
        """Return (date, time, exif_info) from DB or None if missing."""
        key = self._rating_key(abs_path)
        with sqlite3.connect(self.db_path) as con:
            row = con.execute(
                "SELECT date, time, exif FROM image_metadata WHERE path = ?",
                (key,),
            ).fetchone()
        if not row:
            return None
        return row[0] or "", row[1] or "", row[2] or ""

    def _set_db_image_metadata(self, abs_path: Path, date: str, time: str, exif: str):
        """Insert or update image metadata row."""
        key = self._rating_key(abs_path)
        with sqlite3.connect(self.db_path) as con:
            con.execute(
                "INSERT INTO image_metadata (path, date, time, exif) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET "
                "date = excluded.date, time = excluded.time, exif = excluded.exif",
                (key, date or "", time or "", exif or ""),
            )

    def _sync_directory_metadata(
        self,
        abs_dir: Path,
        image_entries: list[Path],
        progress_callback=None,
    ):
        """Ensure metadata rows mirror files in a directory, preserving stored creation dates."""
        dir_rel = str(abs_dir.relative_to(self.base_dir)).replace("\\", "/")
        if dir_rel == ".":
            dir_rel = ""

        current_keys = {self._rating_key(entry) for entry in image_entries}
        with sqlite3.connect(self.db_path) as con:
            metadata_rows = [row[0] for row in con.execute("SELECT path FROM image_metadata").fetchall()]
            existing_keys = set(metadata_rows)

            for db_key in metadata_rows:
                normalized_key = str(db_key).replace("\\", "/")
                parent_dir = normalized_key.rsplit("/", 1)[0] if "/" in normalized_key else ""
                if parent_dir == dir_rel and db_key not in current_keys:
                    con.execute("DELETE FROM image_metadata WHERE path = ?", (db_key,))

            total_entries = len(image_entries)
            for index, entry in enumerate(image_entries, start=1):
                key = self._rating_key(entry)
                if key in existing_keys:
                    if progress_callback is not None:
                        progress_callback(index, total_entries)
                    continue
                shot_date, shot_time, exif_info = self._extract_exif_metadata_from_file(entry)
                if shot_date and shot_time:
                    created_date, created_time = shot_date, shot_time
                else:
                    created_date, created_time = self._file_modified_metadata(entry)
                con.execute(
                    "INSERT INTO image_metadata (path, date, time, exif) VALUES (?, ?, ?, ?)",
                    (key, created_date, created_time, exif_info),
                )
                if progress_callback is not None:
                    progress_callback(index, total_entries)

    def _set_load_progress(
        self,
        load_id: str,
        *,
        phase: str,
        processed: int,
        total: int,
        done: bool,
        error: str = "",
    ):
        """Store coarse progress state for a single in-flight folder load."""
        if not load_id:
            return
        now = time.time()
        progress = {
            "phase": phase,
            "processed": max(0, int(processed)),
            "total": max(0, int(total)),
            "done": bool(done),
            "error": error,
            "updated_at": now,
        }
        with self._load_progress_lock:
            self._prune_load_progress_locked(now)
            self._load_progress[load_id] = progress

    def _get_load_progress(self, load_id: str):
        """Return progress snapshot for a folder load request."""
        if not load_id:
            return {
                "phase": "Loading images",
                "processed": 0,
                "total": 0,
                "done": False,
                "error": "",
            }
        now = time.time()
        with self._load_progress_lock:
            self._prune_load_progress_locked(now)
            progress = self._load_progress.get(load_id)
        if progress is None:
            return {
                "phase": "Loading images",
                "processed": 0,
                "total": 0,
                "done": False,
                "error": "",
            }
        return {
            "phase": progress["phase"],
            "processed": progress["processed"],
            "total": progress["total"],
            "done": progress["done"],
            "error": progress["error"],
        }

    def _prune_load_progress_locked(self, now: float):
        """Remove stale progress snapshots from older folder loads."""
        cutoff = now - 300
        stale_ids = [
            load_id
            for load_id, progress in self._load_progress.items()
            if progress.get("updated_at", 0) < cutoff
        ]
        for load_id in stale_ids:
            self._load_progress.pop(load_id, None)

    def _get_image_metadata_for_images(self, abs_path: Path):
        """Return metadata for /images using DB first, then mtime fallback."""
        db_metadata = self._get_db_image_metadata(abs_path)
        if db_metadata is not None:
            return db_metadata
        fallback_date, fallback_time = self._file_modified_metadata(abs_path)
        return fallback_date, fallback_time, ""

    def _refresh_image_exif(self, abs_path: Path):
        """Refresh EXIF info in DB and prefer EXIF shot time, with mtime fallback."""
        before = self._get_db_image_metadata(abs_path)
        shot_date, shot_time, latest_exif = self._extract_exif_metadata_from_file(abs_path)
        if not shot_date or not shot_time:
            shot_date, shot_time = self._file_modified_metadata(abs_path)

        if before is None:
            self._set_db_image_metadata(abs_path, shot_date, shot_time, latest_exif)
            return latest_exif, True

        date, time, old_exif = before
        changed = (old_exif != latest_exif) or (date != shot_date) or (time != shot_time)
        if changed:
            self._set_db_image_metadata(abs_path, shot_date, shot_time, latest_exif)
        return latest_exif, changed

    def _thumb_path(self, abs_path: Path) -> Path:
        """
        Return the path where the thumbnail for abs_path should live.
        Always stores the thumbnail as JPEG, regardless of source format.
        """
        rel = abs_path.relative_to(self.base_dir)
        thumb = self.cache_dir / rel
        thumb = thumb.with_suffix(".jpg")          # force .jpg
        thumb.parent.mkdir(parents=True, exist_ok=True)
        return thumb

    def _ensure_thumbnail(self, abs_path: Path):
        """
        Create a thumbnail if it does not already exist.
        """
        thumb = self._thumb_path(abs_path)
        if thumb.exists():
            try:
                if thumb.stat().st_mtime >= abs_path.stat().st_mtime:
                    return thumb
            except OSError:
                pass

        try:
            with Image.open(abs_path) as img:
                img = ImageOps.exif_transpose(img)
                img.thumbnail(self.THUMB_MAX_SIZE, Image.LANCZOS)
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                img.save(thumb, format="JPEG", quality=self.THUMB_QUALITY)
        except Exception as exc:
            cherrypy.log(f"Thumbnail error for {abs_path}: {exc}")
        return thumb

    @cherrypy.expose
    def index(self, **kwargs):
        """Serve the single-page application shell."""
        return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Photo Cull</title>
  <link rel="stylesheet" href="/static/app.css">
</head>
<body>
  <header id="header">
    <h1>Photo Cull</h1>
        <span id="photo-stats" aria-live="polite">
            <span id="stats-total">Total: 0</span>
            <div id="stats-bar-wrap"><div id="stats-bar"></div></div>
        </span>
    <label for="cols-input">Columns:</label>
    <input type="number" id="cols-input" min="1" max="20" value="4">
        <button id="fit-toggle" title="Toggle fill and fit image mode">Fit</button>
        <button id="sort-toggle" title="Cycle sort mode">Sort: Name</button>
        <button id="sort2-toggle" title="Cycle secondary sort mode">Then: Name</button>
        <button id="info-toggle" title="Toggle image info overlay">Show Info</button>
        <button id="rating-toggle" title="Toggle image ratings overlay">Show Ratings</button>
        <button id="group-toggle" title="Show/hide rating group separators">Hide Groups</button>
        <label id="group-date-wrap" for="group-date-interval" title="Grouping interval when main sort is date/time">
            Group Date:
            <select id="group-date-interval">
                <option value="year">Year</option>
                <option value="month">Month</option>
                <option value="day" selected>Day</option>
                <option value="hour">Hour</option>
            </select>
        </label>
        <label id="group-name-wrap" for="group-name-prefix" title="Grouping prefix length when main sort is name">
            Name Prefix:
            <input type="number" id="group-name-prefix" min="1" max="20" value="1">
        </label>
        <button id="theme-toggle" title="Toggle light and dark theme">Theme</button>
                <button id="download-btn" title="Download selected images (Z)">Download</button>
        <button id="help-toggle" title="Show help and shortcuts">?</button>
    <button id="sidebar-toggle" title="Toggle directory tree">Directories &#9776;</button>
  </header>
  <div id="layout">
    <main id="gallery">
      <div id="grid"></div>
    </main>
    <div id="sidebar-resize-handle" title="Drag to resize folder tree"></div>
    <aside id="sidebar">
      <div id="tree"></div>
    </aside>
  </div>
  <div id="fullpage" class="hidden" role="dialog" aria-modal="true" aria-label="Full-page photo view">
    <img id="fullpage-img" src="" alt="">
        <div id="fullpage-info" class="cell-info">
            <div class="cell-info-top">
                <span id="fullpage-name" class="cell-info-chip name"></span>
                <span class="cell-info-meta">
                    <span id="fullpage-datetime" class="cell-info-chip datetime"></span>
                    <span id="fullpage-exif" class="cell-info-chip exif"></span>
                </span>
            </div>
            <div class="cell-info-bottom">
                <span id="fullpage-rating" class="cell-info-chip rating"></span>
            </div>
    </div>
        <span id="fullpage-counter" class="cell-info-chip"></span>
  </div>
    <div id="help-modal" class="hidden" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div id="help-panel">
            <div id="help-brand">
                <h2 id="help-app-name">Photo Cull</h2>
                <p id="help-copyright">Copyright 2026 <a href="https://www.esuli.it" target="_blank" rel="noopener noreferrer">Andrea Esuli</a></p>
                <p id="help-license">License: <a href="/license" target="_blank" rel="noopener noreferrer">BSD 3-Clause</a></p>
            </div>
            <div id="help-head">
                <h2 id="help-title">Photo Cull Help</h2>
                <button id="help-close" title="Close help">Close</button>
            </div>
            <div id="help-content">
                <p>Arrow Left/Right/Up/Down : move selection by one cell (with Shift to extend range, with Ctrl to add target).</p>
                <p>Home : jump to first image.</p>
                <p>End : jump to last image.</p>
                <p>Ctrl+A : select all images in current directory.</p>
                <p>1 : set rating 1 star for selected images.</p>
                <p>2 : set rating 2 stars for selected images.</p>
                <p>3 : set rating 3 stars for selected images.</p>
                <p>4 : set rating 4 stars for selected images.</p>
                <p>5 : set rating 5 stars for selected images.</p>
                <p>6 : remove rating from selected images.</p>
                <p>I : show/hide filename and date-time overlay.</p>
                <p>R : show/hide ratings overlay.</p>
                <p>G : show/hide rating group separators.</p>
                <p>X : show/hide EXIF info.</p>
                <p>S : cycle primary sort mode.</p>
                <p>Shift+S : cycle secondary sort mode.</p>
                <p>Date grouping options: Year/Month/Day/Hour selector appears when main sort is Date.</p>
                <p>Name grouping option: prefix length (1-20) appears when main sort is Name.</p>
                <p>F : toggle fit/fill image mode.</p>
                <p>T : toggle light/dark theme.</p>
                <p>D : show/hide directories sidebar.</p>
                <p>Z : download selected image(s) with confirmation.</p>
                <p>+ : decrease number of columns (larger images).</p>
                <p>- : increase number of columns (smaller images).</p>
                <p>? : show/hide this help panel.</p>
                <p>Space : open/close full-page view of the active photo.</p>
                <p>Arrow Left/Right (full-page) : navigate to previous/next photo.</p>
                <p>1-6 (full-page) : rate only the currently shown photo.</p>
                <p>C (full-page) : show/hide photo counter.</p>
                <p>Escape : close full-page view or help panel.</p>
            </div>
        </div>
    </div>
    <div id="download-modal" class="hidden" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <div id="download-panel">
            <h2 id="download-title">Download Selected</h2>
            <p id="download-message">Download selected image(s)?</p>
            <label id="download-keep-wrap" for="download-keep-structure" class="hidden">
                <input id="download-keep-structure" type="checkbox" checked>
                Keep the directory structure (K)
            </label>
            <div id="download-actions">
                <button id="download-cancel" type="button" title="Cancel download">Cancel</button>
                <button id="download-confirm" type="button" title="Confirm download">Download</button>
            </div>
            <p id="download-hint">Press Enter to confirm.</p>
        </div>
    </div>
  <script src="/static/app.js"></script>
</body>
</html>"""

    @cherrypy.expose
    def license(self):
        """Render the bundled license text in the browser."""
        if self.license_path is None:
            raise cherrypy.HTTPError(404, "License file not found")

        try:
            license_text = self.license_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise cherrypy.HTTPError(500, f"Unable to read license file: {exc}")

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Photo Cull License</title>
    <style>
        :root {{
            color-scheme: light dark;
            font-family: "Segoe UI", sans-serif;
        }}

        body {{
            margin: 0;
            padding: 24px;
            background: Canvas;
            color: CanvasText;
        }}

        main {{
            max-width: 900px;
            margin: 0 auto;
        }}

        h1 {{
            margin-top: 0;
            font-size: 1.5rem;
        }}

        pre {{
            white-space: pre-wrap;
            word-break: break-word;
            padding: 16px;
            border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
            border-radius: 8px;
            background: color-mix(in srgb, Canvas 90%, CanvasText 10%);
            line-height: 1.5;
        }}
    </style>
</head>
<body>
    <main>
        <h1>Photo Cull License</h1>
        <pre>{escape(license_text)}</pre>
    </main>
</body>
</html>"""

    @cherrypy.expose
    def photo(self, path):
        """Serve the original full-resolution photo."""
        try:
            abs_path = safe_join(self.base_dir, path)
        except ValueError:
            raise cherrypy.HTTPError(403, "Forbidden")

        if not abs_path.is_file() or not is_image_file(abs_path):
            raise cherrypy.HTTPError(404, "Not Found")

        return cherrypy_static.serve_file(
            str(abs_path), disposition="inline"
        )

    @cherrypy.expose
    def thumb(self, path):
        """
        Serve a cached thumbnail, generating it on‑demand.
        URL: /thumb?path=relative/path/to/file
        """
        try:
            abs_path = safe_join(self.base_dir, path)
        except ValueError:
            raise cherrypy.HTTPError(403, "Forbidden")

        if not abs_path.is_file() or not is_image_file(abs_path):
            raise cherrypy.HTTPError(404, "Not Found")

        refreshed_exif, exif_changed = self._refresh_image_exif(abs_path)
        cherrypy.response.headers["X-Photo-Exif"] = quote(refreshed_exif or "", safe="")
        cherrypy.response.headers["X-Photo-Exif-Updated"] = "1" if exif_changed else "0"

        thumb_path = self._ensure_thumbnail(abs_path)

        # stream the file directly
        return cherrypy_static.serve_file(
            str(thumb_path), disposition="inline"
        )

def create_app(base_dir: Path, data_dir: Path) -> cherrypy.Application:
    """
    Helper that creates the CherryPy root app object.
    """
    app = PhotoCullingApp(base_dir, data_dir)
    return app


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Photo Culling Web App with on‑demand thumbnails"
    )
    parser.add_argument(
        "directory",
        help="Root directory containing photos to browse",
    )
    parser.add_argument(
        "--data-dir",
        default=".",
        help=(
            "Directory where .ratings.db and .cache are stored "
            "(default: current working directory)"
        ),
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host interface to bind the web server to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=12121,
        help="TCP port to bind the web server to (default: 12121)",
    )
    args = parser.parse_args()

    base_dir = Path(args.directory).resolve()
    if not base_dir.is_dir():
        raise SystemExit(f"Error: '{base_dir}' is not a directory")

    data_dir = Path(args.data_dir).resolve()
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SystemExit(f"Error: cannot create data directory '{data_dir}': {exc}")
    print(f'Internal data directory: {data_dir}')

    conf = {
        "/": {
            "tools.sessions.on": True,
            "tools.sessions.timeout": 60,  # minutes
        },
        "/static": {
            "tools.staticdir.on": True,
            "tools.staticdir.dir": str(_resource_root() / "static"),
        },
    }

    cherrypy.config.update(
        {
            "server.socket_host": args.host,
            "server.socket_port": args.port,
        }
    )

    print(
        f"Serving photos from {base_dir} with data in {data_dir} "
        f"on http://{args.host}:{args.port} ..."
    )
    cherrypy.quickstart(create_app(base_dir, data_dir), config=conf)

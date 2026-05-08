#!/usr/bin/env python3
"""Portable GUI launcher for Photo Cull web app.

Launch flow:
1) Prompt user for photo directory (unless provided as argument)
2) Start local CherryPy server for that directory
3) Open default browser to the app URL
"""

import argparse
import json
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import cherrypy

from photo_cull import create_app


def _resource_root() -> Path:
    """Return the directory that contains bundled runtime resources."""
    if hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).parent


def _exe_dir() -> Path:
    """Return the directory that contains the running executable (or script)."""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys.executable).parent
    return Path(sys.argv[0]).resolve().parent


# ── Persisted state ────────────────────────────────────────────────────────

_STATE_DIR = Path.home() / ".photocull"
_STATE_FILE = _STATE_DIR / "state.json"


def _load_state() -> dict:
    try:
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(photo_dir: Path, data_dir: Path) -> None:
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(
            json.dumps(
                {"photo_dir": str(photo_dir), "data_dir": str(data_dir)},
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


# ── Startup dialog ─────────────────────────────────────────────────────────

def _run_startup_dialog(
    init_photo_dir: Path | None,
    init_data_dir: Path,
) -> tuple[Path, Path] | None:
    """Show the startup configuration dialog.

    Returns (photo_dir, data_dir) when the user clicks Start, or None on cancel.
    """
    import tkinter as tk
    from tkinter import filedialog

    result: list[tuple[Path, Path] | None] = [None]

    root = tk.Tk()
    root.title("Photo Cull")
    root.resizable(False, False)
    root.attributes("-topmost", True)

    photo_var = tk.StringVar(value=str(init_photo_dir) if init_photo_dir else "")
    data_var = tk.StringVar(value=str(init_data_dir))

    def _browse_photo():
        current = photo_var.get() or os.getcwd()
        chosen = filedialog.askdirectory(
            parent=root, title="Select photo directory",
            initialdir=current, mustexist=True,
        )
        if chosen:
            photo_var.set(chosen)
        _update_start_btn()

    def _browse_data():
        current = data_var.get() or os.getcwd()
        chosen = filedialog.askdirectory(
            parent=root, title="Select data directory",
            initialdir=current,
        )
        if chosen:
            data_var.set(chosen)

    def _update_start_btn():
        start_btn.config(state="normal" if photo_var.get().strip() else "disabled")

    def _start():
        photo = photo_var.get().strip()
        data = data_var.get().strip()
        if not photo:
            return
        result[0] = (Path(photo).resolve(), Path(data).resolve())
        root.destroy()

    def _cancel():
        root.destroy()

    FONT = ("TkDefaultFont", 9)
    FONT_BOLD = ("TkDefaultFont", 9, "bold")
    ENTRY_W = 44

    outer = tk.Frame(root, padx=20, pady=16)
    outer.pack()

    tk.Label(outer, text="Photo Cull", font=("TkDefaultFont", 13, "bold")).grid(
        row=0, column=0, columnspan=3, pady=(0, 14), sticky="w"
    )

    tk.Label(outer, text="Photo directory", font=FONT_BOLD, anchor="w").grid(
        row=1, column=0, columnspan=3, sticky="w"
    )
    tk.Entry(outer, textvariable=photo_var, font=FONT, width=ENTRY_W, state="readonly").grid(
        row=2, column=0, columnspan=2, sticky="ew", pady=(2, 0)
    )
    tk.Button(outer, text="Browse\u2026", font=FONT, command=_browse_photo).grid(
        row=2, column=2, padx=(6, 0), pady=(2, 0)
    )

    tk.Label(outer, text="Data directory  (ratings & thumbnails)", font=FONT_BOLD, anchor="w").grid(
        row=3, column=0, columnspan=3, sticky="w", pady=(12, 0)
    )
    tk.Entry(outer, textvariable=data_var, font=FONT, width=ENTRY_W, state="readonly").grid(
        row=4, column=0, columnspan=2, sticky="ew", pady=(2, 0)
    )
    tk.Button(outer, text="Browse\u2026", font=FONT, command=_browse_data).grid(
        row=4, column=2, padx=(6, 0), pady=(2, 0)
    )

    btn_frame = tk.Frame(outer)
    btn_frame.grid(row=5, column=0, columnspan=3, pady=(20, 0), sticky="e")
    tk.Button(btn_frame, text="Cancel", font=FONT, width=10, command=_cancel).pack(
        side="left", padx=(0, 8)
    )
    start_btn = tk.Button(btn_frame, text="Start", font=FONT_BOLD, width=10, command=_start)
    start_btn.pack(side="left")

    _update_start_btn()
    root.protocol("WM_DELETE_WINDOW", _cancel)
    root.bind("<Return>", lambda _e: _start())
    root.mainloop()

    return result[0]


def _find_free_port(host: str, preferred_port: int) -> int:
    """Return preferred_port if available, otherwise ask OS for an ephemeral port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, preferred_port))
            return preferred_port
        except OSError:
            sock.bind((host, 0))
            return int(sock.getsockname()[1])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Photo Cull portable launcher"
    )
    parser.add_argument(
        "directory",
        nargs="?",
        help="Root directory containing photos to browse (if omitted, a folder picker opens)",
    )
    parser.add_argument(
        "--data-dir",
        default=None,
        help="Directory where .ratings.db and .cache are stored (default: exe directory, prompted at startup)",
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
        help="Preferred TCP port to bind the web server to (default: 12121)",
    )
    args = parser.parse_args()

    state = _load_state()

    if args.directory:
        init_photo_dir: Path | None = Path(args.directory).resolve()
    elif state.get("photo_dir"):
        init_photo_dir = Path(state["photo_dir"])
    else:
        init_photo_dir = None

    if args.data_dir:
        init_data_dir = Path(args.data_dir).resolve()
    elif state.get("data_dir"):
        init_data_dir = Path(state["data_dir"])
    else:
        init_data_dir = _exe_dir()

    dirs = _run_startup_dialog(init_photo_dir, init_data_dir)
    if dirs is None:
        return 1
    selected_dir, data_dir = dirs

    _save_state(selected_dir, data_dir)

    if not selected_dir.is_dir():
        print(f"Error: '{selected_dir}' is not a directory")
        return 1

    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Error: cannot create data directory '{data_dir}': {exc}")
        return 1

    static_dir = _resource_root() / "static"
    if not static_dir.is_dir():
        print(f"Error: static assets folder not found at '{static_dir}'")
        return 1

    server_port = _find_free_port(args.host, args.port)

    conf = {
        "/": {
            "tools.sessions.on": True,
            "tools.sessions.timeout": 60,
        },
        "/static": {
            "tools.staticdir.on": True,
            "tools.staticdir.dir": str(static_dir),
        },
    }

    cherrypy.config.update(
        {
            "server.socket_host": args.host,
            "server.socket_port": server_port,
        }
    )

    app_url = f"http://{args.host}:{server_port}"

    # Start CherryPy in a background thread so the main thread can run Tk.
    cherrypy.config.update({"engine.autoreload.on": False})
    server_thread = threading.Thread(
        target=lambda: cherrypy.quickstart(create_app(selected_dir, data_dir), config=conf),
        daemon=True,
    )
    server_thread.start()

    print(
        f"Serving photos from {selected_dir} with data in {data_dir} "
        f"on {app_url} ..."
    )

    # Persistent control window — closing it shuts the app down.
    _run_control_window(app_url)

    cherrypy.engine.exit()
    server_thread.join(timeout=5)
    return 0


def _run_control_window(app_url: str) -> None:
    """Show a small Tk window with Open Browser / Close App buttons."""
    import tkinter as tk

    root = tk.Tk()
    root.title("Photo Cull")
    root.resizable(False, False)
    root.attributes("-topmost", False)

    pad = {"padx": 16, "pady": 8}

    tk.Label(
        root,
        text="Photo Cull is running",
        font=("TkDefaultFont", 11, "bold"),
    ).pack(**pad)

    url_frame = tk.Frame(root)
    url_frame.pack(padx=16, pady=(0, 4))
    tk.Label(url_frame, text="URL:", font=("TkDefaultFont", 9)).pack(side="left")
    url_var = tk.StringVar(value=app_url)
    url_entry = tk.Entry(
        url_frame, textvariable=url_var, state="readonly",
        font=("TkDefaultFont", 9), width=32, relief="flat",
    )
    url_entry.pack(side="left", padx=(4, 0))

    def _open_browser():
        if not webbrowser.open(app_url):
            tk.messagebox.showinfo(
                title="No browser found",
                message=f"No web browser was found.\n\nOpen manually:\n{app_url}",
            )

    def _close_app():
        root.destroy()

    btn_frame = tk.Frame(root)
    btn_frame.pack(padx=16, pady=(4, 16))
    tk.Button(
        btn_frame, text="Open in Browser",
        width=18, command=_open_browser,
    ).pack(side="left", padx=(0, 8))
    tk.Button(
        btn_frame, text="Close App",
        width=12, command=_close_app,
    ).pack(side="left")

    root.protocol("WM_DELETE_WINDOW", _close_app)

    # Open the browser automatically on first launch.
    root.after(200, _open_browser)

    root.mainloop()


if __name__ == "__main__":
    raise SystemExit(main())

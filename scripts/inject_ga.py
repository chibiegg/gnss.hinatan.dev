#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass


GA_SNIPPET_TEMPLATE = """<!-- Google tag (gtag.js) -->
<script async src=\"https://www.googletagmanager.com/gtag/js?id={measurement_id}\"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', '{measurement_id}');
</script>
"""


@dataclass(frozen=True)
class InjectResult:
    scanned: int
    modified: int
    skipped_already_present: int


def _read_text(path: str) -> tuple[str, str]:
    with open(path, "rb") as f:
        raw = f.read()

    # Preserve line endings when writing back.
    newline = "\n"
    if b"\r\n" in raw:
        newline = "\r\n"

    # Best-effort decode; most files here are UTF-8.
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")

    return text, newline


def _write_text(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def _already_has_ga(text_lower: str, measurement_id: str) -> bool:
    if "googletagmanager.com/gtag/js?id=" in text_lower:
        return True
    # Also consider the specific ID in config call.
    if f"gtag('config', '{measurement_id.lower()}')" in text_lower:
        return True
    if f"gtag(\"config\", \"{measurement_id.lower()}\")" in text_lower:
        return True
    return False


def inject_into_html(html: str, measurement_id: str, newline: str) -> tuple[bool, str]:
    html_lower = html.lower()
    if _already_has_ga(html_lower, measurement_id):
        return False, html

    snippet = GA_SNIPPET_TEMPLATE.format(measurement_id=measurement_id)
    if newline != "\n":
        snippet = snippet.replace("\n", newline)

    # Insert before </head> if present (case-insensitive).
    close_head_idx = html_lower.find("</head>")
    if close_head_idx != -1:
        # Ensure there's a blank line before the snippet for readability.
        prefix = html[:close_head_idx]
        if not prefix.endswith(("\n", "\r\n")):
            prefix += newline
        new_html = prefix + snippet + html[close_head_idx:]
        return True, new_html

    # Fallback: insert right after <head> if present.
    open_head_idx = html_lower.find("<head")
    if open_head_idx != -1:
        gt_idx = html_lower.find(">", open_head_idx)
        if gt_idx != -1:
            insert_at = gt_idx + 1
            new_html = html[:insert_at] + newline + snippet + html[insert_at:]
            return True, new_html

    # Last resort: prepend.
    new_html = snippet + newline + html
    return True, new_html


def run(root: str, measurement_id: str) -> InjectResult:
    scanned = 0
    modified = 0
    skipped_already_present = 0

    for dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            if not filename.lower().endswith((".html", ".htm")):
                continue
            path = os.path.join(dirpath, filename)
            scanned += 1

            html, newline = _read_text(path)
            did_change, new_html = inject_into_html(html, measurement_id, newline)
            if not did_change:
                skipped_already_present += 1
                continue

            if new_html != html:
                _write_text(path, new_html)
                modified += 1

    return InjectResult(
        scanned=scanned,
        modified=modified,
        skipped_already_present=skipped_already_present,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Inject Google Analytics gtag into HTML files")
    parser.add_argument("--root", required=True, help="Root directory to scan (e.g. htdocs)")
    parser.add_argument("--id", required=True, dest="measurement_id", help="GA4 measurement ID (e.g. G-XXXX)")
    args = parser.parse_args()

    result = run(args.root, args.measurement_id)
    print(
        f"GA inject: scanned={result.scanned} modified={result.modified} "
        f"skipped_already_present={result.skipped_already_present}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

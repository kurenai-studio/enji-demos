"""Run auto-ui-pipeline's assemble.py with a resvg_py 0.2.0 workaround.

resvg_py 0.2.0 ignores svg_to_bytes(width=, height=): it keeps the canvas at the SVG's own width/height
while still scaling content, so assemble's 2x render comes out cropped to the top-left quarter. This wrapper
rewrites the root width/height to the requested size (viewBox unchanged) before rendering.

usage: <pipeline venv python> tools/assemble_2x.py <work_dir>
"""
import os
import re
import sys

PIPE = os.environ.get("AUTO_UI", "/Users/shinjiyu/Documents/auto-ui-pipeline")
sys.path.insert(0, os.path.join(PIPE, "ui-kit-test", "stardust-redo", "pipeline"))

import resvg_py  # noqa: E402

_orig = resvg_py.svg_to_bytes


def _sized(svg_string, width=None, height=None, **kw):
    if width and height:
        head, rest = svg_string.split(">", 1)
        head = re.sub(r'\swidth="[^"]*"', f' width="{width}"', head, count=1)
        head = re.sub(r'\sheight="[^"]*"', f' height="{height}"', head, count=1)
        svg_string = head + ">" + rest
    return _orig(svg_string=svg_string, **kw)


resvg_py.svg_to_bytes = _sized

import assemble  # noqa: E402

assemble.main(os.path.abspath(sys.argv[1]))

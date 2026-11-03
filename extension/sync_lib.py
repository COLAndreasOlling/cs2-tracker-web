"""Copy the site's engine, analysis and insights into the extension, so both use the same code.
Run after changing static/engine.js, static/analysis.js or static/insights.js:  python extension/sync_lib.py"""
import pathlib, shutil

here = pathlib.Path(__file__).resolve().parent
for name in ("engine.js", "analysis.js", "insights.js"):
    shutil.copyfile(here.parent / "static" / name, here / "lib" / name)
    print("copied", name)

from __future__ import annotations

import json

import pymupdf

from justthespec import browser
from justthespec.extract import extract


def _words(pdf_path):
    with pymupdf.open(pdf_path) as doc:
        title = (doc.metadata or {}).get("title") or ""
        return title, [[list(w[:5]) for w in page.get_text("words")] for page in doc]


def test_words_path_matches_pymupdf_path(vendor_pdf, vendor_pdf_v2):
    title, pages = _words(vendor_pdf)
    out = json.loads(browser.extract_json(vendor_pdf.name, title, json.dumps(pages)))
    expected = extract(vendor_pdf, ocr=False).spec
    assert out["spec"] == expected
    assert out["count"] == sum(len(v) for v in expected["paths"].values())
    assert out["text"].startswith("openapi: 3.0.3")

    title2, pages2 = _words(vendor_pdf_v2)
    new = json.loads(browser.extract_json(vendor_pdf_v2.name, title2, json.dumps(pages2)))
    report = json.loads(browser.diff_json(json.dumps(out["spec"]), json.dumps(new["spec"])))
    assert report["breaking_count"] >= 1
    assert "BREAKING" in report["markdown"]


def test_browser_module_does_not_need_pymupdf_or_httpx(monkeypatch):
    import subprocess
    import sys

    code = (
        "import sys; sys.modules['pymupdf'] = None; sys.modules['httpx'] = None; "
        "import justthespec.browser as b; "
        "print(b.extract_json('x.pdf', 't', '[[[0,0,50,10,\"GET\"],[60,0,120,10,\"/v1/a\"]]]'))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert '"/v1/a"' in out.stdout


def test_refine_json_uses_page_supplied_model(vendor_pdf):
    import asyncio

    title, pages = _words(vendor_pdf)
    browser.extract_json(vendor_pdf.name, title, json.dumps(pages))
    seen = []

    async def complete(system, prompt):
        seen.append(prompt)
        return json.dumps({"summary": "Refined by the page"})

    # extracting the older version for a diff must not change what gets refined
    browser.extract_json("older.pdf", "", json.dumps(pages[:1]), remember=False)
    out = json.loads(asyncio.run(browser.refine_json("openai", complete)))
    assert out["spec"]["info"]["title"] == "Acme Payments API Reference"
    ops = [op for item in out["spec"]["paths"].values() for op in item.values()]
    assert seen and all(op["summary"] == "Refined by the page" for op in ops)
    assert all(op["x-refined-by"] == "openai" for op in ops)
    assert out["tip"] is None

    async def bad_key(system, prompt):
        raise RuntimeError("Error: HTTP 401: Incorrect API key")

    out = json.loads(asyncio.run(browser.refine_json("openai", bad_key)))
    assert [w for w in out["warnings"] if "stopped" in w and "HTTP 401" in w]


def test_gap_after_url_scheme_is_closed():
    words = [
        [0, 0, 20, 10, "GET"],
        [24, 0, 60, 10, "https://"],
        [64, 0, 160, 10, "{Endpoint}/v3/projects"],
    ]
    doc = browser.document_from_words("x.pdf", "", [words])
    assert doc.pages[0].text == "GET https://{Endpoint}/v3/projects"

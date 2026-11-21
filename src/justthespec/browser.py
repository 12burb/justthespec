"""Entry points for the in-browser build (Pyodide).

The page runs this package in the visitor's browser: pdf.js supplies the words of each page
and nothing is uploaded anywhere. PyMuPDF, OCR and AI refinement are not available there.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from typing import Any

from . import llm, pdf
from .diff import diff_specs
from .extract import ExtractResult, ai_hint, extract_document
from .output import dump

_last: dict[str, ExtractResult] = {}
# Only when what follows looks like the rest of a URL, not prose ("use https:// and ...").
_SCHEME_GAP_RE = re.compile(
    r"(https?://) (?=\{[^}\s]+\}|[\w.-]+\.[a-z]{2,}\b|\d+(?:\.\d+){3}\b|[\w.-]+:\d+\b|[\w.-]+/)"
)


def document_from_words(name: str, title: str, pages: list[list[list[Any]]]) -> pdf.Document:
    """Build a Document from per-page word boxes: [[x0, y0, x1, y1, text], ...] per page."""
    doc = pdf.Document(path=name, title=(title or "").strip())
    for number, words in enumerate(pages, start=1):
        text = pdf.lines_from_words(words)
        # pdf.js can leave a gap after the scheme ("https:// {Endpoint}/v3"); URLs have none.
        text = _SCHEME_GAP_RE.sub(r"\1", text)
        doc.pages.append(pdf.Page(number=number, text=text))
    return doc


def extract_json(
    name: str, title: str, pages_json: str, fmt: str = "yaml", remember: bool = True
) -> str:
    """Extract from pdf.js words (JSON) and return spec, text, warnings and tip as JSON.

    The remembered result is what refine_json works on; pass remember=False for the older
    version of a document that is only being diffed against.
    """
    result = extract_document(document_from_words(name, title, json.loads(pages_json)))
    if remember:
        _last["result"] = result
    return _result_json(result, fmt, ai_hint(result.spec))


def _result_json(result: ExtractResult, fmt: str, tip: str | None) -> str:
    return json.dumps(
        {
            "spec": result.spec,
            "text": dump(result.spec, fmt),
            "warnings": result.warnings,
            "tip": tip,
            "count": sum(len(item) for item in result.spec["paths"].values()),
        }
    )


async def refine_json(
    provider_name: str,
    complete: Callable[[str, str], Awaitable[Any]],
    fmt: str = "yaml",
    progress: Callable[[int, int], None] | None = None,
) -> str:
    """Refine the last extraction with a model the page reaches itself.

    `complete(system, prompt)` is the page's function (JS fetch to OpenAI, Gemini or Ollama);
    it must raise an error whose message contains "HTTP <status>" on failure.
    """
    result = _last.get("result")
    if result is None:
        raise ValueError("extract a PDF first")
    result.warnings = [w for w in result.warnings if "AI refinement" not in w]

    async def call(system: str, prompt: str) -> str:
        try:
            return str(await complete(system, prompt))
        except Exception as exc:  # noqa: BLE001 - JS errors arrive as generic exceptions
            message = str(exc).splitlines()[-1] if str(exc) else type(exc).__name__
            fatal = bool(
                re.search(
                    r"HTTP (401|403|404)\b|API[ _]key[ _](not[ _]valid|invalid)", message, re.I
                )
            )
            raise llm.ProviderError(message, fatal=fatal) from None

    await llm.enrich(result, llm.CallableProvider(provider_name, call), 2, progress)
    return _result_json(result, fmt, None)


def diff_json(old_spec_json: str, new_spec_json: str) -> str:
    report = diff_specs(json.loads(old_spec_json), json.loads(new_spec_json))
    return json.dumps({"markdown": report.to_markdown(), **report.to_dict()})

# Changelog

## 0.2.0 - 2026-11-19

Renamed from `pdf2openapi` to **JustTheSpec**.

- The package, command and MCP server are now `justthespec`
  (`pip install git+https://github.com/12burb/justthespec`).
- Environment variables are now `JUSTTHESPEC_PROVIDER`, `JUSTTHESPEC_MODEL`,
  `JUSTTHESPEC_TIMEOUT` and `JUSTTHESPEC_ALLOW_PRIVATE_URLS`.
- The web page moved to https://12burb.github.io/justthespec/.

## 0.1.0 - 2026-11-10

First release.

### Extract
- Convert vendor PDF API docs to OpenAPI 3.0 with no AI and no API key: rule-based parsing of
  method/path lines, parameter tables, JSON examples and authentication sections.
- OCR of screenshots and scanned pages with Tesseract (optional).
- Every operation cites its source pages in `x-source-pages`.
- Query-RPC APIs (`/entry.cgi?api=X&method=Y`, as in Synology's docs) become one operation per call.
- Endpoints whose method is not stated are guessed and marked `x-method-guessed`.
- Raw `multipart/form-data` examples become a multipart request body with typed fields and a
  binary `file` field.
- A `tip:` line names endpoints that came out incomplete, judged without AI.

### Optional AI refinement
- Bring your own model: OpenAI or any OpenAI-compatible API, Gemini, or local Ollama.
- AI output is merged into the rule-based draft; required parameters are never dropped and
  invalid parameter locations are corrected.
- A bad key or unknown model stops refinement after one call with one clear warning.

### Diff and validate
- `diff` compares PDFs, YAML/JSON specs or URLs and flags breaking changes (removed endpoints,
  new required inputs, type changes, auth and OAuth scope changes, server changes).
  `--fail-on-change` / `--fail-on-breaking` for CI.
- `validate` checks the spec and can probe GET/HEAD endpoints against a sandbox.
- URL fetching refuses private addresses (including via redirects and DNS) unless
  `PDF2OPENAPI_ALLOW_PRIVATE_URLS=1`.

### Browser
- A static page (GitHub Pages) runs the parser in the browser with pdf.js and Pyodide: extract
  and diff without uploading anything, try a sample, and hand the result to Postman/Insomnia/
  Bruno, the CLI or an MCP client. Optional refinement with your own OpenAI/Gemini key or local
  Ollama, called straight from the browser. No OCR there.

### MCP
- `pdf2openapi mcp` runs a stdio MCP server with `extract_openapi`, `read_pdf_pages`,
  `diff_api_docs` and `validate_openapi`. With `use_ai=true` and no key, it uses the client's
  own model through MCP sampling.

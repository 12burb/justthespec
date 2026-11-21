// Everything happens in this tab: pdf.js reads the PDF, Pyodide runs the justthespec parser.
// The optional AI step calls the provider you choose straight from the browser.
import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const SAMPLE = "sample-acme-payments-v2.pdf";
const SAMPLE_OLD = "sample-acme-payments.pdf";
const DEFAULT_MODELS = { openai: "gpt-4o-mini", gemini: "gemini-2.5-flash", ollama: "llama3.1" };
const AI_HELP = {
  openai: "Key from platform.openai.com. Each endpoint's text excerpt is sent to api.openai.com under your account.",
  gemini: "Key from aistudio.google.com. Each endpoint's text excerpt is sent to generativelanguage.googleapis.com under your account.",
  ollama:
    "Free and local. Start Ollama so this page may call it: OLLAMA_ORIGINS=" +
    location.origin +
    " ollama serve, then ollama pull llama3.1. Nothing leaves your computer.",
};

const $ = (id) => document.getElementById(id);
const status = (text, err = false) => {
  $("status").textContent = text;
  $("status").className = err ? "err" : "";
};

let current = null; // { name, spec, text }
let busy = false;

const pyReady = (async () => {
  const pyodide = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/" });
  await pyodide.loadPackage(["pyyaml", "micropip"]);
  const manifest = await (await fetch("wheel.json", { cache: "no-cache" })).json();
  const micropip = pyodide.pyimport("micropip");
  await micropip.install.callKwargs(new URL(manifest.wheel, location.href).href, { deps: false });
  pyodide.runPython("import justthespec.browser as browser");
  return pyodide;
})();

pyReady.then(
  () => status("Ready. Drop a PDF."),
  (e) => status(`Could not load the parser: ${e}`, true),
);

// Words as PyMuPDF would report them: [x0, y0, x1, y1, text] in points, top-left origin.
// pdf.js splits text into fragments mid-word ("G" + "as"); glue fragments that touch on the
// same baseline back together before splitting on whitespace.
async function pdfWords(data) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = meta?.info?.Title || "";
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const words = [];
    let run = null;
    const flush = () => {
      if (!run) return;
      const cw = (run.x1 - run.x0) / run.text.length;
      for (const m of run.text.matchAll(/\S+/g)) {
        const x0 = run.x0 + m.index * cw;
        words.push([x0, run.y - run.h * 0.8, x0 + m[0].length * cw, run.y + run.h * 0.2, m[0]]);
      }
      run = null;
    };
    for (const item of content.items) {
      if (!item.str) continue;
      const [, b, , d, e, f] = item.transform;
      const h = Math.hypot(b, d) || item.height || 10;
      const [x, y] = viewport.convertToViewportPoint(e, f);
      const touching =
        run &&
        Math.abs(y - run.y) < 1 &&
        x - run.x1 > -0.5 * h && // kerned pairs ("T" + "o") overlap
        x - run.x1 < 0.22 * h && // a real space glyph is wider than this
        !/\s$/.test(run.text) &&
        !/^\s/.test(item.str);
      if (touching) {
        run.text += item.str;
        run.x1 = x + item.width;
      } else {
        flush();
        if (item.str.trim()) run = { x0: x, x1: x + item.width, y, h, text: item.str };
      }
      if (item.hasEOL) flush();
    }
    flush();
    pages.push(words);
    if (n % 20 === 0) status(`Reading page ${n} of ${pdf.numPages}...`);
  }
  return { title, pages, numPages: pdf.numPages };
}

async function extractPdf(file, remember = true) {
  const data = new Uint8Array(await file.arrayBuffer());
  const { title, pages, numPages } = await pdfWords(data);
  status(`Extracting endpoints from ${numPages} page${numPages === 1 ? "" : "s"}...`);
  const pyodide = await pyReady;
  const fn = pyodide.globals.get("browser").extract_json;
  const out = JSON.parse(fn(file.name, title, JSON.stringify(pages), $("format").value, remember));
  fn.destroy();
  return out;
}

function showResult(out, name) {
  current = { name, spec: out.spec, text: out.text };
  $("count").textContent = out.count;
  $("name").textContent = name;
  $("out").value = out.text;
  $("tip").hidden = !out.tip;
  $("tip").textContent = out.tip ? `${out.tip} Open "refine with your own AI model" below.` : "";
  const ws = out.warnings;
  $("warnings").hidden = !ws.length;
  $("warnings").querySelector("summary").textContent = `${ws.length} warning${ws.length === 1 ? "" : "s"}`;
  $("warnings").querySelector("ul").replaceChildren(
    ...ws.map((w) => Object.assign(document.createElement("li"), { textContent: w })),
  );
  for (const id of ["result", "use", "diffsec"]) $(id).classList.add("show");
  $("diffout").hidden = true;
  $("sample2wrap").hidden = name !== SAMPLE;
}

async function onMainFile(file) {
  if (!file || busy) return;
  busy = true;
  try {
    status(`Reading ${file.name}...`);
    const out = await extractPdf(file);
    showResult(out, file.name);
    status(out.count ? "Done. Nothing was uploaded." : "No endpoints found in this PDF.");
  } catch (e) {
    console.error(e);
    status(`Could not read ${file.name}: ${e.message || e}`, true);
  } finally {
    busy = false;
  }
}

async function fetchSample(name) {
  const blob = await (await fetch(name)).blob();
  return new File([blob], name, { type: "application/pdf" });
}

async function onOldFile(file) {
  if (!file || !current || busy) return;
  busy = true;
  try {
    status(`Comparing with ${file.name}...`);
    const pyodide = await pyReady;
    let oldSpec;
    if (/\.pdf$/i.test(file.name)) {
      oldSpec = (await extractPdf(file, false)).spec;
    } else {
      const text = await file.text();
      const load = pyodide.runPython("import json, yaml\nlambda t: json.dumps(yaml.safe_load(t))");
      oldSpec = JSON.parse(load(text));
      load.destroy();
    }
    const fn = pyodide.globals.get("browser").diff_json;
    const report = JSON.parse(fn(JSON.stringify(oldSpec), JSON.stringify(current.spec)));
    fn.destroy();
    $("diffout").textContent = report.markdown;
    $("diffout").hidden = false;
    const n = report.breaking_count;
    status(`${n} breaking change${n === 1 ? "" : "s"} between ${file.name} and ${current.name}.`);
  } catch (e) {
    console.error(e);
    status(`Could not compare: ${e.message || e}`, true);
  } finally {
    busy = false;
  }
}

// --- optional AI refinement, called from the browser with the visitor's own key ---------------

async function postJson(url, body, headers) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      const err = (await resp.json()).error;
      detail = typeof err === "string" ? err : err?.message || "";
    } catch {}
    throw new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`);
  }
  return resp.json();
}

function makeComplete(provider, key, model) {
  if (provider === "openai") {
    return async (system, prompt) => {
      const data = await postJson(
        "https://api.openai.com/v1/chat/completions",
        {
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        },
        { Authorization: `Bearer ${key}` },
      );
      return data.choices[0].message.content;
    };
  }
  if (provider === "gemini") {
    return async (system, prompt) => {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
        { "x-goog-api-key": key },
      );
      return data.candidates[0].content.parts.map((p) => p.text || "").join("");
    };
  }
  // Only a URL counts as an Ollama address; anything else (e.g. a leftover key) is ignored.
  const host = (/^https?:\/\//i.test(key) ? key : "http://localhost:11434").replace(/\/$/, "");
  return async (system, prompt) => {
    const data = await postJson(`${host}/api/chat`, {
      model,
      stream: false,
      format: "json",
      options: { temperature: 0, num_ctx: 16384 },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    });
    return data.message.content;
  };
}

function syncAiForm() {
  const p = $("provider").value;
  $("apikey").value = ""; // a key for one provider must never be sent to another
  $("aihelp").textContent = AI_HELP[p];
  $("apikey").type = p === "ollama" ? "text" : "password";
  $("apikey").placeholder = p === "ollama" ? "http://localhost:11434" : "API key";
  $("model").placeholder = `model: ${DEFAULT_MODELS[p]}`;
}

async function onRefine() {
  if (!current || busy) return;
  const provider = $("provider").value;
  const key = $("apikey").value.trim();
  if (provider !== "ollama" && !key) {
    status("Enter your API key first (it stays in this tab).", true);
    return;
  }
  busy = true;
  $("refine").disabled = true;
  try {
    const pyodide = await pyReady;
    const model = $("model").value.trim() || DEFAULT_MODELS[provider];
    const complete = makeComplete(provider, key, model);
    const progress = (done, total) => status(`Refining with ${model}: ${done}/${total} endpoints...`);
    status(`Refining with ${model}...`);
    const fn = pyodide.globals.get("browser").refine_json;
    const out = JSON.parse(await fn(provider, complete, $("format").value, progress));
    fn.destroy();
    showResult(out, current.name);
    const failed = out.warnings.filter((w) => /AI refinement/.test(w));
    let message = failed.length ? failed[0] : `Refined with ${model}. Nothing was stored.`;
    if (/Failed to fetch/.test(message)) {
      message =
        provider === "ollama"
          ? `Could not reach Ollama at ${key || "http://localhost:11434"}. Start it with OLLAMA_ORIGINS=${location.origin} ollama serve (or set OLLAMA_ORIGINS=* in the Ollama app settings).`
          : `${provider === "openai" ? "OpenAI" : "Gemini"} did not answer this page. Most often the key is wrong or has no credit; check it in the provider's dashboard. The rule-based result is unchanged.`;
    }
    status(message, failed.length > 0);
  } catch (e) {
    console.error(e);
    status(`Refinement failed: ${e.message || e}`, true);
  } finally {
    busy = false;
    $("refine").disabled = false;
  }
}

// --- wiring ------------------------------------------------------------------------------------

function wireDrop(dropId, inputId, handler) {
  const drop = $(dropId);
  const input = $(inputId);
  input.addEventListener("change", () => handler(input.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    handler(e.dataTransfer.files[0]);
  });
}
wireDrop("drop", "file", onMainFile);
wireDrop("drop2", "file2", onOldFile);

$("sample").addEventListener("click", async (e) => {
  e.preventDefault();
  onMainFile(await fetchSample(SAMPLE));
});
$("sample2").addEventListener("click", async (e) => {
  e.preventDefault();
  onOldFile(await fetchSample(SAMPLE_OLD));
});

$("format").addEventListener("change", async () => {
  if (!current) return;
  const pyodide = await pyReady;
  const dump = pyodide.pyimport("justthespec.output").dump;
  current.text = dump(pyodide.toPy(current.spec), $("format").value);
  dump.destroy();
  $("out").value = current.text;
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("out").value);
  status("Copied to clipboard.");
});

function download() {
  if (!current) return;
  const ext = $("format").value === "json" ? "json" : "yaml";
  const blob = new Blob([$("out").value], { type: "text/plain" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: current.name.replace(/\.pdf$/i, "") + `.openapi.${ext}`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
$("download").addEventListener("click", download);
$("download2").addEventListener("click", download);

for (const btn of document.querySelectorAll("button[data-copy]")) {
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText($(btn.dataset.copy).textContent);
    const label = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = label), 1500);
  });
}

$("provider").addEventListener("change", syncAiForm);
$("refine").addEventListener("click", onRefine);
syncAiForm();

window.pdfWords = pdfWords; // used by tests
window.pdfjsLib = pdfjsLib;

// Rebuilds docs/deck/titration-deck.pdf and the README images in docs/images/
// from docs/deck/titration-deck.html using a local Google Chrome (headless).
// Run: node docs/deck/build.mjs   (set CHROME_PATH if Chrome is not found)

import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "titration-deck.html");
const pdf = resolve(here, "titration-deck.pdf");
const images = resolve(here, "..", "images");

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) {
  console.error("Google Chrome not found; set CHROME_PATH");
  process.exit(1);
}

// Chrome exits 0 even when it cannot write the output (e.g. the PDF is open in a viewer),
// so confirm the file was actually written by this run.
function run(args, out) {
  const started = Date.now();
  const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=15000", ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (!existsSync(out) || statSync(out).mtimeMs < started - 2000) {
    console.error(`Chrome did not write ${out} — is it open in another program?`);
    process.exit(1);
  }
}

const url = pathToFileURL(source).href;
run(["--no-pdf-header-footer", `--print-to-pdf=${pdf}`, url], pdf);
console.log(`wrote ${pdf}`);

mkdirSync(images, { recursive: true });
const exports = { 2: "nine-origins.png", 3: "how-it-decides.png", 4: "how-it-measures.png" };
for (const [slide, name] of Object.entries(exports)) {
  const out = resolve(images, name);
  run(["--window-size=1600,900", "--force-device-scale-factor=1", `--screenshot=${out}`, `${url}?slide=${slide}`], out);
  console.log(`wrote ${out}`);
}

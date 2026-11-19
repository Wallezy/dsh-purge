import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawnHiddenPowerShell } from "../lib/powershell.js";

function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "dsh-purge-powershell-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("dsh-purge-powershell-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = path.join(root, "helper with spaces.ps1");
  const marker = path.join(root, "executed.txt");
  fs.writeFileSync(script, '\uFEFFparam([string]$Marker)\r\n[IO.File]::WriteAllText($Marker + ".started", "started")\r\nStart-Sleep -Milliseconds 1000\r\n[IO.File]::WriteAllText($Marker, "executed")\r\n');
  return { root, script, marker };
}

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForMarker(marker) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await delay(100);
  assert.equal(fs.readFileSync(marker, "utf8"), "executed");
}

test("real hidden PowerShell executes the script, rather than only exiting zero", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const { script, marker } = fixture(t);
  const result = await closed(spawnHiddenPowerShell(script, ["-Marker", marker]));
  assert.deepEqual(result, { code: 0, signal: null });
  await waitForMarker(marker);
});

test("started PowerShell continues running after its Node parent exits", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const { root, script, marker } = fixture(t);
  const worker = path.join(root, "parent.mjs");
  const helperUrl = new URL("../lib/powershell.js", import.meta.url).href;
  fs.writeFileSync(worker, `import { spawnHiddenPowerShell } from ${JSON.stringify(helperUrl)};
import fs from "node:fs";
const child = spawnHiddenPowerShell(${JSON.stringify(script)}, ["-Marker", ${JSON.stringify(marker)}]);
child.on("error", () => { process.exitCode = 1; });
child.unref();
const started = Date.now();
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(marker + ".started")})) clearInterval(timer);
  else if (Date.now() - started > 10000) { clearInterval(timer); process.exitCode = 1; }
}, 50);
`);
  const result = await closed(spawn(process.execPath, [worker], { windowsHide: true, stdio: "ignore" }));
  assert.equal(result.code, 0);
  await waitForMarker(marker);
});

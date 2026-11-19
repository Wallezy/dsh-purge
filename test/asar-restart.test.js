import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ASAR_SWAP_PS1, scheduleAsarSwapRestart } from "../lib/desktop.js";
import { hostFs } from "../lib/extract-asar.js";

function fixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "dsh-purge-restart-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("dsh-purge-restart-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

for (const withRuntime of [false, true]) {
  test(`slow or failed helper never exits the host or requests a concurrent restart (runtime=${withRuntime})`, { skip: process.platform !== "win32" }, t => {
    const child = new EventEmitter();
    child.unref = () => {};
    const writes = [];
    const logs = [];
    const spawn = t.mock.method(childProcess, "spawn", () => child);
    syncBuiltinESMExports();
    t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
    t.mock.method(hostFs, "writeFileSync", (...args) => writes.push(args));
    t.mock.method(hostFs, "appendFileSync", (_file, text) => logs.push(text));
    const exit = t.mock.method(process, "exit", () => {});
    const requestRestart = t.mock.fn();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    scheduleAsarSwapRestart({
      exe: "C:\\fixture\\DeepSeek Harness.exe", asar: "C:\\fixture\\resources\\app.asar",
      exit: true, runtime: withRuntime ? { requestRestart } : null,
    });
    t.mock.timers.tick(10000);
    assert.equal(exit.mock.callCount(), 0);
    assert.equal(requestRestart.mock.callCount(), 0);
    assert.equal(writes[0][1], "\uFEFF" + ASAR_SWAP_PS1);
    const [command, args, options] = spawn.mock.calls[0].arguments;
    assert.equal(command, "powershell.exe");
    assert.ok(args.includes("-NonInteractive"));
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, false);
    child.emit("error", new Error("spawn denied"));
    child.emit("exit", 1, null);
    t.mock.timers.tick(10000);
    assert.equal(exit.mock.callCount(), 0);
    assert.ok(logs.some(text => text.includes("spawn denied")));
    assert.ok(logs.some(text => text.includes("code=1")));
  });
}

// Execute the actual generated PowerShell with all process operations mocked.
// The only real file mutations are inside this test's temporary directory.
const wrapper = `
$env:TEMP = $env:DSH_SWAP_FIXTURE
$global:fixtureTrace = Join-Path $env:TEMP 'trace.txt'
$global:fixtureExe = Join-Path $env:TEMP 'DeepSeek Harness.exe'
$global:fixtureAsar = Join-Path $env:TEMP 'resources\\app.asar'
function Get-CimInstance {
  [CmdletBinding()] param([string]$ClassName)
  # Deliberately return the host first, as CIM makes no ordering guarantee.
  [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10; ExecutablePath = $global:fixtureExe }
  [pscustomobject]@{ ProcessId = 10; ParentProcessId = 999; ExecutablePath = $global:fixtureExe }
  [pscustomobject]@{ ProcessId = 30; ParentProcessId = 999; ExecutablePath = 'C:\\unrelated\\other.exe' }
}
function Stop-Process {
  [CmdletBinding()] param([int]$Id, [switch]$Force)
  Add-Content -LiteralPath $global:fixtureTrace -Value ('stop:' + $Id)
}
function Wait-Process { [CmdletBinding()] param([int]$Id, [int]$Timeout) }
function Get-Process {
  [CmdletBinding()] param([int]$Id, [string[]]$Name)
  if ($env:DSH_SWAP_FAULT -eq 'stop' -and $Id -eq 10) { [pscustomobject]@{ Id = 10 } }
}
function Start-Sleep { param($Milliseconds, $Seconds) }
function Move-Item {
  [CmdletBinding()] param($LiteralPath, $Destination, [switch]$Force)
  if ($env:DSH_SWAP_FAULT -eq 'move') { Write-Error 'simulated locked archive'; return }
  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force -ErrorAction Stop
}
function Start-Process {
  [CmdletBinding()] param($FilePath, $WindowStyle)
  if (Test-Path -LiteralPath $global:fixtureAsar) { throw 'relaunched before swap' }
  if (-not (Test-Path -LiteralPath ($global:fixtureAsar + '.bak'))) { throw 'backup missing' }
  if ($env:ELECTRON_RUN_AS_NODE) { throw 'Electron would restart in Node mode' }
  if ($env:DSH_PROFILE -ne 'desktop') { throw 'desktop profile missing' }
  if ($WindowStyle -eq 'Hidden') { throw 'interactive desktop must not stay hidden' }
  Add-Content -LiteralPath $global:fixtureTrace -Value 'launch'
}
& (Join-Path $env:TEMP 'swap.ps1') -WaitPid 20 -ExePath $global:fixtureExe -AsarPath $global:fixtureAsar
exit $LASTEXITCODE
`;

for (const fault of ["none", "move", "stop"]) {
  test(`PowerShell swap handles ${fault} failure without unsafe relaunch`, { skip: process.platform !== "win32" }, t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, "resources"));
    const asar = path.join(root, "resources", "app.asar");
    fs.writeFileSync(asar, "archive fixture");
    fs.writeFileSync(path.join(root, "swap.ps1"), "\uFEFF" + ASAR_SWAP_PS1);
    const harness = path.join(root, "harness.ps1");
    fs.writeFileSync(harness, "\uFEFF" + wrapper);
    const result = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
      windowsHide: true, encoding: "utf8", timeout: 30000,
      env: { ...process.env, DSH_SWAP_FIXTURE: root, DSH_SWAP_FAULT: fault, ELECTRON_RUN_AS_NODE: "1", DSH_PROFILE: "" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "", result.stderr);
    const log = fs.readFileSync(path.join(root, "dsh-purge-asar-swap.log"), "utf8");
    assert.equal(result.status, fault === "none" ? 0 : 1, log);
    assert.ok(fs.existsSync(path.join(root, "trace.txt")), log);
    const trace = fs.readFileSync(path.join(root, "trace.txt"), "utf8").trim().split(/\r?\n/);
    assert.equal(trace[0], "stop:10");
    assert.ok(!trace.includes("stop:30"));
    if (fault === "none") {
      assert.equal(trace[1], "stop:20");
      assert.equal(trace.at(-1), "launch");
      assert.equal(fs.existsSync(asar), false);
      assert.equal(fs.readFileSync(asar + ".bak", "utf8"), "archive fixture");
      assert.ok(log.includes("relaunch started"));
    } else {
      assert.ok(!trace.includes("launch"));
      assert.equal(fs.readFileSync(asar, "utf8"), "archive fixture");
      assert.ok(log.includes("failed:"));
      if (fault === "stop") assert.ok(!trace.includes("stop:20"));
    }
  });
}

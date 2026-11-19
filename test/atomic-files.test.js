import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicCopyFile, atomicCopyFileSync, atomicWriteFile, atomicWriteSync } from "../lib/core.js";
import { repairOfficialCliAfterUnpack } from "../lib/desktop.js";
import { hostFs } from "../lib/extract-asar.js";

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "dsh-purge-atomic-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("dsh-purge-atomic-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

for (const operation of ["copy", "write"]) {
  test(`concurrent atomic ${operation} calls in one millisecond keep complete contents`, async (t) => {
    const root = fixture(t);
    const target = path.join(root, "target.txt");
    const contents = Array.from({ length: 16 }, (_, i) => `payload-${i}\n`.repeat(1024));
    const sources = contents.map((text, i) => {
      const source = path.join(root, `source-${i}.txt`);
      fs.writeFileSync(source, text);
      return source;
    });
    t.mock.method(Date, "now", () => 1795091282305);
    const results = await Promise.allSettled(contents.map((text, i) => operation === "copy"
      ? atomicCopyFile(sources[i], target)
      : atomicWriteFile(target, text)));
    for (const result of results) assert.equal(result.status, "fulfilled", String(result.reason));
    assert.ok(contents.includes(fs.readFileSync(target, "utf8")));
    assert.deepEqual(fs.readdirSync(root).filter(name => /\.(copytmp|tmp)$/.test(name)), []);
  });
}

test("failed async copy removes partial temporary data and preserves the destination", async (t) => {
  const root = fixture(t);
  const target = path.join(root, "target.txt");
  fs.writeFileSync(target, "existing backup");
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  t.mock.method(hostFs.promises, "copyFile", async (_source, temp) => {
    fs.writeFileSync(temp, "partial copy");
    throw error;
  });
  await assert.rejects(atomicCopyFile(path.join(root, "source.txt"), target), e => e === error);
  assert.equal(fs.readFileSync(target, "utf8"), "existing backup");
  assert.deepEqual(fs.readdirSync(root), ["target.txt"]);
});

test("failed synchronous copy cleans up and throws to its caller", (t) => {
  const root = fixture(t);
  const target = path.join(root, "target.txt");
  fs.writeFileSync(target, "existing backup");
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  t.mock.method(hostFs, "copyFileSync", (_source, temp) => {
    fs.writeFileSync(temp, "partial copy");
    throw error;
  });
  assert.throws(() => atomicCopyFileSync(path.join(root, "source.txt"), target), e => e === error);
  assert.equal(fs.readFileSync(target, "utf8"), "existing backup");
  assert.deepEqual(fs.readdirSync(root), ["target.txt"]);
});

for (const sync of [false, true]) {
  test(`failed ${sync ? "sync" : "async"} atomic write removes partial temporary data`, async (t) => {
    const root = fixture(t);
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "original");
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const fail = (temp) => {
      fs.writeFileSync(temp, "partial write");
      throw error;
    };
    if (sync) {
      t.mock.method(hostFs, "writeFileSync", fail);
      assert.throws(() => atomicWriteSync(target, "replacement"), e => e === error);
    } else {
      t.mock.method(hostFs.promises, "writeFile", async temp => fail(temp));
      await assert.rejects(atomicWriteFile(target, "replacement"), e => e === error);
    }
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(root), ["target.txt"]);
  });
}

function cliFixture(t) {
  const root = fixture(t);
  const exe = path.join(root, "DeepSeek Harness.exe");
  const bin = path.join(root, "resources", "runtime", "cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const cmd = path.join(bin, "dsh.cmd");
  const original = '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n';
  fs.writeFileSync(cmd, original);
  return { exe, bin, cmd, original, backup: `${cmd}.dsh-purge.bak` };
}

test("CLI repair finishes the original backup before changing the launcher and is repeatable", (t) => {
  const { exe, cmd, original, backup } = cliFixture(t);
  const report = repairOfficialCliAfterUnpack(exe);
  assert.equal(report.ok, true);
  assert.equal(report.shims.find(s => s.path === cmd).status, "patched");
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  const patched = fs.readFileSync(cmd, "utf8");
  assert.notEqual(patched, original);
  assert.ok(patched.includes("app.asar.unpacked"));
  assert.equal(repairOfficialCliAfterUnpack(exe).shims.find(s => s.path === cmd).status, "already");
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  assert.equal(fs.readFileSync(cmd, "utf8"), patched);
});

test("CLI repair reports backup failure without changing the launcher or rejecting asynchronously", async (t) => {
  const { exe, bin, cmd, original, backup } = cliFixture(t);
  // A directory at the destination forces rename to fail on Windows and Unix.
  fs.mkdirSync(backup);
  const report = repairOfficialCliAfterUnpack(exe);
  assert.equal(report.ok, false);
  const failure = report.shims.find(s => s.path === cmd);
  assert.equal(failure.status, "backup_error");
  assert.ok(failure.error);
  assert.equal(fs.readFileSync(cmd, "utf8"), original);
  assert.deepEqual(fs.readdirSync(bin).sort(), ["dsh.cmd", "dsh.cmd.dsh-purge.bak"]);
  await new Promise(resolve => setImmediate(resolve));
});

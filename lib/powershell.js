import { spawn } from "node:child_process";

function quoteWindowsArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** Start an independent hidden console: detached:true skips script execution,
 * while a directly attached PowerShell can die when its Node parent exits. */
export function spawnHiddenPowerShell(script, args = []) {
  const commandLine = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args]
    .map(quoteWindowsArgument).join(" ");
  const literal = "'" + commandLine.replaceAll("'", "''") + "'";
  const command = "$ErrorActionPreference = 'Stop'; Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList " + literal;
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    // This short-lived launcher stays attached; Start-Process creates the
    // independent hidden helper that owns shutdown, swap and relaunch.
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
}

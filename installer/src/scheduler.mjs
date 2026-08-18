import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const SCHEDULER_LABEL = 'com.vaibhavarora.job-application-agent-update';
export const LEGACY_SCHEDULER_LABEL = 'com.vaibhavarora.codex.job-application-agent-update';
export const CHECK_RUNNER_FILENAME = 'check-update-runner.mjs';
const SKILL_NAME = 'job-application-agent';
const execFileAsync = promisify(execFile);

async function defaultRunCommand(command, args) {
  await execFileAsync(command, args);
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function assertExactVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error('The scheduled check requires an exact immutable semantic version.');
  return value;
}

function isAbsoluteForPlatform(value, platform) {
  return platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

function assertAbsolute(value, label, platform) {
  if (typeof value !== 'string' || !isAbsoluteForPlatform(value, platform)) throw new Error(`${label} must be an absolute path.`);
  return value;
}

// systemd parses ExecStart into argv without a shell. Escape its metacharacters
// so every value is treated as a literal argument.
function systemdQuote(value) {
  let out = '"';
  for (const ch of value) {
    if (ch === '"' || ch === '\\' || ch === '$' || ch === '`') out += `\\${ch}`;
    else if (ch === '%') out += '%%';
    else out += ch;
  }
  out += '"';
  return out;
}

// MSVCRT/CreateProcess quoting so Task Scheduler passes each argument verbatim.
function windowsQuoteArg(value) {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') { backslashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes); backslashes = 0; out += ch;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

function powershellSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function writeExecutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

function agentHomeFor(homeDir, agentHome) {
  return agentHome || path.join(homeDir, '.agents');
}

function checkRunnerPath(agentHome) {
  return path.join(agentHome, SKILL_NAME, CHECK_RUNNER_FILENAME);
}

async function removeDarwinLaunchAgent(homeDir, label, userId, runCommand) {
  const filePath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  try { await runCommand('launchctl', ['bootout', `gui/${userId}`, filePath]); } catch {}
  await rm(filePath, { force: true });
}

export async function installScheduler({ platform = process.platform, homeDir, agentHome, nodePath, checkScriptPath, packageVersion, userId = process.getuid?.(), runCommand = defaultRunCommand }) {
  if (platform === 'test') return { installed: false, platform };
  const resolvedAgentHome = agentHomeFor(homeDir, agentHome);
  const logsDir = path.join(resolvedAgentHome, 'logs');
  await mkdir(logsDir, { recursive: true });
  assertAbsolute(nodePath, 'The scheduled Node.js executable', platform);
  assertAbsolute(checkScriptPath, 'The scheduled check runner', platform);
  const exactVersion = assertExactVersion(packageVersion);

  if (platform === 'darwin') {
    await removeDarwinLaunchAgent(homeDir, LEGACY_SCHEDULER_LABEL, userId, runCommand);
    const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
    const filePath = path.join(launchAgents, `${SCHEDULER_LABEL}.plist`);
    await mkdir(launchAgents, { recursive: true });
    const argv = [nodePath, checkScriptPath, resolvedAgentHome, exactVersion];
    const argvXml = argv.map(arg => `  <string>${xml(arg)}</string>`).join('\n');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${SCHEDULER_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argvXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>3600</integer>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>${xml(path.join(logsDir, 'job-application-agent-update.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'job-application-agent-update.log'))}</string>\n</dict></plist>\n`;
    await writeFile(filePath, plist, { mode: 0o600 });
    const domain = `gui/${userId}`;
    try { await runCommand('launchctl', ['bootout', domain, filePath]); } catch {}
    await runCommand('launchctl', ['bootstrap', domain, filePath]);
    return { installed: true, platform, path: filePath };
  }

  if (platform === 'linux') {
    const systemdDir = path.join(homeDir, '.config', 'systemd', 'user');
    const servicePath = path.join(systemdDir, 'job-application-agent-update.service');
    const timerPath = path.join(systemdDir, 'job-application-agent-update.timer');
    await mkdir(systemdDir, { recursive: true });
    const execLine = [nodePath, checkScriptPath, resolvedAgentHome, exactVersion].map(systemdQuote).join(' ');
    await writeFile(servicePath, `[Unit]\nDescription=Check Job Application Agent updates safely\n\n[Service]\nType=oneshot\nExecStart=${execLine}\n`, { mode: 0o600 });
    await writeFile(timerPath, `[Unit]\nDescription=Check Job Application Agent updates safely hourly\n\n[Timer]\nOnBootSec=2m\nOnUnitActiveSec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
    await runCommand('systemctl', ['--user', 'daemon-reload']);
    await runCommand('systemctl', ['--user', 'enable', '--now', 'job-application-agent-update.timer']);
    return { installed: true, platform, servicePath, timerPath };
  }

  if (platform === 'win32') {
    const scriptPath = path.join(resolvedAgentHome, SKILL_NAME, 'register-update-task.ps1');
    const argumentLine = [checkScriptPath, resolvedAgentHome, exactVersion].map(windowsQuoteArg).join(' ');
    const action = `New-ScheduledTaskAction -Execute ${powershellSingleQuote(nodePath)} -Argument ${powershellSingleQuote(argumentLine)}`;
    const script = `$action = ${action}\n$logon = New-ScheduledTaskTrigger -AtLogOn\n$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)\nRegister-ScheduledTask -TaskName 'JobApplicationAgentUpdate' -Action $action -Trigger @($logon, $hourly) -Force | Out-Null\n`;
    await writeExecutable(scriptPath, script);
    await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
    return { installed: true, platform, scriptPath };
  }

  return { installed: false, platform, reason: 'unsupported-platform' };
}

export async function removeScheduler({ platform = process.platform, homeDir, agentHome, userId = process.getuid?.(), runCommand = defaultRunCommand }) {
  const resolvedAgentHome = agentHomeFor(homeDir, agentHome);
  const managerDir = path.join(resolvedAgentHome, SKILL_NAME);
  if (platform === 'darwin') {
    await removeDarwinLaunchAgent(homeDir, SCHEDULER_LABEL, userId, runCommand);
    await removeDarwinLaunchAgent(homeDir, LEGACY_SCHEDULER_LABEL, userId, runCommand);
  } else if (platform === 'linux') {
    const systemdDir = path.join(homeDir, '.config', 'systemd', 'user');
    try { await runCommand('systemctl', ['--user', 'disable', '--now', 'job-application-agent-update.timer']); } catch {}
    await rm(path.join(systemdDir, 'job-application-agent-update.service'), { force: true });
    await rm(path.join(systemdDir, 'job-application-agent-update.timer'), { force: true });
    try { await runCommand('systemctl', ['--user', 'daemon-reload']); } catch {}
  } else if (platform === 'win32') {
    try { await runCommand('schtasks.exe', ['/Delete', '/TN', 'JobApplicationAgentUpdate', '/F']); } catch {}
  }
  await rm(checkRunnerPath(resolvedAgentHome), { force: true });
  await rm(path.join(managerDir, 'check-update'), { force: true });
  await rm(path.join(managerDir, 'check-update.cmd'), { force: true });
  await rm(path.join(managerDir, 'update-status.json'), { force: true });
  await rm(path.join(managerDir, 'register-update-task.ps1'), { force: true });
  await rm(path.join(homeDir, '.codex', SKILL_NAME, 'register-update-task.ps1'), { force: true });
  await rm(path.join(resolvedAgentHome, 'logs', 'job-application-agent-update.log'), { force: true });
  return { removed: true, platform };
}

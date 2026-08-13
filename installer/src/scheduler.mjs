import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const SCHEDULER_LABEL = 'com.vaibhavarora.codex.job-application-agent-update';
const execFileAsync = promisify(execFile);

async function defaultRunCommand(command, args) {
  await execFileAsync(command, args);
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function writeExecutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { mode: 0o700 });
  await chmod(filePath, 0o700);
}

export async function installScheduler({ platform = process.platform, homeDir, command, userId = process.getuid?.(), runCommand = defaultRunCommand }) {
  if (platform === 'test') return { installed: false, platform };
  const logsDir = path.join(homeDir, '.codex', 'logs');
  await mkdir(logsDir, { recursive: true });

  if (platform === 'darwin') {
    const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
    const filePath = path.join(launchAgents, `${SCHEDULER_LABEL}.plist`);
    await mkdir(launchAgents, { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${SCHEDULER_LABEL}</string>\n  <key>ProgramArguments</key><array><string>${xml(command)}</string><string>auto-update</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>3600</integer>\n  <key>StandardOutPath</key><string>${xml(path.join(logsDir, 'job-application-agent-update.log'))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, 'job-application-agent-update.log'))}</string>\n</dict></plist>\n`;
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
    await writeFile(servicePath, `[Unit]\nDescription=Update Job Application Agent skill\n\n[Service]\nType=oneshot\nExecStart=${command} auto-update\n`, { mode: 0o600 });
    await writeFile(timerPath, `[Unit]\nDescription=Update Job Application Agent skill hourly\n\n[Timer]\nOnBootSec=2m\nOnUnitActiveSec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, { mode: 0o600 });
    await runCommand('systemctl', ['--user', 'daemon-reload']);
    await runCommand('systemctl', ['--user', 'enable', '--now', 'job-application-agent-update.timer']);
    return { installed: true, platform, servicePath, timerPath };
  }

  if (platform === 'win32') {
    const scriptPath = path.join(homeDir, '.codex', 'job-application-agent', 'register-update-task.ps1');
    const script = `$action = New-ScheduledTaskAction -Execute '${command.replaceAll("'", "''")}' -Argument 'auto-update'\n$logon = New-ScheduledTaskTrigger -AtLogOn\n$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)\nRegister-ScheduledTask -TaskName 'JobApplicationAgentUpdate' -Action $action -Trigger @($logon, $hourly) -Force | Out-Null\n`;
    await writeExecutable(scriptPath, script);
    await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
    return { installed: true, platform, scriptPath };
  }

  return { installed: false, platform, reason: 'unsupported-platform' };
}

export async function removeScheduler({ platform = process.platform, homeDir, userId = process.getuid?.(), runCommand = defaultRunCommand }) {
  if (platform === 'darwin') {
    const filePath = path.join(homeDir, 'Library', 'LaunchAgents', `${SCHEDULER_LABEL}.plist`);
    try { await runCommand('launchctl', ['bootout', `gui/${userId}`, filePath]); } catch {}
    await rm(filePath, { force: true });
  } else if (platform === 'linux') {
    const systemdDir = path.join(homeDir, '.config', 'systemd', 'user');
    try { await runCommand('systemctl', ['--user', 'disable', '--now', 'job-application-agent-update.timer']); } catch {}
    await rm(path.join(systemdDir, 'job-application-agent-update.service'), { force: true });
    await rm(path.join(systemdDir, 'job-application-agent-update.timer'), { force: true });
    try { await runCommand('systemctl', ['--user', 'daemon-reload']); } catch {}
  } else if (platform === 'win32') {
    try { await runCommand('schtasks.exe', ['/Delete', '/TN', 'JobApplicationAgentUpdate', '/F']); } catch {}
    await rm(path.join(homeDir, '.codex', 'job-application-agent', 'register-update-task.ps1'), { force: true });
  }
  return { removed: true, platform };
}

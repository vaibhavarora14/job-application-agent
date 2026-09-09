import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function createUpdateRunner({ platform = process.platform, agentHome, codexHome, nodePath = process.execPath, npmCliPath }) {
  if (!npmCliPath) throw new Error('npm CLI path is required to create the automatic-update runner.');
  const home = agentHome || codexHome;
  const managerDir = path.join(home, 'job-application-agent');
  const nodeDir = path.dirname(nodePath);
  await mkdir(managerDir, { recursive: true });
  if (platform === 'win32') {
    const filePath = path.join(managerDir, 'update.cmd');
    const script = `@echo off\r\nset "JOB_APPLICATION_AGENT_HOME=${home}"\r\nset "PATH=${nodeDir};%PATH%"\r\n"${nodePath}" "${npmCliPath}" exec --yes --package=job-application-agent@latest -- job-application-agent auto-update\r\n`;
    await writeFile(filePath, script, { mode: 0o700 });
    return { path: filePath };
  }
  const filePath = path.join(managerDir, 'update');
  const script = `#!/bin/sh\nJOB_APPLICATION_AGENT_HOME=${shellQuote(home)}\nPATH=${shellQuote(nodeDir)}:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}\nexport JOB_APPLICATION_AGENT_HOME PATH\nexec ${shellQuote(nodePath)} ${shellQuote(npmCliPath)} exec --yes --package=job-application-agent@latest -- job-application-agent auto-update\n`;
  await writeFile(filePath, script, { mode: 0o700 });
  await chmod(filePath, 0o700);
  return { path: filePath };
}

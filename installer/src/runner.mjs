import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function createUpdateRunner({ platform = process.platform, codexHome, nodePath = process.execPath, npmCliPath }) {
  if (!npmCliPath) throw new Error('npm CLI path is required to create the automatic-update runner.');
  const managerDir = path.join(codexHome, 'job-application-agent');
  const nodeDir = path.dirname(nodePath);
  await mkdir(managerDir, { recursive: true });
  if (platform === 'win32') {
    const filePath = path.join(managerDir, 'update.cmd');
    const script = `@echo off\r\nset "CODEX_HOME=${codexHome}"\r\nset "PATH=${nodeDir};%PATH%"\r\n"${nodePath}" "${npmCliPath}" exec --yes --package=job-application-agent@latest -- job-application-agent auto-update\r\n`;
    await writeFile(filePath, script, { mode: 0o700 });
    return { path: filePath };
  }
  const filePath = path.join(managerDir, 'update');
  const script = `#!/bin/sh\nCODEX_HOME=${shellQuote(codexHome)}\nPATH=${shellQuote(nodeDir)}:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}\nexport CODEX_HOME PATH\nexec ${shellQuote(nodePath)} ${shellQuote(npmCliPath)} exec --yes --package=job-application-agent@latest -- job-application-agent auto-update\n`;
  await writeFile(filePath, script, { mode: 0o700 });
  await chmod(filePath, 0o700);
  return { path: filePath };
}

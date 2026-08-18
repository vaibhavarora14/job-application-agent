#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HIGH_RISK_PATHS = [
  /^\.github\//,
  /^installer\//,
  /^job-application-agent\/scripts\//,
  /^bin\//,
  /^scripts\/ci\//,
  /^scripts\/smoke-package\.mjs$/,
  /^package(?:-lock)?\.json$/,
  /^SECURITY\.md$/,
];

const CODE_PATH = /\.(?:cjs|js|mjs|ts|tsx)$/i;
const DEPENDENCY_PATHS = new Set([
  '.github/requirements-ci.txt',
  'package-lock.json',
  'package.json',
]);

export function parseNameStatusZ(input) {
  const tokens = Buffer.isBuffer(input) ? input.toString('utf8').split('\0') : String(input).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const paths = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const firstPath = tokens[index++];
    if (!status || !firstPath) throw new Error('Invalid git --name-status -z input.');
    paths.push(firstPath);
    if (/^[CR]/.test(status)) {
      const secondPath = tokens[index++];
      if (!secondPath) throw new Error(`Git status ${status} is missing its destination path.`);
      paths.push(secondPath);
    }
  }

  return paths;
}

export function classifyChangedPaths(paths) {
  const normalized = [...new Set(paths.map(value => String(value).replaceAll('\\', '/')))];
  return {
    codeChanged: normalized.some(changedPath => CODE_PATH.test(changedPath)),
    dependencyChanged: normalized.some(changedPath => DEPENDENCY_PATHS.has(changedPath)),
    highRisk: normalized.some(changedPath => HIGH_RISK_PATHS.some(pattern => pattern.test(changedPath))),
  };
}

function main() {
  const paths = parseNameStatusZ(readFileSync(0));
  const classification = classifyChangedPaths(paths);
  const outputs = [
    `code_changed=${classification.codeChanged}`,
    `dependency_changed=${classification.dependencyChanged}`,
    `high_risk=${classification.highRisk}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify({ paths, ...classification })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

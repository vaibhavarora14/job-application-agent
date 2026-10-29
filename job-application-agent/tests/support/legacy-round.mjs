// Test-only helper: make a round look like one started by a CLI from before the local routine
// gates (3.8.3 and earlier), which never wrote a gates record. Those rounds keep the earlier
// coverage rules; tests of the gates themselves leave the record in place.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function asLegacyRound(stateDir, roundId) {
  const file = join(stateDir, 'round-evidence.ndjson');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const kept = lines.filter((line) => {
    const event = JSON.parse(line);
    return !(event.type === 'round-gates' && event.roundId === roundId);
  });
  await writeFile(file, kept.length ? `${kept.join('\n')}\n` : '');
}

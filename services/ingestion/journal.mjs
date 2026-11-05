import {appendFile} from 'node:fs/promises';

// Global quarantine for requests without an authorized tenant. Never persist request bodies,
// tokens, signatures, claimed tenant IDs or exception messages. Operator supplies a private path.
export function createFileRejectionJournal(path) {
  return async record => appendFile(path, JSON.stringify({
    receivedAt: record.receivedAt, reason: record.reason, envelopeDigest: record.envelopeDigest
  }) + '\n', {encoding: 'utf8', mode: 0o600});
}

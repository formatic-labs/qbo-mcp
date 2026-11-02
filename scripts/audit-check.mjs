#!/usr/bin/env node
// CI dependency gate: fails on any high/critical production advisory that is
// not on the reviewed allowlist below. npm audit has no built-in allowlist,
// so this wraps `npm audit --json`.
//
// Each allowlist entry needs a reason and a recheck trigger. Remove an entry
// as soon as a compatible fix ships.
import { execSync } from 'node:child_process';

const ALLOWLIST = {
  // decode-uri-component <=0.5.0 (DoS), pulled in by intuit-oauth@4 -> query-string@6.
  // No compatible fix: 0.5.1 is ESM-only and breaks query-string@6's require().
  // Reachability is low: it only parses the OAuth callback URL in the local
  // stdio sign-in flow; hosted mode never calls it.
  // Recheck when intuit-oauth releases a version off query-string@6.
  'GHSA-qr28-fpjm-wq7f': 'decode-uri-component DoS via intuit-oauth (no compatible fix)',
  'GHSA-vcc3-ghjq-m6fr': 'decode-uri-component DoS via intuit-oauth (no compatible fix)',
};

const BLOCKING = new Set(['high', 'critical']);

let raw;
try {
  raw = execSync('npm audit --omit=dev --json', { encoding: 'utf8' });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  raw = err.stdout;
}

const report = JSON.parse(raw);
const blocking = [];
const allowed = [];

for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    // String entries point at another package's advisory, reported on its own.
    if (typeof via === 'string') continue;
    const id = via.url?.split('/').pop();
    if (!BLOCKING.has(via.severity)) continue;
    if (id && ALLOWLIST[id]) allowed.push(`${id} (${via.name}): ${ALLOWLIST[id]}`);
    else blocking.push(`${id ?? via.source} (${via.name}, ${via.severity}): ${via.title}`);
  }
}

for (const line of new Set(allowed)) console.log(`allowlisted  ${line}`);
if (blocking.length) {
  for (const line of new Set(blocking)) console.error(`BLOCKING     ${line}`);
  process.exit(1);
}
console.log('No unreviewed high or critical production advisories.');

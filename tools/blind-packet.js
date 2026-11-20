/**
 * Blind adjudication packets.
 *
 * An adjudicator must see the task, the result, the source state and the evidence available
 * to that run — and must not see which arm produced it. This builds that packet and proves
 * the arm label is absent, rather than promising it is.
 *
 * The packet deliberately omits: arm, model, timestamps, token counts, and anything else that
 * correlates with arm. `result` and `evidence_available` are what the judgement needs.
 *
 * Usage:
 *   node tools/blind-packet.js --transcript <path> --gold <path> --out pilot/adjudication/packets
 *   node tools/blind-packet.js --selftest
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

/** Fields that would reveal the arm or bias the judgement via cost/time. */
const REDACT = ['arm', 'model', 'tokens', 'tokens_to_first_productive_action', 'turns', 'oracle_passed', 'latency_ms'];

export function buildPacket(transcript, gold) {
  const packet = {
    schema: 'gca-adjudication-packet/v1',
    task: transcript.task ?? null,
    result: {
      files_changed: transcript.files_changed ?? [],
      files_read: transcript.files_read ?? [],
      claims: (transcript.claims ?? []).map((claim) => ({ text: claim.text, supported_by: claim.supported_by ?? [] })),
    },
    evidence_available: transcript.evidence_available ?? transcript.files_read ?? [],
    gold: {
      impacted_files: gold.impacted_files ?? [],
      impacted_symbols: gold.impacted_symbols ?? [],
      dependency_edges: gold.dependency_edges ?? [],
      must_not_break: gold.must_not_break ?? [],
    },
  };
  for (const field of REDACT) {
    if (field === 'result') continue;
    delete packet[field];
  }
  const packetId = `pkt_${createHash('sha256').update(JSON.stringify({ task: packet.task, result: packet.result })).digest('hex').slice(0, 16)}`;
  return { packet_id: packetId, ...packet };
}

/** True when no redacted field name appears anywhere in the serialised packet. */
export function isBlind(packet) {
  const serialised = JSON.stringify(packet).toLowerCase();
  return REDACT.every((field) => !serialised.includes(`"${field.toLowerCase()}"`));
}

function selftest() {
  const transcript = {
    arm: 'treatment',
    task: 'C4',
    files_read: ['src/spans.js'],
    files_changed: ['src/diff.js'],
    claims: [{ text: 'diff imports the renamed helper', supported_by: ['src/diff.js'] }],
    tokens: { input: 900, output: 200 },
    oracle_passed: true,
  };
  const gold = { impacted_files: ['src/spans.js', 'src/diff.js'], impacted_symbols: ['findOccurrences'], dependency_edges: [] };
  const packet = buildPacket(transcript, gold);
  const checks = [
    ['arm removed', packet.arm === undefined],
    ['tokens removed', packet.tokens === undefined],
    ['oracle verdict removed', packet.oracle_passed === undefined],
    ['task preserved', packet.task === 'C4'],
    ['result preserved', packet.result.files_changed[0] === 'src/diff.js'],
    ['evidence preserved', packet.evidence_available.includes('src/spans.js')],
    ['packet blind', isBlind(packet)],
    ['packet id stable', packet.packet_id === buildPacket(transcript, gold).packet_id],
    ['different result → different id', packet.packet_id !== buildPacket({ ...transcript, files_changed: ['src/spans.js'] }, gold).packet_id],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(`blind packet selftest: ${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const get = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1];
  };
  const transcriptPath = get('--transcript');
  const goldPath = get('--gold');
  const out = get('--out') ?? 'pilot/adjudication/packets';
  if (!transcriptPath || !goldPath) {
    console.log('usage: node tools/blind-packet.js --transcript <path> --gold <path> [--out dir] | --selftest');
    process.exit(2);
  }

  const transcript = JSON.parse(await readFile(new URL(transcriptPath, ROOT), 'utf8'));
  const gold = JSON.parse(await readFile(new URL(goldPath, ROOT), 'utf8'));
  const packet = buildPacket(transcript, gold);
  if (!isBlind(packet)) {
    console.error('refused: packet is not blind');
    process.exit(1);
  }
  await mkdir(new URL(`${out}/`, ROOT), { recursive: true });
  await writeFile(new URL(`${out}/${packet.packet_id}.json`, ROOT), `${JSON.stringify(packet, null, 2)}\n`);
  console.log(`wrote ${out}/${packet.packet_id}.json (blind)`);
}

// Only run as a CLI when invoked directly; this module is imported by the dry-run checker.
if (process.argv[1]?.endsWith('blind-packet.js')) await main();

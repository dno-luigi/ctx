/**
 * Plant coverage — the compaction pilot's stop-rule probe.
 *
 * H2 asks whether an agent can recover working state across a context boundary from a
 * GCA snapshot. That question is only meaningful if the snapshot contains the state at
 * all. This tool reads a list of planted decisions/constraints and asks, of an existing
 * snapshot: is there a card that states this, and is that card anchored?
 *
 * A plant that appears only in an unanchored card is counted separately, because such a
 * card cannot be reconstructed from evidence — it can only be repeated or lost.
 *
 * This is a substrate probe over document fixtures, standing in for the engineering task
 * the pilot will actually use. It is not an H2 result.
 *
 * Usage: node tools/plant-coverage.js [--fixtures F3,F9] [--plants pilot/compaction/plants-probe.json]
 */

import { readFile } from 'node:fs/promises';

import { scanInventory } from '../inventory/scan.js';
import { identifySnapshot } from '../cards/identity.js';

const ROOT = new URL('../', import.meta.url);
const options = { fixtures: ['F3', 'F9'], plants: 'pilot/compaction/plants-probe.json', model: 'perplexity/pplx-decider-flash-v1.2', rep: 1 };
for (let index = 0; index < process.argv.length; index += 1) {
  const [flag, inline] = String(process.argv[index]).split('=');
  if (flag === '--fixtures') options.fixtures = (inline ?? process.argv[++index]).split(',');
  else if (flag === '--plants') options.plants = inline ?? process.argv[++index];
}

const plantsFile = JSON.parse(await readFile(new URL(options.plants, ROOT), 'utf8'));
const STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'for', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'its', 'into', 'than', 'then', 'they', 'their', 'which', 'while', 'when', 'what', 'does', 'did', 'only', 'also', 'all', 'any', 'can', 'may', 'will', 'would', 'should', 'must', 'been', 'being', 'same', 'day']);
const tokens = (text) => new Set(String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
const overlap = (claim, plant) => {
  const target = tokens(plant);
  if (target.size === 0) return 0;
  const source = tokens(claim);
  let hits = 0;
  for (const token of target) if (source.has(token)) hits += 1;
  return hits / target.size;
};

const SLUG = options.model.replace(/[/:]/g, '_');
const rows = [];
const summary = { schema: 'gca-plant-coverage/v1', generated_at: new Date().toISOString(), spend: 0, model: options.model, fixtures: {}, note: 'substrate probe, not an H2 result' };

for (const fixture of options.fixtures) {
  const input = JSON.parse(await readFile(new URL(`fixtures/${fixture}/input.json`, ROOT), 'utf8'));
  const survey = scanInventory(input, { maxItems: 20000 });
  const record = JSON.parse(await readFile(new URL(`runs/live/${SLUG}/${fixture}.r${options.rep}.json`, ROOT), 'utf8'));
  const cards = identifySnapshot({ record, survey });
  const plants = plantsFile.fixtures?.[fixture] ?? [];

  const results = plants.map((plant) => {
    const scored = cards.map((card) => ({ card, score: overlap(card.claim, plant.plant) })).sort((left, right) => right.score - left.score);
    const best = scored[0];
    const present = Boolean(best && best.score >= 0.6);
    return {
      plant_id: plant.id,
      kind: plant.kind,
      plant: plant.plant,
      present_as_card: present,
      best_overlap: best ? Number(best.score.toFixed(2)) : 0,
      best_card: present ? best.card.card_id : null,
      best_claim: present ? best.card.claim : null,
      anchored: present ? best.card.anchor_ids.length > 0 : false,
      anchor_count: present ? best.card.anchor_ids.length : 0,
    };
  });

  const present = results.filter((row) => row.present_as_card);
  const anchored = results.filter((row) => row.present_as_card && row.anchored);
  summary.fixtures[fixture] = {
    plants: results.length,
    present_as_card: present.length,
    present_and_anchored: anchored.length,
    plant_coverage: results.length ? Number((present.length / results.length).toFixed(3)) : null,
    anchored_plant_coverage: results.length ? Number((anchored.length / results.length).toFixed(3)) : null,
    results,
  };
  rows.push({ fixture, entry: summary.fixtures[fixture] });
}

console.log('plant coverage (substrate probe — not an H2 result)');
for (const { fixture, entry } of rows) {
  console.log(`\n${fixture}: ${entry.present_as_card}/${entry.plants} present as a card, ${entry.present_and_anchored}/${entry.plants} present and anchored`);
  for (const row of entry.results) {
    const status = !row.present_as_card ? 'ABSENT   ' : row.anchored ? 'anchored  ' : 'UNANCHORED';
    console.log(`  ${row.plant_id} ${status} overlap ${row.best_overlap}  ${row.plant.slice(0, 72)}`);
    if (row.present_as_card && !row.anchored) console.log(`      card says: ${row.best_claim}`);
  }
}

console.log(`\nH2 stop rule (declared in GCA-RDA-COMPACTION-PILOT.md): mean anchored plant coverage ≥ 0.60 to proceed.`);
console.log(`measured: ${rows.map(({ fixture, entry }) => `${fixture} ${entry.anchored_plant_coverage}`).join(', ')}`);

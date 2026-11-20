/**
 * Comparing two candidate generators without merging them.
 *
 * The inventory and the decision-derived proposals are separate instruments; this
 * module reports their relationship and never produces a combined set. Nothing here
 * promotes an inventory item into a card, and nothing marks either side correct.
 *
 * Matching is span overlap, not meaning: an item and a proposal are "overlapping"
 * when a proposal candidate cites the same source region. That is a coincidence of
 * location, which is the strongest claim available without adjudication — so the
 * output says `agreement: 'unadjudicated'` rather than calling it agreement.
 */

export const COMPARE_SCHEMA = 'gca-inventory-compare/v1';

function spansOverlap(left, right) {
  if (!left || !right || left.source_id !== right.source_id) return false;
  if (!left.span || !right.span) return false;
  return left.span.start < right.span.end && right.span.start < left.span.end;
}

function proposalCandidates(proposal) {
  return (proposal?.candidates ?? []).filter((candidate) => candidate?.span);
}

export function compareToProposals({ inventory, proposals, verdicts = [], secondPassCostUsd = null }) {
  const items = inventory?.items ?? [];
  const all = proposals ?? [];

  const matched = new Map(); // item id -> proposal id
  const linked = new Set(); // proposal id
  for (const item of items) {
    for (const proposal of all) {
      const candidates = proposalCandidates(proposal);
      if (candidates.length === 0) continue;
      if (candidates.some((candidate) => (item.spans ?? []).some((ref) => spansOverlap(ref, candidate)))) {
        matched.set(item.id, proposal.id);
        linked.add(proposal.id);
        break;
      }
    }
  }

  const inventoryOnly = items.filter((item) => !matched.has(item.id));
  const modelOnly = all.filter((proposal) => !linked.has(proposal.id));
  const unlinked = modelOnly.filter((proposal) => proposalCandidates(proposal).length === 0);

  const supportedRelationships = verdicts.filter((entry) => entry.verdict === 'supported' && entry.proposal?.type === 'relationship');
  const additionalSupportedRelationships = supportedRelationships.filter((entry) => !linked.has(entry.proposal.id));

  const byKind = {};
  for (const item of items) {
    const bucket = (byKind[item.kind] ??= { items: 0, matched: 0 });
    bucket.items += 1;
    if (matched.has(item.id)) bucket.matched += 1;
  }

  return {
    schema: COMPARE_SCHEMA,
    agreement: 'unadjudicated',
    agreement_note: 'overlap means the two instruments cite the same source region; it is not a judgement that either is right',
    origins: { inventory: 'rule-based, model-independent', model: 'decision-model-derived' },
    indistinguishable: false,
    inventory: { items: items.length, by_kind: byKind },
    proposals: { total: all.length, span_linked: linked.size, span_unlinked: unlinked.length },
    coverage: {
      matched_items: matched.size,
      total_items: items.length,
      ratio: items.length === 0 ? null : Number((matched.size / items.length).toFixed(3)),
    },
    overlap_pairs: [...matched.entries()].map(([item_id, proposal_id]) => ({ item_id, proposal_id })),
    inventory_only: inventoryOnly.map((item) => ({ id: item.id, kind: item.kind, label: item.label })),
    model_only: modelOnly.map((proposal) => ({ id: proposal.id, type: proposal.type, question: proposal.question })),
    unlinked_proposals: unlinked.map((proposal) => ({ id: proposal.id, type: proposal.type })),
    unresolved_inventory_items: inventoryOnly.filter((item) => item.kind === 'unresolved_proposition').map((item) => item.id),
    supported_relationships: supportedRelationships.length,
    additional_supported_relationships: additionalSupportedRelationships.length,
    incremental_cost_usd: secondPassCostUsd,
    incremental_cost_per_additional_relationship:
      secondPassCostUsd !== null && additionalSupportedRelationships.length > 0
        ? Number((secondPassCostUsd / additionalSupportedRelationships.length).toFixed(6))
        : null,
    incremental_cost_note:
      additionalSupportedRelationships.length === 0
        ? 'no supported relationship beyond the inventory’s own candidates, so there is no increment to price'
        : 'cost of the additional pass divided by supported relationships the inventory did not already locate',
  };
}

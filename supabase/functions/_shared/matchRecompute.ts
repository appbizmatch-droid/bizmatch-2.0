import { query } from "./db.ts";
import {
  computeAllDimensionScores,
  computeCompatibility,
  type CompatibilityFounderInput,
  type CompatibilityResult,
  type EvidenceDimension,
  type EvidenceRow,
} from "./founderScoring.ts";
import { notifyAdmins, emitNotification } from "./notifications.ts";

// A pair only counts as a "ready" match once it clears this bar with full
// (non-provisional) coverage and no flagged deal breaker — below it, or
// still provisional, it's not yet worth surfacing as a suggestion.
const MATCH_READY_THRESHOLD = 70;

// Shared by the `matches` Edge Function. Fetches the inputs
// computeCompatibility needs for a founder (dimension scores derived from
// their evidence, capabilities, deal breakers), computes compatibility
// against every other active founder, and upserts the result into
// founder_compatibility — the cached table the Matching screen reads from.
// Mirrors dnaRecompute.ts's placement/shape, and matchModel.ts's old
// "eager pre-scoring, fire-and-forget on profile/evidence writes" pattern
// from the pre-pivot swipe app (see git history) rather than a DB trigger.

async function fetchCompatibilityInput(founderId: string): Promise<CompatibilityFounderInput> {
  const evidenceRows = await query<Record<string, unknown>>(
    `SELECT dimension, source_type, score, weight, is_negative FROM evidence WHERE founder_id = $1`,
    [founderId],
  );
  const evidence: EvidenceRow[] = evidenceRows.map((r) => ({
    dimension: r.dimension as EvidenceDimension,
    source_type: r.source_type as EvidenceRow["source_type"],
    score: Number(r.score),
    weight: Number(r.weight),
    is_negative: !!r.is_negative,
  }));

  const capabilityRows = await query<{ kind: "provide" | "need"; capability: string }>(
    `SELECT kind, capability FROM founder_capabilities WHERE founder_id = $1`,
    [founderId],
  );
  const dealBreakerRows = await query<{ label: string }>(
    `SELECT label FROM deal_breakers WHERE founder_id = $1`,
    [founderId],
  );

  return {
    dimensions: computeAllDimensionScores(evidence),
    capabilities: capabilityRows,
    dealBreakers: dealBreakerRows.map((d) => d.label),
  };
}

// Canonical ordering matches founder_compatibility's `check (founder_a_id <
// founder_b_id)` — comparing the canonical lowercase-hex-with-dashes UUID
// text form byte-for-byte gives the same order as Postgres's binary uuid
// comparison, since the text form is just a fixed-width hex encoding.
function canonicalPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

// Fires the two match-related notification types, but only on the specific
// transition each one means — never on every recompute, which fires on
// nearly every evidence-producing write and would otherwise spam both the
// admins and every founder on each other's behalf constantly.
async function notifyOnTransition(
  aId: string, bId: string, result: CompatibilityResult, previous: { score: number; requiresAdminReview: boolean } | null,
): Promise<void> {
  const becameReviewFlagged = result.requiresAdminReview && !previous?.requiresAdminReview;
  const crossedReadyThreshold = !result.requiresAdminReview && !result.isProvisional
    && result.score >= MATCH_READY_THRESHOLD
    && !(previous && !previous.requiresAdminReview && previous.score >= MATCH_READY_THRESHOLD);

  if (!becameReviewFlagged && !crossedReadyThreshold) return;

  const names = await query<{ id: string; name: string | null }>(
    "SELECT id, name FROM users WHERE id = ANY($1::uuid[])", [[aId, bId]],
  );
  const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? undefined;

  if (becameReviewFlagged) {
    await notifyAdmins("deal_breaker_flagged", null, {
      founderId: aId,
      title: `${nameOf(aId) ?? "A founder"} × ${nameOf(bId) ?? "a founder"}`,
      detail: result.dealBreakerFlags[0] ?? "A potential deal breaker needs review.",
    });
  }
  if (crossedReadyThreshold) {
    // FND-08: a founder already on a team isn't shopping for a partner (the
    // founder-self UI hides the Matches tab entirely once founder.team is
    // set — see FounderProfileScreen.js), and neither is anyone paired with
    // one — so a new-match suggestion is moot for both sides once either is
    // already teamed. Skip the notification rather than firing one with
    // nowhere for the recipient to act on it.
    const teamed = await query<{ founder_id: string }>(
      "SELECT founder_id FROM team_founders WHERE founder_id = ANY($1::uuid[])", [[aId, bId]],
    );
    if (teamed.length === 0) {
      // ref_id is bigint — the other founder's id is a uuid, so it can't go there;
      // it's carried in payload.founderId instead (what the bell's tap-to-navigate reads).
      await Promise.all([
        emitNotification(aId, "match_ready", null, { founderId: bId, founderName: nameOf(bId), name: nameOf(bId) }),
        emitNotification(bId, "match_ready", null, { founderId: aId, founderName: nameOf(aId), name: nameOf(aId) }),
      ]);
    }
  }
}

async function upsertCompatibility(aId: string, bId: string, result: CompatibilityResult): Promise<void> {
  const previousRows = await query<{ score: string; requires_admin_review: boolean }>(
    "SELECT score, requires_admin_review FROM founder_compatibility WHERE founder_a_id = $1 AND founder_b_id = $2",
    [aId, bId],
  );
  const previous = previousRows[0]
    ? { score: Number(previousRows[0].score), requiresAdminReview: previousRows[0].requires_admin_review }
    : null;

  await query(
    `INSERT INTO founder_compatibility
       (founder_a_id, founder_b_id, score, dimension_breakdown, explanation, deal_breaker_flags, requires_admin_review, is_provisional, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (founder_a_id, founder_b_id) DO UPDATE SET
       score = EXCLUDED.score,
       dimension_breakdown = EXCLUDED.dimension_breakdown,
       explanation = EXCLUDED.explanation,
       deal_breaker_flags = EXCLUDED.deal_breaker_flags,
       requires_admin_review = EXCLUDED.requires_admin_review,
       is_provisional = EXCLUDED.is_provisional,
       computed_at = now()`,
    [
      aId, bId, result.score,
      JSON.stringify(result.dimensionBreakdown),
      JSON.stringify(result.explanation),
      JSON.stringify(result.dealBreakerFlags),
      result.requiresAdminReview,
      result.isProvisional,
    ],
  );

  await notifyOnTransition(aId, bId, result, previous);
}

// Recomputes and caches compatibility between `founderId` and every other
// active founder. Called fire-and-forget after evidence/assessment/
// peer-feedback writes and after profile/capability edits, and can also be
// awaited directly for a synchronous "compute now" admin action.
export async function recomputeMatchesForFounder(founderId: string): Promise<void> {
  // FND-04/TEAM-02: a prospect (added via the evaluator's "add an
  // unregistered founder" flow, e.g. to attach an interview pre-signup)
  // can still have evidence-producing events fire this — without this
  // guard, the prospect would still get pairwise compatibility computed
  // against every real founder, and appear as a match suggestion in THEIR
  // lists even though a prospect can never actually join a team.
  const selfRows = await query<{ is_prospect: boolean }>(
    `SELECT is_prospect FROM founder_profiles WHERE user_id = $1`,
    [founderId],
  );
  if (selfRows[0]?.is_prospect) return;

  // Prospects default to status='active' (same as a real registered
  // founder), so this filter alone never excluded them from the other
  // side of the pair either — they could show up as match suggestions
  // despite being ineligible for a team (teams/model.ts's create() already
  // rejects them there, but the suggestion itself shouldn't be offered).
  const others = await query<{ id: string }>(
    `SELECT u.id FROM users u JOIN founder_profiles fp ON fp.user_id = u.id
     WHERE u.role = 'founder' AND u.id <> $1 AND fp.status = 'active' AND fp.is_prospect IS NOT TRUE`,
    [founderId],
  );
  if (others.length === 0) return;

  const founderInput = await fetchCompatibilityInput(founderId);
  for (const other of others) {
    const otherInput = await fetchCompatibilityInput(other.id);
    const [aId, bId] = canonicalPair(founderId, other.id);
    const [aInput, bInput] = aId === founderId ? [founderInput, otherInput] : [otherInput, founderInput];
    const result = computeCompatibility(aInput, bInput);
    await upsertCompatibility(aId, bId, result);
  }
}

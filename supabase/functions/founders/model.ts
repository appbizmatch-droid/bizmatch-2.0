import { query, parseJsonColumn } from "../_shared/db.ts";

// deno-lint-ignore no-explicit-any
function asArray(value: unknown): any[] {
  // partner_requirements.must_provide/preferred_traits are jsonb, which
  // query() returns as raw JSON text (see parseJsonColumn) — parse before
  // falling back, or every jsonb array on this screen renders empty.
  const parsed = parseJsonColumn(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export interface FounderListItem {
  id: string;
  name: string | null;
  photoUrl: string | null;
  role: string | null;
  status: string | null;
  teamStatus: "looking_for_team" | "in_team";
  profileComplete: boolean;
  industry: string | null;
  ventureName: string | null;
  isProspect: boolean;
  hasEvaluation: boolean;
  evaluationCount: number;
}

export const FoundersModel = {
  // MVP screen 3 — Founders List: search by name, photo/name/short role,
  // team status. No profile-completion %, no evaluation counts, no bulk
  // actions (those were explicitly excluded from the MVP screen spec).
  // industry/ventureName/profileComplete also feed New Interview's auto-fill
  // and the Founders List's incomplete-profile indicator — cheap to carry
  // here since founder_profiles is already joined.
  async list(programId: number | null, search: string | null): Promise<FounderListItem[]> {
    const rows = await query<Record<string, unknown>>(
      `SELECT u.id, u.name, u.photo_url, fp.role_title, fp.status, fp.program_id,
              fp.onboarding_completed_at, fp.industry, fp.venture_name, fp.is_prospect,
              (tf.team_id IS NOT NULL) AS in_team,
              (SELECT count(*) FROM evaluator_assessments ea WHERE ea.founder_id = u.id) AS evaluation_count
       FROM users u
       LEFT JOIN founder_profiles fp ON fp.user_id = u.id
       LEFT JOIN team_founders tf ON tf.founder_id = u.id
       WHERE u.role = 'founder' AND u.deleted_at IS NULL
         AND ($1::bigint IS NULL OR fp.program_id = $1)
         AND ($2::text IS NULL OR u.name ILIKE '%' || $2 || '%')
       ORDER BY u.name ASC NULLS LAST`,
      [programId, search],
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string | null,
      photoUrl: r.photo_url as string | null,
      role: r.role_title as string | null,
      status: r.status as string | null,
      teamStatus: r.in_team ? "in_team" : "looking_for_team",
      profileComplete: r.onboarding_completed_at != null,
      industry: r.industry as string | null,
      ventureName: r.venture_name as string | null,
      isProspect: !!r.is_prospect,
      hasEvaluation: Number(r.evaluation_count ?? 0) > 0,
      evaluationCount: Number(r.evaluation_count ?? 0),
    }));
  },

  // MVP screen 4 — Founder Profile: raw collected data only. Insights
  // (system-derived) is a separate call — see founder-dna function.
  async getProfile(founderId: string): Promise<Record<string, unknown> | null> {
    const userRows = await query<Record<string, unknown>>(
      `SELECT u.id, u.name, u.email, u.photo_url, u.cv_url,
              fp.role_title, fp.venture_name, fp.industry, fp.location, fp.current_stage,
              fp.commitment_hours, fp.commitment_type, fp.commitment_risk_appetite,
              fp.program_id, fp.status, fp.onboarding_completed_at, fp.dna_self_assessment_completed_at,
              fp.dna_scoring_status, fp.no_deal_breakers_declared
       FROM users u
       LEFT JOIN founder_profiles fp ON fp.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [founderId],
    );
    const base = userRows[0];
    if (!base) return null;

    const capabilities = await query<Record<string, unknown>>(
      `SELECT kind, capability, score FROM founder_capabilities WHERE founder_id = $1 ORDER BY kind, score DESC`,
      [founderId],
    );
    const partnerReqRows = await query<Record<string, unknown>>(
      `SELECT role_wanted, must_provide, commitment_required, ambition_required, preferred_traits
       FROM partner_requirements WHERE founder_id = $1`,
      [founderId],
    );
    const dealBreakers = await query<{ label: string }>(
      `SELECT label FROM deal_breakers WHERE founder_id = $1 ORDER BY label`,
      [founderId],
    );
    const inTeamRows = await query<{ team_id: number; name: string }>(
      `SELECT t.id AS team_id, t.name FROM team_founders tf JOIN teams t ON t.id = tf.team_id WHERE tf.founder_id = $1`,
      [founderId],
    );

    return {
      id: base.id,
      name: base.name,
      email: base.email,
      photoUrl: base.photo_url,
      cvUrl: base.cv_url,
      currentRole: base.role_title,
      ventureName: base.venture_name,
      industry: base.industry,
      location: base.location,
      currentStage: base.current_stage,
      commitmentHours: base.commitment_hours,
      commitmentType: base.commitment_type,
      commitmentRiskAppetite: base.commitment_risk_appetite,
      programId: base.program_id,
      status: base.status,
      onboardingCompletedAt: base.onboarding_completed_at,
      dnaSelfAssessmentCompletedAt: base.dna_self_assessment_completed_at,
      dnaScoringStatus: base.dna_scoring_status ?? "unscored",
      provides: capabilities.filter((c) => c.kind === "provide"),
      needs: capabilities.filter((c) => c.kind === "need"),
      partnerRequirements: partnerReqRows[0]
        ? {
          roleWanted: partnerReqRows[0].role_wanted,
          mustProvide: asArray(partnerReqRows[0].must_provide),
          commitmentRequired: partnerReqRows[0].commitment_required,
          ambitionRequired: partnerReqRows[0].ambition_required,
          preferredTraits: asArray(partnerReqRows[0].preferred_traits),
        }
        : null,
      dealBreakers: dealBreakers.map((d) => d.label),
      noDealBreakersDeclared: !!base.no_deal_breakers_declared,
      team: inTeamRows[0] ? { id: Number(inTeamRows[0].team_id), name: inTeamRows[0].name } : null,
    };
  },

  // Safe preview of a match candidate for the OTHER founder in the pair —
  // self-reported fields only (what they filled in about themselves), never
  // evaluator-authored evidence/notes or compatibility explanations, which
  // are confidential. Only callable when a computed compatibility row
  // already links the two founders (see the route handler).
  async getMatchPreview(founderId: string): Promise<Record<string, unknown> | null> {
    const rows = await query<Record<string, unknown>>(
      `SELECT u.name, u.photo_url,
              fp.role_title, fp.venture_name, fp.industry, fp.location, fp.current_stage,
              fp.commitment_hours, fp.commitment_type, fp.commitment_risk_appetite
       FROM users u
       LEFT JOIN founder_profiles fp ON fp.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [founderId],
    );
    const base = rows[0];
    if (!base) return null;

    const capabilities = await query<Record<string, unknown>>(
      `SELECT kind, capability, score FROM founder_capabilities WHERE founder_id = $1 ORDER BY kind, score DESC`,
      [founderId],
    );

    return {
      name: base.name,
      photoUrl: base.photo_url,
      currentRole: base.role_title,
      ventureName: base.venture_name,
      industry: base.industry,
      location: base.location,
      currentStage: base.current_stage,
      commitmentHours: base.commitment_hours,
      commitmentType: base.commitment_type,
      commitmentRiskAppetite: base.commitment_risk_appetite,
      provides: capabilities.filter((c) => c.kind === "provide"),
      needs: capabilities.filter((c) => c.kind === "need"),
    };
  },

  async upsertProfile(founderId: string, fields: Record<string, unknown>): Promise<void> {
    const {
      role_title, venture_name, industry, location, current_stage,
      commitment_hours, commitment_type, commitment_risk_appetite, program_id,
    } = fields;
    await query(
      `INSERT INTO founder_profiles (
         user_id, role_title, venture_name, industry, location, current_stage,
         commitment_hours, commitment_type, commitment_risk_appetite, program_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id) DO UPDATE SET
         role_title = EXCLUDED.role_title,
         venture_name = EXCLUDED.venture_name,
         industry = EXCLUDED.industry,
         location = EXCLUDED.location,
         current_stage = EXCLUDED.current_stage,
         commitment_hours = EXCLUDED.commitment_hours,
         commitment_type = EXCLUDED.commitment_type,
         commitment_risk_appetite = EXCLUDED.commitment_risk_appetite,
         program_id = COALESCE(EXCLUDED.program_id, founder_profiles.program_id),
         updated_at = now()`,
      [
        founderId, role_title ?? null, venture_name ?? null, industry ?? null, location ?? null,
        current_stage ?? null, commitment_hours ?? null, commitment_type ?? null,
        commitment_risk_appetite ?? null, program_id ?? null,
      ],
    );
  },

  // Bulk-replace one kind (provide/need) of capabilities — simplest model
  // for a form that submits the whole list each save.
  async replaceCapabilities(founderId: string, kind: "provide" | "need", items: { capability: string; score: number }[]): Promise<void> {
    await query("DELETE FROM founder_capabilities WHERE founder_id = $1 AND kind = $2", [founderId, kind]);
    for (const item of items) {
      await query(
        "INSERT INTO founder_capabilities (founder_id, kind, capability, score) VALUES ($1, $2, $3, $4)",
        [founderId, kind, item.capability, item.score],
      );
    }
  },

  async upsertPartnerRequirements(founderId: string, fields: Record<string, unknown>): Promise<void> {
    const { role_wanted, must_provide, commitment_required, ambition_required, preferred_traits } = fields;
    await query(
      `INSERT INTO partner_requirements (founder_id, role_wanted, must_provide, commitment_required, ambition_required, preferred_traits)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (founder_id) DO UPDATE SET
         role_wanted = EXCLUDED.role_wanted,
         must_provide = EXCLUDED.must_provide,
         commitment_required = EXCLUDED.commitment_required,
         ambition_required = EXCLUDED.ambition_required,
         preferred_traits = EXCLUDED.preferred_traits,
         updated_at = now()`,
      [
        founderId, role_wanted ?? null, JSON.stringify(asArray(must_provide)),
        commitment_required ?? null, ambition_required ?? null, JSON.stringify(asArray(preferred_traits)),
      ],
    );
  },

  // noneDeclared distinguishes "deliberately no deal breakers" from "hasn't
  // filled this in yet" — both look like an empty labels array otherwise,
  // which is what made the old required-at-least-one validation impossible
  // to relax safely (COPY-02).
  async replaceDealBreakers(founderId: string, labels: string[], noneDeclared: boolean): Promise<void> {
    await query("DELETE FROM deal_breakers WHERE founder_id = $1", [founderId]);
    for (const label of labels) {
      await query(
        "INSERT INTO deal_breakers (founder_id, label) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [founderId, label],
      );
    }
    await query(
      "UPDATE founder_profiles SET no_deal_breakers_declared = $2, updated_at = now() WHERE user_id = $1",
      [founderId, noneDeclared && labels.length === 0],
    );
  },

  async completeOnboarding(founderId: string): Promise<void> {
    await query(
      "UPDATE founder_profiles SET onboarding_completed_at = now(), updated_at = now() WHERE user_id = $1",
      [founderId],
    );
  },

  async setStatus(founderId: string, status: string): Promise<void> {
    await query("UPDATE founder_profiles SET status = $1, updated_at = now() WHERE user_id = $2", [status, founderId]);
  },

  async assignProgram(founderId: string, programId: number): Promise<void> {
    await query(
      `INSERT INTO founder_profiles (user_id, program_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET program_id = EXCLUDED.program_id, updated_at = now()`,
      [founderId, programId],
    );
  },
};

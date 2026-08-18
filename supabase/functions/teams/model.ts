import { query } from "../_shared/db.ts";
import { computeTeamComplementarity, type CapabilityLite, type TeamMemberInput } from "../_shared/founderScoring.ts";

export interface TeamListItem {
  id: number;
  name: string;
  memberCount: number;
  members: { id: string; name: string | null; photoUrl: string | null }[];
  skills: string[];
}

export const TeamsModel = {
  // MVP screens 9/10's companion list — not a dedicated MVP screen itself,
  // but useful for admin navigation to an existing Team Profile.
  //
  // Fetches members + capabilities for every team in exactly 2 queries
  // (regardless of team count) and computes complementarySkills in-process —
  // the frontend previously called getTeam() per team to enrich this list,
  // an N+1 that meant a screen with 10 teams paid for 11 full API round
  // trips instead of 1.
  async list(programId: number | null): Promise<TeamListItem[]> {
    const teamRows = await query<Record<string, unknown>>(
      `SELECT t.id AS team_id, t.name AS team_name,
              u.id AS member_id, u.name AS member_name, u.photo_url AS member_photo
       FROM teams t
       LEFT JOIN team_founders tf ON tf.team_id = t.id
       LEFT JOIN users u ON u.id = tf.founder_id
       WHERE ($1::bigint IS NULL OR t.program_id = $1)
       ORDER BY t.created_at DESC, u.name ASC`,
      [programId],
    );

    const teams = new Map<number, TeamListItem>();
    const memberIds: string[] = [];
    for (const r of teamRows) {
      const teamId = Number(r.team_id);
      if (!teams.has(teamId)) {
        teams.set(teamId, { id: teamId, name: r.team_name as string, memberCount: 0, members: [], skills: [] });
      }
      if (r.member_id) {
        teams.get(teamId)!.members.push({
          id: r.member_id as string,
          name: r.member_name as string | null,
          photoUrl: r.member_photo as string | null,
        });
        memberIds.push(r.member_id as string);
      }
    }

    const capabilitiesByFounder = new Map<string, CapabilityLite[]>();
    if (memberIds.length > 0) {
      const capRows = await query<{ founder_id: string; kind: "provide" | "need"; capability: string }>(
        `SELECT founder_id, kind, capability FROM founder_capabilities WHERE founder_id = ANY($1::uuid[])`,
        [memberIds],
      );
      for (const c of capRows) {
        if (!capabilitiesByFounder.has(c.founder_id)) capabilitiesByFounder.set(c.founder_id, []);
        capabilitiesByFounder.get(c.founder_id)!.push({ kind: c.kind, capability: c.capability });
      }
    }

    for (const team of teams.values()) {
      team.memberCount = team.members.length;
      const memberInputs = team.members.map((m) => ({
        founderId: m.id,
        capabilities: capabilitiesByFounder.get(m.id) ?? [],
      })) as unknown as TeamMemberInput[]; // dimensions unused by computeTeamComplementarity
      team.skills = computeTeamComplementarity(memberInputs).complementarySkills;
    }

    return [...teams.values()];
  },

  async get(teamId: number): Promise<Record<string, unknown> | null> {
    const rows = await query<Record<string, unknown>>(
      `SELECT id, program_id, name, created_by, created_at FROM teams WHERE id = $1`,
      [teamId],
    );
    return rows[0] ?? null;
  },

  async findByFounder(founderId: string): Promise<number | null> {
    const rows = await query<{ team_id: number }>(
      `SELECT team_id FROM team_founders WHERE founder_id = $1`,
      [founderId],
    );
    return rows[0] ? Number(rows[0].team_id) : null;
  },

  // MVP screen 9 — Team Creation: select founders, team name, Create Team.
  // team_founders.founder_id is unique (a founder is on at most one team) —
  // pre-checked here so a founder who's already on a team produces a clean,
  // named error instead of a raw unique-violation reaching the client (the
  // frontend also filters already-teamed founders out of the picker, but
  // this is the actual enforcement point, e.g. against a race or a stale
  // client-side list).
  async create(name: string, programId: number | null, createdBy: string, founderIds: string[]): Promise<number> {
    const alreadyTeamed = await query<{ name: string | null }>(
      `SELECT u.name FROM team_founders tf JOIN users u ON u.id = tf.founder_id WHERE tf.founder_id = ANY($1::uuid[])`,
      [founderIds],
    );
    if (alreadyTeamed.length > 0) {
      const names = alreadyTeamed.map((r) => r.name || "A founder").join(", ");
      throw new Error(`${names} already ${alreadyTeamed.length === 1 ? "has" : "have"} a team.`);
    }

    // A prospect (added by an evaluator, no real account activity yet) or an
    // inactive/dropped founder isn't eligible for team membership — this was
    // previously only filtered client-side in the picker, so a stale list or
    // a direct request could create a team with someone like an unconverted
    // prospect in it.
    const ineligible = await query<{ name: string | null; is_prospect: boolean; status: string }>(
      `SELECT u.name, fp.is_prospect, fp.status
       FROM founder_profiles fp JOIN users u ON u.id = fp.user_id
       WHERE fp.user_id = ANY($1::uuid[]) AND (fp.is_prospect OR fp.status <> 'active')`,
      [founderIds],
    );
    if (ineligible.length > 0) {
      const names = ineligible.map((r) => r.name || "A founder").join(", ");
      throw new Error(`${names} ${ineligible.length === 1 ? "is" : "are"} not eligible for a team (prospect or inactive).`);
    }

    const rows = await query<{ id: number }>(
      `INSERT INTO teams (name, program_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [name, programId, createdBy],
    );
    const teamId = Number(rows[0].id);
    for (const founderId of founderIds) {
      await query(`INSERT INTO team_founders (team_id, founder_id) VALUES ($1, $2)`, [teamId, founderId]);
    }
    return teamId;
  },

  // Returns the founderIds newly added by this call (present in `founderIds`
  // but not previously on the team) so the caller can notify just them.
  async setMembers(teamId: number, founderIds: string[]): Promise<string[]> {
    const before = await query<{ founder_id: string }>(
      "SELECT founder_id FROM team_founders WHERE team_id = $1",
      [teamId],
    );
    const beforeIds = new Set(before.map((r) => r.founder_id));
    await query("DELETE FROM team_founders WHERE team_id = $1", [teamId]);
    for (const founderId of founderIds) {
      await query(`INSERT INTO team_founders (team_id, founder_id) VALUES ($1, $2)`, [teamId, founderId]);
    }
    return founderIds.filter((id) => !beforeIds.has(id));
  },

  async remove(teamId: number): Promise<void> {
    await query("DELETE FROM teams WHERE id = $1", [teamId]);
  },
};

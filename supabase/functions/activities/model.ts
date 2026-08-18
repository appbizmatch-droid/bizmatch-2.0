import { query } from "../_shared/db.ts";

export interface ActivityListItem {
  id: number;
  type: string;
  title: string;
  scheduledAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  participantCount: number;
}

// Shared by every query that reads an activity's status: when both dates are set (every
// activity created after the 20260814120000 migration), status is derived from `now()` instead
// of trusted from the stored column, so it moves upcoming -> active -> completed on its own with
// no admin action needed. Activities created before that migration have no date range and keep
// falling back to whatever the (now otherwise-legacy) `status` column holds.
const STATUS_SQL = `
  CASE
    WHEN a.starts_at IS NOT NULL AND a.ends_at IS NOT NULL THEN
      CASE
        WHEN now() < a.starts_at THEN 'upcoming'
        WHEN now() <= a.ends_at THEN 'active'
        ELSE 'completed'
      END
    ELSE a.status
  END
`;

export const ActivitiesModel = {
  // MVP screen 5 — Activities list: type, date, participant count, status.
  // Also backs MVP screen 10's "Team Activities" via the teamId filter.
  // Admin-only view — sees every activity regardless of participation.
  async list(programId: number | null, teamId: number | null = null, founderId: string | null = null): Promise<ActivityListItem[]> {
    const rows = await query<Record<string, unknown>>(
      `SELECT a.id, a.type, a.title, a.scheduled_at, a.starts_at, a.ends_at, ${STATUS_SQL} AS status,
              count(ap.founder_id) FILTER (WHERE ap.status = 'approved')::int AS participant_count
       FROM activities a
       LEFT JOIN activity_participants ap ON ap.activity_id = a.id
       WHERE ($1::bigint IS NULL OR a.program_id = $1)
         AND ($2::bigint IS NULL OR a.team_id = $2)
         AND ($3::uuid IS NULL OR EXISTS (
           SELECT 1 FROM activity_participants ap2
           WHERE ap2.activity_id = a.id AND ap2.founder_id = $3
         ))
       GROUP BY a.id
       ORDER BY a.starts_at DESC NULLS LAST, a.id DESC`,
      [programId, teamId, founderId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      type: r.type as string,
      title: r.title as string,
      scheduledAt: r.scheduled_at as string | null,
      startsAt: r.starts_at as string | null,
      endsAt: r.ends_at as string | null,
      status: r.status as string,
      participantCount: Number(r.participant_count),
    }));
  },

  // Founder-scoped view: activities open for browsing/signup ('upcoming',
  // regardless of participation), plus anything this founder already has a
  // participant row for (pending/approved/rejected, any activity status),
  // plus (when teamId is given, e.g. TeamProfileScreen's "Team Activities"
  // panel) any activity scoped to that team — a founder never sees an
  // active/completed activity outside those cases. `myStatus` is null when
  // they haven't requested to join yet.
  async listForFounder(founderId: string, teamId: number | null = null): Promise<Array<ActivityListItem & { myStatus: string | null }>> {
    const rows = await query<Record<string, unknown>>(
      `SELECT a.id, a.type, a.title, a.scheduled_at, a.starts_at, a.ends_at, ${STATUS_SQL} AS status,
              count(ap.founder_id) FILTER (WHERE ap.status = 'approved')::int AS participant_count,
              me.status AS my_status
       FROM activities a
       LEFT JOIN activity_participants ap ON ap.activity_id = a.id
       LEFT JOIN activity_participants me ON me.activity_id = a.id AND me.founder_id = $1
       WHERE ${STATUS_SQL} = 'upcoming' OR me.founder_id IS NOT NULL
          OR ($2::bigint IS NOT NULL AND a.team_id = $2)
       GROUP BY a.id, me.status
       ORDER BY a.starts_at DESC NULLS LAST, a.id DESC`,
      [founderId, teamId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      type: r.type as string,
      title: r.title as string,
      scheduledAt: r.scheduled_at as string | null,
      startsAt: r.starts_at as string | null,
      endsAt: r.ends_at as string | null,
      status: r.status as string,
      participantCount: Number(r.participant_count),
      myStatus: (r.my_status as string | null) ?? null,
    }));
  },

  async get(activityId: number, viewerId: string | null = null): Promise<Record<string, unknown> | null> {
    const rows = await query<Record<string, unknown>>(
      `SELECT id, program_id, team_id, type, title, description, scheduled_at, starts_at, ends_at, ${STATUS_SQL} AS status
       FROM activities a WHERE id = $1`,
      [activityId],
    );
    const row = rows[0];
    if (!row) return null;

    const participantRows = await query<Record<string, unknown>>(
      `SELECT u.id, u.name, u.photo_url, ap.status, ap.requested_at
       FROM activity_participants ap JOIN users u ON u.id = ap.founder_id
       WHERE ap.activity_id = $1 ORDER BY ap.status, u.name`,
      [activityId],
    );
    const evaluatorRows = await query<Record<string, unknown>>(
      `SELECT u.id, u.name FROM activity_evaluators ae JOIN users u ON u.id = ae.evaluator_id
       WHERE ae.activity_id = $1 ORDER BY u.name`,
      [activityId],
    );

    const participants = participantRows.map((p) => ({
      id: p.id as string,
      name: p.name as string | null,
      photoUrl: p.photo_url as string | null,
      status: p.status as string,
      requestedAt: p.requested_at as string,
    }));
    const evaluators = evaluatorRows.map((e) => ({ id: e.id as string, name: e.name as string | null }));
    const myStatus = viewerId ? participants.find((p) => p.id === viewerId)?.status ?? null : null;

    return {
      id: Number(row.id),
      programId: row.program_id as number | null,
      teamId: row.team_id as number | null,
      type: row.type as string,
      title: row.title as string,
      description: row.description as string | null,
      scheduledAt: row.scheduled_at as string | null,
      startsAt: row.starts_at as string | null,
      endsAt: row.ends_at as string | null,
      status: row.status as string,
      participants,
      evaluators,
      myStatus,
    };
  },

  async create(fields: Record<string, unknown>): Promise<number> {
    const { programId, type, title, description, startsAt, endsAt } = fields as {
      programId?: number; type: string; title: string; description?: string; startsAt: string; endsAt: string;
    };
    const rows = await query<{ id: number }>(
      `INSERT INTO activities (program_id, type, title, description, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [programId ?? null, type, title, description ?? null, startsAt, endsAt],
    );
    return Number(rows[0].id);
  },

  async update(activityId: number, fields: Record<string, unknown>): Promise<void> {
    const { title, description, startsAt, endsAt, status } = fields as {
      title?: string; description?: string; startsAt?: string; endsAt?: string; status?: string;
    };
    await query(
      `UPDATE activities SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         starts_at = COALESCE($4, starts_at),
         ends_at = COALESCE($5, ends_at),
         status = COALESCE($6, status)
       WHERE id = $1`,
      [activityId, title ?? null, description ?? null, startsAt ?? null, endsAt ?? null, status ?? null],
    );
  },

  // Admin bulk-set of the *approved* roster — diff-aware against the current
  // approved set so a no-op save can never touch pending/rejected rows (a
  // prior version deleted+reinserted every participant regardless of
  // status, silently flipping rejected requests back to approved on every
  // save). founderIds is the desired set of approved participants; anyone
  // currently pending/rejected and not in this set is left untouched.
  async setParticipants(activityId: number, founderIds: string[]): Promise<string[]> {
    const desired = new Set(founderIds);
    const current = await query<{ founder_id: string }>(
      `SELECT founder_id FROM activity_participants WHERE activity_id = $1 AND status = 'approved'`,
      [activityId],
    );
    const currentIds = new Set(current.map((r) => r.founder_id));

    const toRemove = [...currentIds].filter((id) => !desired.has(id));
    const toAdd = [...desired].filter((id) => !currentIds.has(id));

    if (toRemove.length) {
      await query(
        `DELETE FROM activity_participants WHERE activity_id = $1 AND status = 'approved' AND founder_id = ANY($2::uuid[])`,
        [activityId, toRemove],
      );
    }
    for (const founderId of toAdd) {
      await query(
        `INSERT INTO activity_participants (activity_id, founder_id, status, requested_at, decided_at)
         VALUES ($1, $2, 'approved', now(), now())
         ON CONFLICT (activity_id, founder_id) DO UPDATE SET status = 'approved', decided_at = now()`,
        [activityId, founderId],
      );
    }
    return toAdd;
  },

  // Founder self-service: request to join an upcoming activity. Idempotent —
  // re-requesting just returns whatever status the existing row already has.
  async requestJoin(activityId: number, founderId: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
    const activityRows = await query<{ status: string }>(
      `SELECT ${STATUS_SQL} AS status FROM activities a WHERE id = $1`,
      [activityId],
    );
    if (!activityRows[0]) return { ok: false, error: "Activity not found" };
    if (activityRows[0].status !== "upcoming") {
      return { ok: false, error: "Registration is only open for upcoming activities" };
    }

    await query(
      `INSERT INTO activity_participants (activity_id, founder_id, status, requested_at)
       VALUES ($1, $2, 'pending', now())
       ON CONFLICT (activity_id, founder_id) DO NOTHING`,
      [activityId, founderId],
    );
    const rows = await query<{ status: string }>(
      "SELECT status FROM activity_participants WHERE activity_id = $1 AND founder_id = $2",
      [activityId, founderId],
    );
    return { ok: true, status: rows[0].status };
  },

  async isFounderOnTeam(teamId: number, founderId: string): Promise<boolean> {
    const rows = await query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM team_founders WHERE team_id = $1 AND founder_id = $2) AS exists",
      [teamId, founderId],
    );
    return !!rows[0]?.exists;
  },

  // Admin approve/reject of a single pending (or existing) registration.
  async decideParticipant(activityId: number, founderId: string, status: "approved" | "rejected"): Promise<void> {
    await query(
      `UPDATE activity_participants SET status = $3, decided_at = now()
       WHERE activity_id = $1 AND founder_id = $2`,
      [activityId, founderId, status],
    );
  },

  // Returns the evaluator ids newly added by this save (i.e. not already assigned) so the
  // caller can notify only them, not everyone re-saved into an unchanged roster.
  async setEvaluators(activityId: number, evaluatorIds: string[]): Promise<string[]> {
    const current = await query<{ evaluator_id: string }>(
      "SELECT evaluator_id FROM activity_evaluators WHERE activity_id = $1",
      [activityId],
    );
    const currentIds = new Set(current.map((r) => r.evaluator_id));
    const added = evaluatorIds.filter((id) => !currentIds.has(id));

    await query("DELETE FROM activity_evaluators WHERE activity_id = $1", [activityId]);
    for (const evaluatorId of evaluatorIds) {
      await query(
        "INSERT INTO activity_evaluators (activity_id, evaluator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [activityId, evaluatorId],
      );
    }
    return added;
  },

  async remove(activityId: number): Promise<void> {
    await query("DELETE FROM activities WHERE id = $1", [activityId]);
  },
};

import { authenticate } from "../_shared/auth.ts";
import { parseJsonColumn, query } from "../_shared/db.ts";
import { json } from "../_shared/respond.ts";
import { route } from "../_shared/router.ts";
import { serveFunction } from "../_shared/serve.ts";

const FN = "notifications";

// GET /functions/v1/notifications
async function getNotifications(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const rows = await query(
    `SELECT id, type, ref_id AS "refId", payload, read_at AS "readAt", created_at AS "createdAt"
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [user.id],
  );
  return json(rows.map((r) => ({ ...r, payload: parseJsonColumn(r.payload, {}) })));
}

// POST /functions/v1/notifications/read  { ids?, types? }
async function markRead(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const { ids, types } = body as { ids?: number[]; types?: string[] };

  if (ids?.length) {
    await query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`,
      [user.id, ids],
    );
  }
  if (types?.length) {
    await query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND type = ANY($2::notification_type[]) AND read_at IS NULL`,
      [user.id, types],
    );
  }
  return json({ ok: true });
}

// DELETE /functions/v1/notifications
async function clearAll(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  await query(`DELETE FROM notifications WHERE user_id = $1`, [user.id]);
  return json({ ok: true });
}

serveFunction(FN, [
  route(FN, "GET", "", getNotifications),
  route(FN, "POST", "/read", markRead),
  route(FN, "DELETE", "", clearAll),
]);

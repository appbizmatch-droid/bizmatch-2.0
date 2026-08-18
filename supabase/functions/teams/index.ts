import { authenticate, requireAdmin } from "../_shared/auth.ts";
import { json } from "../_shared/respond.ts";
import { route } from "../_shared/router.ts";
import { serveFunction } from "../_shared/serve.ts";
import { background } from "../_shared/background.ts";
import { computeTeamInsights, previewTeamProfile, recomputeTeamDna } from "../_shared/teamRecompute.ts";
import { emitNotification } from "../_shared/notifications.ts";
import { TeamsModel } from "./model.ts";

const FN = "teams";

async function requireAdminOrTeamMember(userId: string, isAdmin: boolean, teamId: number): Promise<Response | null> {
  if (isAdmin) return null;
  const memberOfTeamId = await TeamsModel.findByFounder(userId);
  if (memberOfTeamId === teamId) return null;
  return json({ error: "Forbidden" }, 403);
}

// GET /functions/v1/teams?programId=
async function listTeams(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const programIdParam = url.searchParams.get("programId");
  const teams = await TeamsModel.list(programIdParam ? Number(programIdParam) : null);
  return json(teams);
}

// GET /functions/v1/teams/preview?founderIds=a,b,c  (admin — MVP screen 9's
// pre-create compatibility/skills/gaps summary)
async function previewTeam(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const url = new URL(req.url);
  const founderIds = (url.searchParams.get("founderIds") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (founderIds.length === 0) return json({ error: "founderIds required" }, 400);

  const profile = await previewTeamProfile(founderIds);
  return json({ profile });
}

// POST /functions/v1/teams  (admin)  { name, programId?, founderIds: string[] }
async function createTeam(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const body = await req.json().catch(() => ({}));
  const { name, programId, founderIds } = body as { name?: string; programId?: number; founderIds?: string[] };
  if (!name || !founderIds?.length) return json({ error: "name and founderIds are required" }, 400);

  let teamId: number;
  try {
    teamId = await TeamsModel.create(name, programId ?? null, user.id, founderIds);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Could not create team" }, 409);
  }
  background(recomputeTeamDna(teamId));
  background(Promise.all(
    founderIds.map((founderId) => emitNotification(founderId, "team_joined", teamId, { teamId, teamName: name })),
  ));
  return json({ id: teamId }, 201);
}

// GET /functions/v1/teams/:id  (admin or a member of this team — MVP screen 10)
async function getTeam(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const teamId = Number(params.id);
  const forbidden = await requireAdminOrTeamMember(user.id, user.role === "admin", teamId);
  if (forbidden) return forbidden;

  const team = await TeamsModel.get(teamId);
  if (!team) return json({ error: "Team not found" }, 404);
  const insights = await computeTeamInsights(teamId);
  return json({ ...team, ...insights });
}

// PUT /functions/v1/teams/:id/members  (admin)  { founderIds: string[] }
async function setMembers(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const body = await req.json().catch(() => ({}));
  const { founderIds } = body as { founderIds?: string[] };
  const teamId = Number(params.id);
  const added = await TeamsModel.setMembers(teamId, founderIds ?? []);
  background(recomputeTeamDna(teamId));
  if (added.length > 0) {
    const team = await TeamsModel.get(teamId);
    background(Promise.all(
      added.map((founderId) => emitNotification(founderId, "team_joined", teamId, { teamId, teamName: team?.name })),
    ));
  }
  return json({ ok: true });
}

// POST /functions/v1/teams/:id/recompute  (admin or a member of this team)
async function recompute(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const teamId = Number(params.id);
  const forbidden = await requireAdminOrTeamMember(user.id, user.role === "admin", teamId);
  if (forbidden) return forbidden;

  await recomputeTeamDna(teamId);
  const insights = await computeTeamInsights(teamId);
  return json(insights);
}

// DELETE /functions/v1/teams/:id  (admin)
async function deleteTeam(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  await TeamsModel.remove(Number(params.id));
  return json({ ok: true });
}

serveFunction(FN, [
  // /preview must be registered before the /:id catch-all
  route(FN, "GET", "/preview", previewTeam),
  route(FN, "GET", "", listTeams),
  route(FN, "POST", "", createTeam),
  route(FN, "GET", "/:id", getTeam),
  route(FN, "PUT", "/:id/members", setMembers),
  route(FN, "POST", "/:id/recompute", recompute),
  route(FN, "DELETE", "/:id", deleteTeam),
]);

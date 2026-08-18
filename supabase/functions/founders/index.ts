import { authenticate, requireAdmin } from "../_shared/auth.ts";
import { query } from "../_shared/db.ts";
import { json } from "../_shared/respond.ts";
import { route } from "../_shared/router.ts";
import { serveFunction } from "../_shared/serve.ts";
import { uploadBuffer, BUCKETS } from "../_shared/storage.ts";
import { supabase } from "../_shared/supabase.ts";
import { background } from "../_shared/background.ts";
import { recomputeMatchesForFounder } from "../_shared/matchRecompute.ts";
import { FoundersModel } from "./model.ts";

const FN = "founders";
const MB = 1024 * 1024;

function requireAdminOrSelf(userId: string, targetId: string, isAdmin: boolean): Response | null {
  if (isAdmin || userId === targetId) return null;
  return json({ error: "Forbidden" }, 403);
}

// GET /functions/v1/founders?search=&programId=  (admin — MVP screen 3)
async function listFounders(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const url = new URL(req.url);
  const search = url.searchParams.get("search");
  const programIdParam = url.searchParams.get("programId");
  const programId = programIdParam ? Number(programIdParam) : null;

  const founders = await FoundersModel.list(programId, search);
  return json(founders);
}

// GET /functions/v1/founders/dashboard  (admin — MVP screen 2)
async function getDashboard(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const programRows = await query<Record<string, unknown>>(
    "SELECT id, name, cohort_label FROM programs WHERE is_active = true ORDER BY id DESC LIMIT 1",
  );
  const program = programRows[0] ?? null;

  const [activeFoundersRows] = await Promise.all([
    query<{ count: string }>(
      "SELECT count(*)::int AS count FROM founder_profiles WHERE status = 'active'",
    ),
  ]);

  const evaluationsRows = await query<{ count: string }>(
    "SELECT count(*)::int AS count FROM evaluator_assessments",
  );
  // LEFT JOIN from users, not a plain scan of founder_profiles — a founder_profiles row
  // isn't created until onboarding starts, so a founder who never even started (no row at
  // all) is invisible to a query that only reads founder_profiles directly. That's *more*
  // missing than a partial profile, not less, so it has to count too — same reasoning as
  // FoundersModel.list's LEFT JOIN, which is what the Missing Info tile drills down into
  // (a mismatch here means the tile's number and the filtered list disagree).
  const missingInfoRows = await query<{ count: string }>(
    `SELECT count(*)::int AS count FROM users u
     LEFT JOIN founder_profiles fp ON fp.user_id = u.id
     WHERE u.role = 'founder' AND u.deleted_at IS NULL
       AND fp.onboarding_completed_at IS NULL`,
  );
  const teamsRows = await query<{ count: string }>(
    "SELECT count(*)::int AS count FROM teams",
  );

  const recentAssessments = await query<Record<string, unknown>>(
    `SELECT ea.submitted_at, u.name AS founder_name, ev.name AS evaluator_name
     FROM evaluator_assessments ea
     JOIN users u ON u.id = ea.founder_id
     JOIN users ev ON ev.id = ea.evaluator_id
     ORDER BY ea.submitted_at DESC LIMIT 10`,
  );

  const needsAttentionFounders = await query<{ id: string; name: string | null }>(
    `SELECT u.id, u.name FROM users u
     LEFT JOIN founder_profiles fp ON fp.user_id = u.id
     WHERE u.role = 'founder' AND u.deleted_at IS NULL
       AND fp.onboarding_completed_at IS NULL
     LIMIT 10`,
  );

  return json({
    program,
    activeFounderCount: Number(activeFoundersRows[0]?.count ?? 0),
    completedEvaluationsCount: Number(evaluationsRows[0]?.count ?? 0),
    missingInfoCount: Number(missingInfoRows[0]?.count ?? 0),
    teamsCreatedCount: Number(teamsRows[0]?.count ?? 0),
    recentActivity: recentAssessments.map((r) => ({
      type: "evaluation",
      founderName: r.founder_name,
      evaluatorName: r.evaluator_name,
      at: r.submitted_at,
    })),
    needsAttention: {
      incompleteFounders: needsAttentionFounders,
    },
  });
}

// POST /functions/v1/founders/prospect  (admin — evaluator adds a founder
// who isn't registered yet, e.g. to attach an interview before they sign
// up). Creates a real auth user with an unconfirmed email and no password
// — they later claim it via password reset — so it fits the existing
// public.users -> auth.users FK without any schema change on that side.
async function createProspect(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const body = await req.json().catch(() => ({}));
  const { email, name, roleTitle, industry, location } = body as {
    email?: string; name?: string; roleTitle?: string; industry?: string; location?: string;
  };
  if (!email || !name) return json({ error: "email and name are required" }, 400);

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: false,
    user_metadata: { name, role: "founder" },
  });
  if (error || !data?.user) {
    return json({ error: error?.message || "Could not create prospect founder" }, 400);
  }

  const founderId = data.user.id;
  await query(
    `INSERT INTO founder_profiles (user_id, role_title, industry, location, is_prospect)
     VALUES ($1, $2, $3, $4, true)`,
    [founderId, roleTitle ?? null, industry ?? null, location ?? null],
  );

  return json({ id: founderId, name, email }, 201);
}

// GET /functions/v1/founders/:id  (admin or self — MVP screen 4)
async function getFounder(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const profile = await FoundersModel.getProfile(params.id);
  if (!profile) return json({ error: "Founder not found" }, 404);
  return json(profile);
}

// GET /functions/v1/founders/:id/match-preview  (self, if a compatibility
// row already links the caller and :id — i.e. only for a founder you're
// already shown as a match candidate for). Self-reported fields only, no
// evaluator-authored evidence or compatibility explanation — a founder
// browsing their matches should see what the candidate says about
// themselves, not confidential evaluator notes about them.
async function getMatchPreview(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (user.role !== "admin") {
    if (user.id === params.id) return json({ error: "Forbidden" }, 403);
    const [aId, bId] = user.id < params.id ? [user.id, params.id] : [params.id, user.id];
    const rows = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM founder_compatibility WHERE founder_a_id = $1 AND founder_b_id = $2) AS exists`,
      [aId, bId],
    );
    if (!rows[0]?.exists) return json({ error: "Forbidden" }, 403);
  }

  const preview = await FoundersModel.getMatchPreview(params.id);
  if (!preview) return json({ error: "Founder not found" }, 404);
  return json(preview);
}

// PUT /functions/v1/founders/:id/profile  (admin or self)
async function putProfile(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  await FoundersModel.upsertProfile(params.id, body);
  // Profile fields feed compatibility scoring — an edit here can make
  // existing match rows stale, so recompute in the background rather than
  // leaving them looking confidently "final" against outdated inputs.
  background(recomputeMatchesForFounder(params.id));
  return json({ ok: true });
}

// PUT /functions/v1/founders/:id/capabilities  { kind: 'provide'|'need', items: [{capability, score}] }
async function putCapabilities(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const { kind, items } = body as { kind?: "provide" | "need"; items?: { capability: string; score: number }[] };
  if (kind !== "provide" && kind !== "need") return json({ error: "kind must be provide or need" }, 400);
  await FoundersModel.replaceCapabilities(params.id, kind, items ?? []);
  return json({ ok: true });
}

// PUT /functions/v1/founders/:id/partner-requirements
async function putPartnerRequirements(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  await FoundersModel.upsertPartnerRequirements(params.id, body);
  return json({ ok: true });
}

// PUT /functions/v1/founders/:id/deal-breakers  { labels: string[], noneDeclared?: boolean }
async function putDealBreakers(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => ({}));
  const { labels, noneDeclared } = body as { labels?: string[]; noneDeclared?: boolean };
  await FoundersModel.replaceDealBreakers(params.id, labels ?? [], !!noneDeclared);
  return json({ ok: true });
}

// POST /functions/v1/founders/:id/onboarding/complete
async function completeOnboarding(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  await FoundersModel.completeOnboarding(params.id);
  return json({ ok: true });
}

// PATCH /functions/v1/founders/:id/status  (admin)  { status: 'active'|'inactive'|'dropped' }
async function setStatus(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const body = await req.json().catch(() => ({}));
  const { status } = body as { status?: string };
  if (!status || !["active", "inactive", "dropped"].includes(status)) {
    return json({ error: "status must be active, inactive, or dropped" }, 400);
  }
  await FoundersModel.setStatus(params.id, status);
  return json({ ok: true });
}

// PATCH /functions/v1/founders/:id/program  (admin — "Add Founder" quick action assigns a cohort)  { programId }
async function assignProgram(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;

  const body = await req.json().catch(() => ({}));
  const { programId } = body as { programId?: number };
  if (!programId) return json({ error: "programId required" }, 400);
  await FoundersModel.assignProgram(params.id, programId);
  return json({ ok: true });
}

// POST /functions/v1/founders/:id/cv  (admin or self, multipart form field "cv")
async function uploadCv(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const form = await req.formData();
  const file = form.get("cv") as File | null;
  if (!file) return json({ error: "No file uploaded" }, 400);
  if (file.size > 20 * MB) return json({ error: "File too large" }, 413);

  const buffer = new Uint8Array(await file.arrayBuffer());
  const url = await uploadBuffer(BUCKETS.cv, `${params.id}-${Date.now()}.pdf`, buffer, "application/pdf");
  await query("UPDATE users SET cv_url = $1 WHERE id = $2", [url, params.id]);
  return json({ cvUrl: url });
}

// GET /functions/v1/founders/:id/cv — proxy from Supabase Storage with correct Content-Type
async function serveCv(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const forbidden = requireAdminOrSelf(user.id, params.id, user.role === "admin");
  if (forbidden) return forbidden;

  const rows = await query<{ cv_url: string | null }>("SELECT cv_url FROM users WHERE id = $1", [params.id]);
  const cvUrl = rows[0]?.cv_url;
  if (!cvUrl) return json({ error: "No CV uploaded" }, 404);

  const response = await fetch(cvUrl);
  if (!response.ok) return json({ error: "Failed to fetch CV from storage" }, 502);
  const buf = await response.arrayBuffer();
  return new Response(buf, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="cv.pdf"' },
  });
}

// GET /functions/v1/founders/programs  (admin — top bar's cohort switcher)
// List-only; no create/edit endpoint yet, out of scope for now.
async function listPrograms(req: Request): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const rows = await query<{ id: number; name: string; cohort_label: string | null }>(
    "SELECT id, name, cohort_label FROM programs ORDER BY id DESC",
  );
  return json(rows.map((r) => ({ id: Number(r.id), name: r.name, cohortLabel: r.cohort_label })));
}

serveFunction(FN, [
  // /dashboard, /prospect, /programs must be registered before the /:id catch-all
  route(FN, "GET", "/dashboard", getDashboard),
  route(FN, "GET", "/programs", listPrograms),
  route(FN, "POST", "/prospect", createProspect),
  route(FN, "GET", "", listFounders),
  route(FN, "GET", "/:id", getFounder),
  route(FN, "GET", "/:id/match-preview", getMatchPreview),
  route(FN, "PUT", "/:id/profile", putProfile),
  route(FN, "PUT", "/:id/capabilities", putCapabilities),
  route(FN, "PUT", "/:id/partner-requirements", putPartnerRequirements),
  route(FN, "PUT", "/:id/deal-breakers", putDealBreakers),
  route(FN, "POST", "/:id/onboarding/complete", completeOnboarding),
  route(FN, "PATCH", "/:id/status", setStatus),
  route(FN, "PATCH", "/:id/program", assignProgram),
  route(FN, "POST", "/:id/cv", uploadCv),
  route(FN, "GET", "/:id/cv", serveCv),
]);

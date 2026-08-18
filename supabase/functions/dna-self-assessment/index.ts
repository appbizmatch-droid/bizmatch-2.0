import { authenticate } from "../_shared/auth.ts";
import { query } from "../_shared/db.ts";
import { json } from "../_shared/respond.ts";
import { route } from "../_shared/router.ts";
import { serveFunction } from "../_shared/serve.ts";
import { background } from "../_shared/background.ts";
import { generateText, isGeminiConfigured } from "../_shared/gemini.ts";
import { SOURCE_WEIGHTS, type EvidenceDimension } from "../_shared/founderScoring.ts";
import { DNA_QUESTIONS, DNA_DIMENSIONS, DNA_ASSESSMENT_VERSION } from "../_shared/dnaQuestions.ts";
import { recomputeFounderDna } from "../_shared/dnaRecompute.ts";
import { recomputeMatchesForFounder } from "../_shared/matchRecompute.ts";
import { notifyAdmins } from "../_shared/notifications.ts";

const FN = "dna-self-assessment";

function forbidden(user: { role: string | null; id: string }, founderId: string): Response | null {
  if (user.role !== "admin" && user.id !== founderId) return json({ error: "Forbidden" }, 403);
  return null;
}

// GET /functions/v1/dna-self-assessment/:founderId — question bank + whether
// this founder has already completed it, plus the background-scoring status
// of their most recent submission (admin or self), plus any answers already
// saved for the current assessment version — DNA-02 made each answer save
// to the server as soon as it's completed, but without returning them here
// the standalone questionnaire screen had no way to resume with what was
// already saved, so closing the tab mid-assessment looked like data loss
// even though it wasn't.
async function getAssessment(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const err = forbidden(user, params.founderId);
  if (err) return err;

  const rows = await query<{ dna_self_assessment_completed_at: string | null; dna_scoring_status: string }>(
    "SELECT dna_self_assessment_completed_at, dna_scoring_status FROM founder_profiles WHERE user_id = $1",
    [params.founderId],
  );
  const answerRows = await query<{ dimension: EvidenceDimension; answer: string }>(
    "SELECT dimension, answer FROM dna_self_assessment_responses WHERE founder_id = $1 AND assessment_version = $2",
    [params.founderId, DNA_ASSESSMENT_VERSION],
  );
  const answers: Partial<Record<EvidenceDimension, string>> = {};
  for (const r of answerRows) answers[r.dimension] = r.answer;

  return json({
    questions: DNA_QUESTIONS,
    completedAt: rows[0]?.dna_self_assessment_completed_at ?? null,
    dnaScoringStatus: rows[0]?.dna_scoring_status ?? "unscored",
    answers,
  });
}

// One answer per dimension now (was up to 5) — blank/missing = skipped.
type Answers = Partial<Record<EvidenceDimension, string>>;

function isAnswered(ans: unknown): ans is string {
  return typeof ans === "string" && ans.trim().length > 0;
}

function validateAnswers(answers: unknown): string | null {
  if (!answers || typeof answers !== "object") return "answers is required";
  const a = answers as Answers;
  for (const dim of DNA_DIMENSIONS) {
    const ans = a[dim];
    if (ans != null && typeof ans !== "string") return `answers.${dim} must be a string`;
  }
  return null;
}

interface DimensionEval {
  score: number;
  observation: string;
}

// Only dimensions with an answered question get scored — Gemini's output
// schema is built dynamically so it never has to invent a score for a
// dimension the founder left entirely blank.
function answeredDimensions(answers: Answers): EvidenceDimension[] {
  return DNA_DIMENSIONS.filter((dim) => isAnswered(answers[dim]));
}

function buildPrompt(answers: Answers, dims: EvidenceDimension[]): string {
  const sections = dims.map((dim) => {
    const { text } = DNA_QUESTIONS[dim];
    return `## ${dim}\nQ: ${text}\nA: ${answers[dim]}`;
  }).join("\n\n");

  const schema = dims
    .map((dim) => `  "${dim}": { "score": <1-100 integer>, "observation": "<one sentence, <=25 words>" }`)
    .join(",\n");

  // Scoring rubric mirrors the spec's 0-3 "quality of behavioral evidence"
  // scale (No evidence / Weak / Adequate / Strong), remapped onto the
  // existing 1-100 scale this pipeline already uses elsewhere: judge the
  // ANSWER's evidence quality only — never English fluency, length, or
  // charisma — and never infer a negative trait from a thin answer alone.
  return `You are assessing a startup founder's self-reported answers to a behavioral interview, one question per character dimension. Each answer should describe a real, specific example: what the founder personally did, and what happened as a result.

For EACH dimension below, rate how strongly the ANSWER demonstrates that trait on a 1-100 scale, based only on the concreteness and quality of the behavioral evidence given — never on English fluency, answer length, or writing style.
- 1-25 ("No evidence" / "Weak"): no real example, a generic trait description with no personal action, or an answer that dodges the question.
- 26-55 ("Adequate"): a specific example with a personal action, but limited depth, trade-off, or learning shown.
- 56-85 ("Strong"): a specific example with a real trade-off or decision, a clear personal action, a concrete outcome, and evidence of learning.
- 86-100: exceptionally detailed, self-aware, and consistent — reserve for answers that clearly exceed "Strong".
Do not infer a negative trait purely from a short or vague answer — score it low for lack of evidence, not as proof of a flaw.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
${schema}
}

${sections}`;
}

function parseEvaluation(raw: string, dims: EvidenceDimension[]): Record<EvidenceDimension, DimensionEval> | null {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out = {} as Record<EvidenceDimension, DimensionEval>;
  for (const dim of dims) {
    // deno-lint-ignore no-explicit-any
    const entry = (parsed as any)[dim];
    const score = Number(entry?.score);
    const observation = typeof entry?.observation === "string" ? entry.observation.slice(0, 300) : "";
    if (!Number.isFinite(score) || score < 1 || score > 100) return null;
    out[dim] = { score: Math.round(score), observation };
  }
  return out;
}

// Runs after the fast response below has already gone out: scores the
// already-saved answers via Gemini, writes one 'self' evidence row per
// answered dimension, and flips dna_scoring_status to 'scored'/'failed'. A
// Gemini failure here never surfaces to the client that submitted the
// request — it already got its 201 — so onboarding is never blocked by AI
// scoring being slow or down. Re-running this (e.g. a user-triggered retry,
// which is just calling submitAssessment again) simply re-attempts scoring;
// answers were already persisted synchronously, nothing is re-typed.
// `finished` is a separate concept from "scoring done" — DNA-02 made this
// fire once per question as it's answered, so scoring completing after just
// one dimension must NOT mark the whole assessment as completed (that
// previously hid the "fill in DNA" prompt after the very first answer, with
// no way back in); only the client's own last-question submit sets it.
// Only fires once, when the founder's own last-question submit finishes the
// assessment (see the `finished` param note above) — not on every per-
// question autosave.
async function notifyDnaAssessmentComplete(founderId: string): Promise<void> {
  const rows = await query<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [founderId]);
  // ref_id is bigint — founderId is a uuid, so it can't go there; the founder is
  // carried in payload.founderId instead (which is what the bell's tap-to-navigate reads).
  await notifyAdmins("evidence_added", null, {
    founderId,
    name: rows[0]?.name ?? undefined,
    dimension: "DNA self-assessment",
  });
}

async function scoreInBackground(founderId: string, answers: Answers, dims: EvidenceDimension[], finished: boolean): Promise<void> {
  try {
    if (dims.length === 0) {
      await query(
        "UPDATE founder_profiles SET dna_scoring_status = 'scored', updated_at = now() WHERE user_id = $1",
        [founderId],
      );
      return;
    }
    if (!isGeminiConfigured()) throw new Error("Gemini not configured");

    const raw = await generateText(buildPrompt(answers, dims));
    const evaluation = parseEvaluation(raw, dims);
    if (!evaluation) throw new Error("Gemini returned unparseable output");

    for (const dim of dims) {
      const { score, observation } = evaluation[dim];
      // FND-05/06: a DNA self-assessment answer is a current-state fact per
      // founder+dimension, not an accumulating history like evaluator/peer
      // feedback — dna_self_assessment_responses already upserts one row
      // per dimension, but this insert didn't mirror that, so re-answering
      // a dimension (now routine since DNA-02 saves per-question) piled up
      // duplicate 'self' evidence rows for the same dimension, double-
      // counting it in evidenceCount and skewing the weighted score.
      await query(
        `DELETE FROM evidence WHERE founder_id = $1 AND source_type = 'self' AND dimension = $2`,
        [founderId, dim],
      );
      await query(
        `INSERT INTO evidence (founder_id, source_type, dimension, signal, score, observation, is_negative, weight)
         VALUES ($1, 'self', $2, 'DNA self-assessment', $3, $4, false, $5)`,
        [founderId, dim, score, observation, SOURCE_WEIGHTS.self],
      );
    }

    await query(
      "UPDATE founder_profiles SET dna_scoring_status = 'scored', updated_at = now() WHERE user_id = $1",
      [founderId],
    );
    await recomputeFounderDna(founderId);
    await recomputeMatchesForFounder(founderId);
  } catch (e) {
    console.error("[dna-self-assessment] background scoring failed", e);
    await query(
      "UPDATE founder_profiles SET dna_scoring_status = 'failed', updated_at = now() WHERE user_id = $1",
      [founderId],
    ).catch(() => {});
  }
}

// POST /functions/v1/dna-self-assessment/:founderId — submit up to 8 answers
// (blank = skipped). Saves answers and responds immediately; AI scoring runs
// in the background (see scoreInBackground) so a slow/failed Gemini call
// never blocks onboarding. Calling this again (e.g. a retry after a failed
// scoring attempt) simply re-saves and re-attempts scoring.
async function submitAssessment(req: Request, params: Record<string, string>): Promise<Response> {
  const user = await authenticate(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const err = forbidden(user, params.founderId);
  if (err) return err;

  const body = await req.json().catch(() => ({}));
  const validationError = validateAnswers(body?.answers);
  if (validationError) return json({ error: validationError }, 400);
  const answers = body.answers as Answers;
  const finished = !!body.finished;

  const founderId = params.founderId;
  const dims = answeredDimensions(answers);

  // Onboarding answers the DNA step (step 5 of 7) before founder_profiles
  // is created — that row only gets INSERTed at the very end, in the
  // Finish step's updateFounderProfile call. Without this, every status
  // UPDATE below silently affects 0 rows for a brand-new founder: the raw
  // answers save fine (dna_self_assessment_responses.founder_id references
  // users, which already exists), but dna_scoring_status/
  // dna_self_assessment_completed_at never stick, so the "fill in your DNA
  // assessment" prompt never clears even after finishing all 8 questions.
  await query(
    `INSERT INTO founder_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [founderId],
  );

  for (const dim of DNA_DIMENSIONS) {
    if (!isAnswered(answers[dim])) continue;
    const { id: questionId, text: question } = DNA_QUESTIONS[dim];
    await query(
      `INSERT INTO dna_self_assessment_responses (founder_id, dimension, question_index, question, answer, assessment_version, question_id)
       VALUES ($1, $2, 1, $3, $4, $5, $6)
       ON CONFLICT (founder_id, assessment_version, dimension, question_id)
       DO UPDATE SET question = EXCLUDED.question, answer = EXCLUDED.answer, created_at = now()`,
      [founderId, dim, question, answers[dim], DNA_ASSESSMENT_VERSION, questionId],
    );
  }

  // "Finished the questionnaire" and "AI finished scoring it" are separate
  // facts — completed_at must be set here, synchronously, the moment the
  // founder submits their last answer. Setting it only after a successful
  // background Gemini call (the previous behavior) meant any scoring
  // failure — missing API key, Gemini outage, bad output — permanently
  // stranded the founder with a "fill in your DNA assessment" prompt that
  // could never clear, even though they'd genuinely answered everything.
  // dna_scoring_status tracks the AI side independently and can retry.
  await query(
    finished
      ? "UPDATE founder_profiles SET dna_scoring_status = 'pending', dna_self_assessment_completed_at = now(), updated_at = now() WHERE user_id = $1"
      : "UPDATE founder_profiles SET dna_scoring_status = 'pending', updated_at = now() WHERE user_id = $1",
    [founderId],
  );
  if (finished) background(notifyDnaAssessmentComplete(founderId));

  background(scoreInBackground(founderId, answers, dims, finished));

  return json({ status: "pending" }, 201);
}

serveFunction(FN, [
  route(FN, "GET", "/:founderId", getAssessment),
  route(FN, "POST", "/:founderId", submitAssessment),
]);

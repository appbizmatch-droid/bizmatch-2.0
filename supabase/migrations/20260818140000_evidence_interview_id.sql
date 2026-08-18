-- Track which interview produced each source_type='interview' evidence row,
-- so editing a completed interview's answers can re-score just that
-- interview's contribution without touching evidence from a founder's other
-- interviews (audit item: post-interview answer editing must recompute).
alter table public.evidence
  add column interview_id uuid references public.founder_interviews(id) on delete set null;

create index evidence_interview_idx on public.evidence(interview_id) where interview_id is not null;

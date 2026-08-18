import api from './api';

// Founders List (MVP screen 3)
export const listFounders = (params) => api.get('/founders', { params });

// Admin Dashboard (MVP screen 2)
export const getDashboard = () => api.get('/founders/dashboard');

// Top bar's cohort switcher — list only, no create/edit yet.
export const listPrograms = () => api.get('/founders/programs');

// Founder Profile (MVP screen 4) — admin or self
export const getFounder = (founderId) => api.get(`/founders/${founderId}`);
// Self-reported preview of a match candidate — a founder can call this for
// anyone already surfaced as one of their matches (see the backend's
// founder_compatibility check); it never includes evaluator-authored data.
export const getMatchPreview = (founderId) => api.get(`/founders/${founderId}/match-preview`);
export const updateFounderProfile = (founderId, payload) => api.put(`/founders/${founderId}/profile`, payload);
export const updateFounderCapabilities = (founderId, kind, items) =>
  api.put(`/founders/${founderId}/capabilities`, { kind, items });
export const updatePartnerRequirements = (founderId, payload) =>
  api.put(`/founders/${founderId}/partner-requirements`, payload);
export const updateDealBreakers = (founderId, labels, noneDeclared = false) =>
  api.put(`/founders/${founderId}/deal-breakers`, { labels, noneDeclared });
export const completeOnboarding = (founderId) => api.post(`/founders/${founderId}/onboarding/complete`);
export const setFounderStatus = (founderId, status) => api.patch(`/founders/${founderId}/status`, { status });
export const assignProgram = (founderId, programId) => api.patch(`/founders/${founderId}/program`, { programId });

export const uploadFounderCv = (founderId, uri, fileName) => {
  const form = new FormData();
  form.append('cv', { uri, name: fileName, type: 'application/pdf' });
  return api.post(`/founders/${founderId}/cv`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
// Web (expo-document-picker returns a Blob/File as `file`, not a react-native
// { uri, name, type } descriptor) needs the real File/Blob appended directly —
// wrapping it in the native-style object produces an empty upload on web.
export const uploadFounderCvWeb = (founderId, file, fileName) => {
  const form = new FormData();
  form.append('cv', file, fileName);
  return api.post(`/founders/${founderId}/cv`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

// Founder Insights (MVP screen 7) — derived from evidence, distinct from Profile
export const getFounderInsights = (founderId) => api.get(`/founder-dna/${founderId}`);

// Founder DNA self-assessment — 8 interview-grounded open-ended questions
// (1/dimension, v2), scored by Gemini in the background into one 'self'
// evidence row per answered dimension.
export const getDnaSelfAssessment = (founderId) => api.get(`/dna-self-assessment/${founderId}`);
export const submitDnaSelfAssessment = (founderId, answers, finished = false) =>
  api.post(`/dna-self-assessment/${founderId}`, { answers, finished });

// Evidence (MVP screen 4/7 timeline, filters)
export const listEvidence = (founderId, filters) =>
  api.get('/evidence', { params: { founderId, ...filters } });

// Interview / Evaluation (MVP screen 6)
export const submitAssessment = (payload) => api.post('/assessments', payload);
export const listAssessments = (founderId) => api.get('/assessments', { params: { founderId } });

// 13-item capability list (spec section 4) — shared frontend constant, matches
// the founders/model.ts comment: intentionally not a DB enum, tunable product config.
export const CAPABILITIES = [
  'Engineering', 'Product', 'UX/UI', 'Sales', 'GTM', 'Marketing',
  'Operations', 'Finance', 'Fundraising', 'Domain Expertise',
  'Community', 'Network / Introductions', 'Leadership',
];

export const DIMENSIONS = [
  'execution', 'integrity', 'commitment', 'communication',
  'conflict', 'resilience', 'ego', 'values',
];

export const DIMENSION_LABELS = {
  execution: 'Execution',
  integrity: 'Integrity',
  commitment: 'Commitment',
  communication: 'Communication',
  conflict: 'Conflict',
  resilience: 'Resilience',
  ego: 'Ego / Learning',
  values: 'Values',
};

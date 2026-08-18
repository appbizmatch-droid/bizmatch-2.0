import api from './api';

export const createProspectFounder = (payload) => api.post('/founders/prospect', payload);

export const listFounderInterviews = (founderId) => api.get('/founder-interviews', { params: { founderId } });
export const listAllInterviews = () => api.get('/founder-interviews');
export const getFounderInterview = (id) => api.get(`/founder-interviews/${id}`);
export const createFounderInterview = (founderId, meta) => api.post('/founder-interviews', { founderId, meta });
export const saveFounderInterview = (id, payload) => api.put(`/founder-interviews/${id}`, payload);
// Edits a COMPLETED interview's answers in place and re-scores the evidence
// it produced (source_type='interview'), then recomputes DNA + matches.
export const editCompletedInterviewAnswers = (id, payload) => api.put(`/founder-interviews/${id}/answers`, payload);
export const completeFounderInterview = (id) => api.post(`/founder-interviews/${id}/complete`);
export const deleteFounderInterview = (id) => api.delete(`/founder-interviews/${id}`);
export const resetFounderInterview = (id) => api.post(`/founder-interviews/${id}/reset`);

// Each call appends ONE independent take (segment) to the interview — never merges with a
// previous recording. Concatenating separately-finalized audio files client-side was tried and
// found unreliable (playback silently stops at whatever duration the browser first sniffs from
// the merged container, well before the actual end) — see the recording_segments migration.
export const uploadInterviewRecording = (id, uri, durationSeconds, fileName) => {
  const form = new FormData();
  form.append('recording', { uri, name: fileName, type: 'audio/m4a' });
  form.append('durationSeconds', String(durationSeconds));
  return api.post(`/founder-interviews/${id}/recording`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

// Web's expo-audio recorder yields a blob: URL, not a native { uri, name, type }
// descriptor — appending that object on web produces an empty upload (same
// gotcha as founders.service.js's uploadFounderCvWeb). Caller must resolve the
// blob: URL to a real Blob (fetch(uri).then(r => r.blob())) first.
export const uploadInterviewRecordingBlob = (id, blob, durationSeconds, fileName) => {
  const form = new FormData();
  form.append('recording', blob, fileName);
  form.append('durationSeconds', String(durationSeconds));
  return api.post(`/founder-interviews/${id}/recording`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};

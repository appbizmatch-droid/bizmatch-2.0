import api from './api';

// Activities (MVP screen 5-6)
export const listActivities = (programId, teamId, founderId) => api.get('/activities', { params: { programId, teamId, founderId } });
export const getActivity = (activityId) => api.get(`/activities/${activityId}`);
export const createActivity = (payload) => api.post('/activities', payload);
export const updateActivity = (activityId, payload) => api.patch(`/activities/${activityId}`, payload);
export const setActivityParticipants = (activityId, founderIds) =>
  api.put(`/activities/${activityId}/participants`, { founderIds });
export const setActivityEvaluators = (activityId, evaluatorIds) =>
  api.put(`/activities/${activityId}/evaluators`, { evaluatorIds });
export const listEvaluatorCandidates = () => api.get('/activities/evaluator-candidates');
export const deleteActivity = (activityId) => api.delete(`/activities/${activityId}`);

// Registration — founder requests to join an upcoming activity; admin approves/rejects.
export const registerForActivity = (activityId) => api.post(`/activities/${activityId}/register`);
export const decideActivityParticipant = (activityId, founderId, status) =>
  api.patch(`/activities/${activityId}/participants/${founderId}`, { status });

// Activity status is derived server-side from the starts_at/ends_at range, not set manually —
// this just formats that range for display, shared by every screen that lists/shows an activity.
export function formatActivityDateRange(startsAt, endsAt) {
  if (!startsAt || !endsAt) return null;
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = new Date(startsAt).toLocaleDateString(undefined, opts);
  const end = new Date(endsAt).toLocaleDateString(undefined, opts);
  return start === end ? start : `${start} – ${end}`;
}

export const ACTIVITY_TYPES = ['hackathon', 'workshop', 'interview', 'team_challenge', 'work_trial'];

export const ACTIVITY_TYPE_LABELS = {
  hackathon: 'Hackathon',
  workshop: 'Workshop',
  interview: 'Interview',
  team_challenge: 'Team Challenge',
  work_trial: 'Work Trial',
};

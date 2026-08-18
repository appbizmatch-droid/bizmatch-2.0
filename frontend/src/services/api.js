import axios from 'axios';
import useAuthStore from '../store/authStore';
import { API_BASE_URL } from '../config/constants';

const api = axios.create({ baseURL: API_BASE_URL });

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 2;

// Transient 5xx errors happen under DB pooler connection pressure (Supavisor
// rejects/times out excess connections under load) — retry idempotent GETs
// with a short backoff rather than surfacing a hard failure for what's often
// a one-request-later success. Never retry non-GET requests: a retried
// POST/PUT/PATCH/DELETE could double up a side effect if the first attempt
// actually succeeded server-side before the response was lost.
api.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
      return Promise.reject(err);
    }

    const config = err.config;
    const isGet = config?.method?.toLowerCase() === 'get';
    const retryCount = config?.__retryCount || 0;
    if (isGet && RETRYABLE_STATUSES.has(err.response?.status) && retryCount < MAX_RETRIES) {
      config.__retryCount = retryCount + 1;
      await new Promise(r => setTimeout(r, 300 * config.__retryCount));
      return api(config);
    }
    return Promise.reject(err);
  }
);

export default api;

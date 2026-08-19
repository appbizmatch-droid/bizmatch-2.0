import {
  View, Text, TouchableOpacity, Modal, FlatList,
  StyleSheet, TouchableWithoutFeedback,
} from 'react-native';
import { useState, useEffect, useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import useAppStore from '../store/appStore';
import useAuthStore from '../store/authStore';
import { supabase } from '../services/supabase';

const TYPE_ICON = {
  evidence_added:        '📊',
  assessment_requested:  '📝',
  match_ready:           '🤝',
  deal_breaker_flagged:  '⚠️',
  team_joined:           '👥',
  activity_added:        '📅',
};

const TYPE_LABEL = {
  evidence_added:        'New Evidence',
  assessment_requested:  'Evaluation Requested',
  match_ready:           'New Match Suggestion',
  deal_breaker_flagged:  'Deal Breaker Flagged',
  team_joined:           'Added to a Team',
  activity_added:        'Added to an Activity',
};

function formatTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TYPE_BODY = {
  evidence_added:        (p) => p?.dimension ? `New ${p.dimension} evidence recorded.` : 'New evidence recorded.',
  assessment_requested:  (p) => p?.founderName ? `Evaluation requested for ${p.founderName}.` : 'An evaluation was requested.',
  match_ready:           (p) => p?.founderName ? `New match suggestion with ${p.founderName}.` : 'A new match suggestion is ready.',
  deal_breaker_flagged:  (p) => p?.detail || 'A potential deal breaker needs review.',
  team_joined:           (p) => p?.teamName ? `You've been added to ${p.teamName}.` : "You've been added to a team.",
  activity_added:        () => "You've been added to an activity.",
};

// Realtime rows come back snake_case (raw DB columns); the REST API returns
// camelCase. Normalize both into one shape so the rest of the component
// doesn't care which source a notification came from.
function normalizeRow(row) {
  return {
    id: String(row.id),
    type: row.type,
    refId: row.refId ?? row.ref_id,
    payload: row.payload,
    readAt: row.readAt ?? row.read_at ?? null,
    createdAt: row.createdAt ?? row.created_at,
  };
}

export default function NotificationBell({ tintColor }) {
  const navigation = useNavigation();
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const userId = useAuthStore(s => s.user?.id);
  const isAdmin = useAuthStore(s => s.user?.role === 'admin');
  const notificationTick = useAppStore(s => s.notificationTick);

  const announceIfUnread = useCallback((n) => {
    if (n.readAt) return;
    useAppStore.getState().showBanner({
      title: TYPE_LABEL[n.type] || 'New Notification',
      body: (TYPE_BODY[n.type] || (() => ''))(n.payload),
      data: {
        type: n.type,
        refId: n.refId,
        founderId: n.payload?.founderId,
        activityId: n.payload?.activityId,
        teamId: n.payload?.teamId,
        selfId: userId,
        isAdmin,
      },
    });
  }, [userId, isAdmin]);

  // One-time fetch for initial state (and whenever something else in the
  // app bumps notificationTick to force a resync) — Realtime then takes over
  // for live updates instead of polling this endpoint on an interval.
  const fetchNotifications = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications');
      setNotifications(data.map(normalizeRow));
    } catch (err) {
      console.error('[Bell] fetch error', err);
    }
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications, notificationTick]);

  useEffect(() => {
    if (!userId) return undefined;

    const topic = `notifications:${userId}`;
    // supabase-js caches channels by topic and returns the same object for
    // an identical topic string — if this effect re-fires while a channel
    // for this topic is still registered (fast remount, multiple Bell
    // instances, StrictMode double-invoke), .channel() hands back the
    // already-subscribed instance and calling .on() on it throws
    // ("cannot add postgres_changes callbacks ... after subscribe()"),
    // which crashes the whole screen. Clear any stale registration first.
    const stale = supabase.getChannels().find(c => c.topic === `realtime:${topic}`);
    if (stale) supabase.removeChannel(stale);

    const channel = supabase
      .channel(topic)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}`,
      }, (payload) => {
        const row = normalizeRow(payload.new ?? payload.old);
        if (payload.eventType === 'INSERT') {
          setNotifications(prev => prev.some(n => n.id === row.id) ? prev : [row, ...prev]);
          announceIfUnread(row);
        } else if (payload.eventType === 'UPDATE') {
          setNotifications(prev => prev.map(n => (n.id === row.id ? row : n)));
        } else if (payload.eventType === 'DELETE') {
          setNotifications(prev => prev.filter(n => n.id !== row.id));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, announceIfUnread]);

  const unreadCount = notifications.filter(n => !n.readAt).length;

  const markIds = useCallback(async (ids) => {
    if (!ids.length) return;
    try {
      await api.post('/notifications/read', { ids });
      setNotifications(prev => prev.map(n => ids.includes(n.id) ? { ...n, readAt: new Date().toISOString() } : n));
    } catch { /* silent */ }
  }, []);

  const clearAll = useCallback(async () => {
    const prev = notifications;
    setNotifications([]);
    try {
      await api.delete('/notifications');
    } catch {
      setNotifications(prev);
    }
  }, [notifications]);

  const handleOpen = () => {
    setOpen(true);
  };

  const handleTap = (item) => {
    setOpen(false);
    if (!item.readAt) markIds([item.id]);
    // match_ready is the one founder-scoped type sent TO a founder rather
    // than an admin — payload.founderId is the *other* party in the match,
    // and GET /founders/:id is admin-or-self only, so a founder recipient
    // would 403 on it ("Could not load founder profile"). Send them to
    // their own profile's Matches tab instead, where the new match appears.
    if (item.type === 'match_ready' && !isAdmin) {
      navigation.navigate('FounderProfile', { founderId: userId });
      return;
    }
    // Other founder-scoped notifications (evidence_added, deal_breaker_flagged)
    // only ever go to admins, who can view any founder's profile.
    if (item.payload?.founderId) {
      navigation.navigate('FounderProfile', { founderId: item.payload.founderId });
      return;
    }
    // assessment_requested and activity_added both carry the activity id
    // instead (no founder yet — they're about the activity itself).
    if ((item.type === 'assessment_requested' || item.type === 'activity_added') && item.payload?.activityId) {
      navigation.navigate('ActivityDetail', { activityId: item.payload.activityId });
      return;
    }
    if (item.type === 'team_joined' && item.payload?.teamId) {
      navigation.navigate('TeamProfile', { teamId: item.payload.teamId });
    }
  };

  const iconColor = tintColor || '#022466';

  return (
    <>
      <TouchableOpacity style={styles.bellBtn} onPress={handleOpen} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <View style={styles.bellRow}>
          <Ionicons name="notifications-outline" size={22} color={iconColor} />
          {unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableWithoutFeedback onPress={() => setOpen(false)}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.bubble}>
                <View style={styles.bubbleHeader}>
                  <Text style={styles.bubbleTitle}>Notifications</Text>
                  {notifications.length > 0 && (
                    <TouchableOpacity onPress={clearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.clearAllText}>Clear all</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {notifications.length === 0 ? (
                  <Text style={styles.emptyText}>No notifications yet</Text>
                ) : (
                  <FlatList
                    data={notifications}
                    keyExtractor={item => String(item.id)}
                    style={styles.list}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.row, !item.readAt && styles.rowUnread]}
                        onPress={() => handleTap(item)}
                        activeOpacity={0.75}
                      >
                        <Text style={styles.rowIcon}>{TYPE_ICON[item.type] || '🔔'}</Text>
                        <View style={styles.rowBody}>
                          <Text style={styles.rowLabel}>{TYPE_LABEL[item.type] || item.type}</Text>
                          {(item.payload?.name || item.payload?.fromName || item.payload?.title) ? (
                            <Text style={styles.rowSub} numberOfLines={1}>
                              {item.payload.name || item.payload.fromName || item.payload.title}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.rowTime}>{formatTime(item.createdAt)}</Text>
                      </TouchableOpacity>
                    )}
                    ItemSeparatorComponent={() => <View style={styles.sep} />}
                  />
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellBtn: { padding: 4 },
  bellRow: { flexDirection: 'row', alignItems: 'flex-start' },
  badge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#E53E3E',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 3,
    marginLeft: -8,
    marginTop: -2,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2,36,102,0.35)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 80,
    paddingRight: 16,
  },
  bubble: {
    backgroundColor: '#fff',
    borderRadius: 16,
    width: 300,
    maxHeight: 420,
    shadowColor: '#022466',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 12,
    overflow: 'hidden',
  },
  bubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#DDE3F0',
  },
  bubbleTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#022466',
    letterSpacing: 0.3,
  },
  clearAllText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#5B6B93',
  },
  list: { maxHeight: 360 },
  emptyText: {
    fontSize: 13,
    color: '#8A96AE',
    textAlign: 'center',
    paddingVertical: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  rowUnread: { backgroundColor: '#F0F4FF' },
  rowIcon: { fontSize: 22, width: 30 },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#022466' },
  rowSub: { fontSize: 12, color: '#4A5A7A', marginTop: 2 },
  rowTime: { fontSize: 11, color: '#8A96AE' },
  sep: { height: 1, backgroundColor: '#F4F6F9', marginHorizontal: 14 },
});

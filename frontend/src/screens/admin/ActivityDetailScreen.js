import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
// @react-native-community/datetimepicker has no web build — a static top-level
// import would run its native-module-init code even on web and crash the
// whole bundle. require() it lazily, only on native, only when rendered.
const DateTimePicker = Platform.OS === 'web' ? null : require('@react-native-community/datetimepicker').default;
import { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { showAlert } from '../../services/alert';
import useAuthStore from '../../store/authStore';
import useAppStore from '../../store/appStore';
import { colors, investorColors, radius, cardShadow, typography } from '../../theme';
import {
  getActivity, createActivity, updateActivity, setActivityParticipants,
  registerForActivity, decideActivityParticipant, deleteActivity,
  setActivityEvaluators, listEvaluatorCandidates,
  ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, formatActivityDateRange,
} from '../../services/activities.service';
import { listFounders, DIMENSIONS, DIMENSION_LABELS } from '../../services/founders.service';
import { submitPeerFeedback, listPeerFeedback } from '../../services/peerFeedback.service';
import AppShell from '../../components/AppShell';
import { ADMIN_NAV_ITEMS, FOUNDER_NAV_ITEMS } from '../../config/nav';
import { Avatar, Pill } from '../../components/ui';

const STATUS_OPTIONS = ['upcoming', 'active', 'completed'];
const SCORE_OPTIONS = [20, 40, 60, 80, 100];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Activity status is derived server-side from the starts_at/ends_at range (see
// supabase/functions/activities/model.ts's STATUS_SQL) — the admin picks a date range, not a
// status. These helpers convert between the plain "YYYY-MM-DD" the date inputs use and the
// start/end-of-day ISO timestamps the range actually needs.
// DATE-01: toISOString() reads the UTC date, which for a timestamp built
// from local midnight (see startOfDayISO below) shows the day BEFORE the
// one actually picked for any timezone ahead of UTC (e.g. Israel, UTC+2/3)
// — deriving the string from the Date object's own local getters instead
// keeps it matching whatever the picker/input actually showed.
function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function toDateInputValue(isoString) {
  if (!isoString) return '';
  return toLocalDateStr(new Date(isoString));
}
function startOfDayISO(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function endOfDayISO(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

// Date picker, platform-branched: a native <input type="date"> on web (this
// app is primarily tested/deployed there), DateTimePicker's native modal on
// iOS/Android. Both read/write the same "YYYY-MM-DD" string the rest of this
// screen already works with.
function DateField({ value, onChange, inputStyle, C }) {
  if (Platform.OS === 'web') {
    return (
      <input
        type="date"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          backgroundColor: C.backgroundSoft,
          borderRadius: 10,
          padding: '12px 16px',
          fontSize: 15,
          color: C.textPrimary,
          border: `1px solid ${C.surfaceBorder}`,
          fontFamily: 'inherit',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    );
  }

  const [showPicker, setShowPicker] = useState(false);
  const dateValue = value ? new Date(`${value}T00:00:00`) : new Date();
  return (
    <>
      <TouchableOpacity onPress={() => setShowPicker(true)} activeOpacity={0.75}>
        <Text style={inputStyle}>{value || 'YYYY-MM-DD'}</Text>
      </TouchableOpacity>
      {showPicker && (
        <DateTimePicker
          value={dateValue}
          mode="date"
          display="default"
          onChange={(event, selected) => {
            setShowPicker(false);
            if (event.type === 'set' && selected) onChange(toLocalDateStr(selected));
          }}
        />
      )}
    </>
  );
}
// MVP screens 5-6 companion — Activity Detail: type/date/participants/status,
// admin participant management, and (for founders) the peer-feedback
// capture flow that fans out into evidence at weight 0.8 (screen 5's peer-
// feedback capture, kept as a lightweight inline variant rather than a
// second full evaluation form).
export default function ActivityDetailScreen({ route, navigation }) {
  const activityId = route.params?.activityId ?? null;
  const currentUser = useAuthStore(s => s.user);
  const isAdmin = currentUser?.role === 'admin';
  const darkMode = useAppStore(s => s.darkMode);
  const C = darkMode ? investorColors : colors;
  const styles = makeStyles(C);

  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(!!activityId);
  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [decidingId, setDecidingId] = useState(null);

  // Create-mode fields
  const [type, setType] = useState('workshop');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Date-range editing (existing activity)
  const [editingDates, setEditingDates] = useState(false);
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');

  // Participant management (admin)
  const [managingParticipants, setManagingParticipants] = useState(false);
  const [allFounders, setAllFounders] = useState([]);
  const [selectedFounderIds, setSelectedFounderIds] = useState(new Set());

  // Peer feedback given about each participant, scoped to this activity —
  // listPeerFeedback existed but nothing in the UI ever called it, so admins
  // had no way to see what founders submitted about each other here.
  const [peerFeedbackByFounder, setPeerFeedbackByFounder] = useState({});
  const [deleting, setDeleting] = useState(false);

  // Evaluator assignment (admin) — setActivityEvaluators existed with a working
  // backend route but no screen ever called it, so this was previously
  // impossible to do from the UI.
  const [managingEvaluators, setManagingEvaluators] = useState(false);
  const [evaluatorCandidates, setEvaluatorCandidates] = useState([]);
  const [selectedEvaluatorIds, setSelectedEvaluatorIds] = useState(new Set());

  const load = useCallback(async () => {
    if (!activityId) return;
    setLoading(true);
    try {
      const { data } = await getActivity(activityId);
      setActivity(data);
      const approvedIds = (data.participants || []).filter(p => p.status === 'approved').map(p => p.id);
      setSelectedFounderIds(new Set(approvedIds));
      setSelectedEvaluatorIds(new Set((data.evaluators || []).map(e => e.id)));

      if (isAdmin && approvedIds.length > 0) {
        const results = await Promise.all(approvedIds.map(id =>
          listPeerFeedback(id)
            .then(({ data: rows }) => [id, rows.filter(r => Number(r.activityId ?? r.activity_id) === Number(activityId))])
            .catch(() => [id, []]),
        ));
        setPeerFeedbackByFounder(Object.fromEntries(results));
      } else {
        setPeerFeedbackByFounder({});
      }
    } catch {
      showAlert('Error', 'Could not load this activity.');
    } finally {
      setLoading(false);
    }
  }, [activityId, isAdmin]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleCreate = async () => {
    if (!title.trim()) { showAlert('Missing Title', 'Give this activity a title.'); return; }
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      showAlert('Missing Dates', 'Choose both a start and end date for this activity.');
      return;
    }
    if (endDate < startDate) {
      showAlert('Invalid Range', 'The end date must be on or after the start date.');
      return;
    }
    setSaving(true);
    try {
      const { data } = await createActivity({
        type,
        title: title.trim(),
        description: description.trim() || null,
        startsAt: startOfDayISO(startDate),
        endsAt: endOfDayISO(endDate),
      });
      navigation.replace('ActivityDetail', { activityId: data.id });
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not create activity.');
    } finally {
      setSaving(false);
    }
  };

  const openDateEditor = () => {
    setEditStartDate(toDateInputValue(activity?.startsAt));
    setEditEndDate(toDateInputValue(activity?.endsAt));
    setEditingDates(true);
  };

  const saveDates = async () => {
    if (!DATE_RE.test(editStartDate) || !DATE_RE.test(editEndDate)) {
      showAlert('Missing Dates', 'Choose both a start and end date.');
      return;
    }
    if (editEndDate < editStartDate) {
      showAlert('Invalid Range', 'The end date must be on or after the start date.');
      return;
    }
    setSaving(true);
    try {
      const startsAt = startOfDayISO(editStartDate);
      const endsAt = endOfDayISO(editEndDate);
      await updateActivity(activityId, { startsAt, endsAt });
      setEditingDates(false);
      load();
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not update the date range.');
    } finally {
      setSaving(false);
    }
  };

  const openParticipantManager = async () => {
    setManagingParticipants(true);
    if (allFounders.length === 0) {
      try {
        const { data } = await listFounders({});
        setAllFounders(data);
      } catch { /* silent */ }
    }
  };

  const toggleFounder = (id) => {
    setSelectedFounderIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const saveParticipants = async () => {
    setSaving(true);
    try {
      await setActivityParticipants(activityId, [...selectedFounderIds]);
      setManagingParticipants(false);
      load();
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not update participants.');
    } finally {
      setSaving(false);
    }
  };

  const openEvaluatorManager = async () => {
    setManagingEvaluators(true);
    if (evaluatorCandidates.length === 0) {
      try {
        const { data } = await listEvaluatorCandidates();
        setEvaluatorCandidates(data);
      } catch { /* silent */ }
    }
  };

  const toggleEvaluator = (id) => {
    setSelectedEvaluatorIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const saveEvaluators = async () => {
    setSaving(true);
    try {
      await setActivityEvaluators(activityId, [...selectedEvaluatorIds]);
      setManagingEvaluators(false);
      load();
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not update evaluators.');
    } finally {
      setSaving(false);
    }
  };

  const handleRegister = async () => {
    setRegistering(true);
    try {
      await registerForActivity(activityId);
      load();
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not register for this activity.');
    } finally {
      setRegistering(false);
    }
  };

  const handleDecide = async (founderId, status) => {
    setDecidingId(founderId);
    try {
      await decideActivityParticipant(activityId, founderId, status);
      load();
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not update this registration.');
    } finally {
      setDecidingId(null);
    }
  };

  const handleDeleteActivity = () => {
    showAlert(
      'Delete Activity',
      'This activity, its participant list, and any evaluations tied to it will be permanently deleted. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteActivity(activityId);
              navigation.goBack();
            } catch (err) {
              showAlert('Error', err.response?.data?.error || 'Could not delete this activity.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const navItems = isAdmin ? ADMIN_NAV_ITEMS : FOUNDER_NAV_ITEMS;
  const approvedParticipants = (activity?.participants || []).filter(p => p.status === 'approved');
  const pendingParticipants = (activity?.participants || []).filter(p => p.status === 'pending');

  if (loading) {
    return (
      <AppShell navigation={navigation} active="activities" items={navItems}>
        <View style={styles.centered}><ActivityIndicator size="large" color={C.primary} /></View>
      </AppShell>
    );
  }

  return (
    <AppShell navigation={navigation} active="activities" items={navItems}>
      <View style={styles.header}>
        {/* NAV-01: also reached from a Team Profile's or Founder Profile's
            activity row, not just the Activities list — "← Activities" was
            wrong for those. */}
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backRow}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {!activityId ? (
          <View style={styles.card}>
            <Text style={styles.label}>Type</Text>
            <View style={styles.typeRow}>
              {ACTIVITY_TYPES.map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeChip, type === t && styles.typeChipActive]}
                  onPress={() => setType(t)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.typeChipText, type === t && styles.typeChipTextActive]}>
                    {ACTIVITY_TYPE_LABELS[t]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Title</Text>
            <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Cohort 26 Team Challenge" placeholderTextColor={C.textHint} />
            <Text style={styles.label}>Description (optional)</Text>
            <TextInput style={[styles.input, styles.multiline]} value={description} onChangeText={setDescription} multiline placeholder="What happens in this activity?" placeholderTextColor={C.textHint} />
            <View style={styles.dateRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Start date</Text>
                <DateField value={startDate} onChange={setStartDate} inputStyle={styles.input} C={C} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>End date</Text>
                <DateField value={endDate} onChange={setEndDate} inputStyle={styles.input} C={C} />
              </View>
            </View>
            <Text style={styles.hintText}>Status is set automatically from this range — upcoming until the start date, active through the end date, then completed.</Text>
            <TouchableOpacity style={[styles.btnPrimary, saving && styles.btnDisabled]} onPress={handleCreate} disabled={saving} activeOpacity={0.85}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Create Activity</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <View style={styles.titleRow}>
                <Text style={styles.title}>{activity?.title}</Text>
                <Pill
                  label={STATUS_OPTIONS.includes(activity?.status) ? activity.status.charAt(0).toUpperCase() + activity.status.slice(1) : activity?.status}
                  C={C}
                  bg={activity?.status === 'active' ? C.warningLight : activity?.status === 'completed' ? C.successLight : C.surfaceElevated}
                  color={activity?.status === 'active' ? C.warning : activity?.status === 'completed' ? C.success : C.textSecondary}
                />
              </View>
              <Text style={styles.meta}>
                {ACTIVITY_TYPE_LABELS[activity?.type] || activity?.type}
                {formatActivityDateRange(activity?.startsAt, activity?.endsAt) ? ` · ${formatActivityDateRange(activity.startsAt, activity.endsAt)}` : ''}
                {' · '}{approvedParticipants.length} participant{approvedParticipants.length === 1 ? '' : 's'}
              </Text>
              <Text style={styles.descriptionLabel}>About this activity</Text>
              <Text style={styles.description}>{activity?.description || 'No description provided.'}</Text>

              {!isAdmin && (
                <View style={styles.registerRow}>
                  {activity?.myStatus === 'approved' && activity?.status === 'active' ? (
                    <Pill label="Happening now" C={C} bg={C.warningLight} color={C.warning} />
                  ) : activity?.myStatus === 'approved' ? (
                    <Pill label="You're registered" C={C} bg={C.successLight} color={C.success} />
                  ) : activity?.myStatus === 'pending' ? (
                    <Pill label="Registration pending approval" C={C} bg={C.warningLight} color={C.warning} />
                  ) : activity?.myStatus === 'rejected' ? (
                    <Pill label="Registration not approved" C={C} bg={C.surfaceElevated} color={C.textSecondary} />
                  ) : activity?.status === 'upcoming' ? (
                    <TouchableOpacity style={[styles.registerBtn, registering && styles.btnDisabled]} onPress={handleRegister} disabled={registering} activeOpacity={0.85}>
                      {registering
                        ? <ActivityIndicator color="#fff" />
                        : <>
                            <Ionicons name="add-circle" size={16} color="#fff" />
                            <Text style={styles.btnPrimaryText}>Sign Up</Text>
                          </>
                      }
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}

              {isAdmin && !editingDates && (
                <View style={styles.statusRow}>
                  <Text style={styles.dateEditorText}>
                    {formatActivityDateRange(activity?.startsAt, activity?.endsAt) || 'No date range set'}
                  </Text>
                  <TouchableOpacity onPress={openDateEditor}>
                    <Text style={styles.linkText}>Edit dates</Text>
                  </TouchableOpacity>
                </View>
              )}
              {isAdmin && editingDates && (
                <View style={styles.dateEditorPanel}>
                  <View style={styles.dateRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>Start date</Text>
                      <DateField value={editStartDate} onChange={setEditStartDate} inputStyle={styles.input} C={C} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>End date</Text>
                      <DateField value={editEndDate} onChange={setEditEndDate} inputStyle={styles.input} C={C} />
                    </View>
                  </View>
                  <View style={styles.dateEditorActions}>
                    <TouchableOpacity onPress={() => setEditingDates(false)} disabled={saving} style={{ marginRight: 18 }}>
                      <Text style={styles.linkText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.btnPrimary, styles.btnCompact, saving && styles.btnDisabled]} onPress={saveDates} disabled={saving} activeOpacity={0.85}>
                      {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Save</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {isAdmin && pendingParticipants.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Pending Requests ({pendingParticipants.length})</Text>
                {pendingParticipants.map(p => (
                  <View key={p.id} style={styles.participantRow}>
                    <Avatar photoUrl={p.photoUrl} name={p.name} size={32} C={C} />
                    <Text style={[styles.participantName, { flex: 1 }]}>{p.name || 'Unnamed'}</Text>
                    <TouchableOpacity
                      onPress={() => handleDecide(p.id, 'approved')}
                      disabled={decidingId === p.id}
                      style={{ marginRight: 14 }}
                    >
                      <Text style={[styles.linkText, { color: C.success }]}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDecide(p.id, 'rejected')} disabled={decidingId === p.id}>
                      <Text style={[styles.linkText, { color: C.error }]}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.card}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionLabel}>Participants ({approvedParticipants.length})</Text>
                {isAdmin && (
                  <TouchableOpacity onPress={openParticipantManager}>
                    <Text style={styles.linkText}>Manage</Text>
                  </TouchableOpacity>
                )}
              </View>
              {approvedParticipants.length === 0 ? (
                <Text style={styles.emptyText}>No participants added yet.</Text>
              ) : (
                approvedParticipants.map(p => (
                  <View key={p.id} style={styles.participantRow}>
                    <Avatar photoUrl={p.photoUrl} name={p.name} size={32} C={C} />
                    <Text style={[styles.participantName, { flex: 1 }]}>{p.name || 'Unnamed'}</Text>
                    {isAdmin && (
                      <TouchableOpacity onPress={() => navigation.navigate('Evaluation', { founderId: p.id, activityId })}>
                        <Text style={styles.linkText}>Evaluate</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))
              )}

              {managingParticipants && (
                <View style={styles.managePanel}>
                  {allFounders.map(f => (
                    <TouchableOpacity key={f.id} style={styles.checkRow} onPress={() => toggleFounder(f.id)} activeOpacity={0.7}>
                      <View style={[styles.checkbox, selectedFounderIds.has(f.id) && styles.checkboxChecked]} />
                      <Text style={styles.participantName}>{f.name || 'Unnamed'}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={[styles.btnPrimary, saving && styles.btnDisabled]} onPress={saveParticipants} disabled={saving} activeOpacity={0.85}>
                    {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Save Participants</Text>}
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {isAdmin && (
              <View style={styles.card}>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionLabel}>Evaluators ({(activity?.evaluators || []).length})</Text>
                  <TouchableOpacity onPress={openEvaluatorManager}>
                    <Text style={styles.linkText}>Manage</Text>
                  </TouchableOpacity>
                </View>
                {(activity?.evaluators || []).length === 0 ? (
                  <Text style={styles.emptyText}>No evaluators assigned yet.</Text>
                ) : (
                  (activity?.evaluators || []).map(e => (
                    <View key={e.id} style={styles.participantRow}>
                      <Text style={[styles.participantName, { flex: 1 }]}>{e.name || 'Unnamed'}</Text>
                    </View>
                  ))
                )}

                {managingEvaluators && (
                  <View style={styles.managePanel}>
                    {evaluatorCandidates.map(ev => (
                      <TouchableOpacity key={ev.id} style={styles.checkRow} onPress={() => toggleEvaluator(ev.id)} activeOpacity={0.7}>
                        <View style={[styles.checkbox, selectedEvaluatorIds.has(ev.id) && styles.checkboxChecked]} />
                        <Text style={styles.participantName}>{ev.name || 'Unnamed'}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity style={[styles.btnPrimary, saving && styles.btnDisabled]} onPress={saveEvaluators} disabled={saving} activeOpacity={0.85}>
                      {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Save Evaluators</Text>}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}

            {isAdmin && approvedParticipants.some(p => (peerFeedbackByFounder[p.id] || []).length > 0) && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Peer Feedback</Text>
                {approvedParticipants.map(p => {
                  const rows = peerFeedbackByFounder[p.id] || [];
                  if (rows.length === 0) return null;
                  return (
                    <View key={p.id} style={{ marginBottom: 12 }}>
                      <Text style={[styles.participantName, { marginBottom: 6 }]}>{p.name || 'Unnamed'}</Text>
                      {rows.map(r => (
                        <View key={r.id} style={styles.participantRow}>
                          <Text style={[styles.emptyText, { flex: 1 }]}>
                            {DIMENSION_LABELS[r.dimension] || r.dimension} — {r.score}
                            {r.observation ? `: ${r.observation}` : ''}
                          </Text>
                          <Text style={styles.emptyText}>{r.authorName || r.author_name || ''}</Text>
                        </View>
                      ))}
                    </View>
                  );
                })}
              </View>
            )}

            {!isAdmin && activity?.myStatus === 'approved' && (
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Give Peer Feedback</Text>
                {approvedParticipants.filter(p => p.id !== currentUser?.id).length === 0 ? (
                  <Text style={styles.emptyText}>No other participants to give feedback to yet.</Text>
                ) : (
                  approvedParticipants.filter(p => p.id !== currentUser?.id).map(p => (
                    <PeerFeedbackRow key={p.id} founder={p} activityId={activityId} C={C} styles={styles} />
                  ))
                )}
              </View>
            )}

            {isAdmin && (
              <View style={styles.card}>
                <Text style={[styles.sectionLabel, { color: C.error }]}>Danger Zone</Text>
                <Text style={[styles.emptyText, { marginTop: 6, marginBottom: 12 }]}>
                  Permanently delete this activity and its participant/evaluation data.
                </Text>
                <TouchableOpacity style={styles.deleteBtn} onPress={handleDeleteActivity} activeOpacity={0.85} disabled={deleting}>
                  {deleting ? <ActivityIndicator color={C.error} size="small" /> : <Text style={styles.deleteBtnText}>Delete Activity</Text>}
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </AppShell>
  );
}

// Every dimension gets its own row with an independent, optional score —
// previously this forced picking ONE dimension via a chip selector before a
// score could even be entered, which read as "you must rate exactly one
// dimension" rather than "rate whichever ones you have an opinion on."
function PeerFeedbackRow({ founder, activityId, C, styles }) {
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState({}); // { [dimension]: score }
  const [observation, setObservation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const setDimensionScore = (dim, n) => {
    setScores(prev => ({ ...prev, [dim]: prev[dim] === n ? undefined : n }));
  };

  const ratedDimensions = DIMENSIONS.filter(d => scores[d] != null);

  const handleSubmit = async () => {
    if (ratedDimensions.length === 0) return;
    setSubmitting(true);
    try {
      const items = ratedDimensions.map(d => ({ dimension: d, score: scores[d], observation: observation.trim() || null }));
      await submitPeerFeedback({ founderId: founder.id, activityId, items });
      setSubmitted(true);
      setOpen(false);
    } catch (err) {
      showAlert('Error', err.response?.data?.error || 'Could not submit peer feedback.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.peerFeedbackBlock}>
      <TouchableOpacity style={styles.participantRow} onPress={() => setOpen(v => !v)} activeOpacity={0.75}>
        <Text style={styles.participantName}>{founder.name || 'Unnamed'}</Text>
        <Text style={styles.linkText}>{submitted ? '✓ Rated' : open ? 'Cancel' : 'Rate'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.peerFeedbackForm}>
          <Text style={styles.peerFeedbackHint}>Rate whichever dimensions you have an opinion on — all optional.</Text>
          {DIMENSIONS.map(d => (
            <View key={d} style={styles.dimensionRow}>
              <Text style={styles.dimensionRowLabel}>{DIMENSION_LABELS[d]}</Text>
              <View style={styles.scaleRow}>
                {SCORE_OPTIONS.map(n => (
                  <TouchableOpacity
                    key={n}
                    style={[styles.scaleBtn, scores[d] === n && styles.scaleBtnActive]}
                    onPress={() => setDimensionScore(d, n)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.scaleBtnText, scores[d] === n && styles.scaleBtnTextActive]}>{n}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          ))}
          <TextInput
            style={[styles.input, styles.multiline]}
            value={observation}
            onChangeText={setObservation}
            multiline
            placeholder="Optional observation (applies to every dimension rated above)..."
            placeholderTextColor={C.textHint}
          />
          <TouchableOpacity
            style={[styles.btnPrimary, (submitting || ratedDimensions.length === 0) && styles.btnDisabled]}
            onPress={handleSubmit}
            disabled={submitting || ratedDimensions.length === 0}
            activeOpacity={0.85}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnPrimaryText}>Submit Feedback{ratedDimensions.length > 0 ? ` (${ratedDimensions.length})` : ''}</Text>
            }
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function makeStyles(C) {
  return StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    backRow: {},
    backText: { color: C.primary, ...typography.labelLarge },
    scrollContent: { padding: 20, paddingTop: 8, paddingBottom: 48, maxWidth: 900, width: '100%', alignSelf: 'center' },
    card: { backgroundColor: C.surface, borderRadius: radius.lg, padding: 16, marginBottom: 14, ...cardShadow },
    deleteBtn: {
      borderWidth: 1, borderColor: C.error, borderRadius: radius.md,
      paddingVertical: 12, alignItems: 'center',
    },
    deleteBtnText: { color: C.error, fontWeight: '700', fontSize: 14 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },

    label: { ...typography.labelLarge, color: C.textSecondary, marginBottom: 6, marginTop: 10 },
    input: {
      backgroundColor: C.backgroundSoft, borderRadius: radius.md, padding: 12,
      color: C.textPrimary, fontSize: 14, borderWidth: 1, borderColor: C.surfaceBorder,
    },
    multiline: { minHeight: 70, textAlignVertical: 'top' },
    dateRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
    hintText: { ...typography.caption, color: C.textHint, marginTop: 8 },

    typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
    typeChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: C.surfaceBorder, backgroundColor: C.surface },
    typeChipActive: { backgroundColor: C.primary, borderColor: C.primary },
    typeChipText: { fontSize: 12, fontWeight: '700', color: C.textSecondary },
    typeChipTextActive: { color: '#fff' },

    title: { ...typography.titleLarge, color: C.textPrimary },
    meta: { ...typography.bodySmall, color: C.textSecondary, marginTop: 4 },
    descriptionLabel: { ...typography.labelSmall, textTransform: 'uppercase', color: C.textHint, marginTop: 16, marginBottom: 6 },
    description: { ...typography.bodyMedium, color: C.textSecondary },

    statusRow: { flexDirection: 'row', gap: 8, marginTop: 14, alignItems: 'center', justifyContent: 'space-between' },
    dateEditorText: { ...typography.bodySmall, color: C.textSecondary },
    dateEditorPanel: { marginTop: 14, borderTopWidth: 1, borderTopColor: C.surfaceBorder, paddingTop: 14 },
    dateEditorActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 10 },
    btnCompact: { marginTop: 0, paddingVertical: 10, paddingHorizontal: 20 },
    registerRow: { marginTop: 14, alignItems: 'flex-start' },
    registerBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: C.primary, borderRadius: radius.pill,
      paddingHorizontal: 20, paddingVertical: 12,
    },

    sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    sectionLabel: { ...typography.labelSmall, textTransform: 'uppercase', color: C.textHint },
    linkText: { color: C.primary, ...typography.labelLarge },
    emptyText: { ...typography.bodyMedium, color: C.textHint },

    participantRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.surfaceBorder,
    },
    participantName: { ...typography.bodyMedium, color: C.textPrimary },

    managePanel: { marginTop: 12, borderTopWidth: 1, borderTopColor: C.surfaceBorder, paddingTop: 12 },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
    checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: C.surfaceBorder },
    checkboxChecked: { backgroundColor: C.primary, borderColor: C.primary },

    peerFeedbackBlock: {},
    peerFeedbackForm: { paddingVertical: 12, gap: 10 },
    peerFeedbackHint: { ...typography.caption, color: C.textHint, marginBottom: 4 },
    dimensionRow: { gap: 6, paddingVertical: 6 },
    dimensionRowLabel: { ...typography.labelSmall, color: C.textSecondary, fontWeight: '600' },
    scaleRow: { flexDirection: 'row', gap: 8 },
    scaleBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: C.surfaceBorder, alignItems: 'center' },
    scaleBtnActive: { backgroundColor: C.primary, borderColor: C.primary },
    scaleBtnText: { fontWeight: '700', fontSize: 13, color: C.textSecondary },
    scaleBtnTextActive: { color: '#fff' },

    btnPrimary: { backgroundColor: C.primary, borderRadius: radius.pill, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
    btnDisabled: { opacity: 0.6 },
    btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  });
}

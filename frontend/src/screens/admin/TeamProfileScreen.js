import {
  View, Text, TouchableOpacity, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { showAlert } from '../../services/alert';
import useAuthStore from '../../store/authStore';
import useAppStore from '../../store/appStore';
import { colors, investorColors, radius, cardShadow, typography } from '../../theme';
import { getTeam, recomputeTeam, setTeamMembers, deleteTeam } from '../../services/teams.service';
import { listActivities, ACTIVITY_TYPE_LABELS } from '../../services/activities.service';
import { listFounders, DIMENSION_LABELS } from '../../services/founders.service';
import AppShell from '../../components/AppShell';
import { ADMIN_NAV_ITEMS, FOUNDER_NAV_ITEMS } from '../../config/nav';
import { Avatar, Pill, SectionCard, ResponsiveRow } from '../../components/ui';

// MVP screen 10 — Team Profile: name, members (name/role/core skills), Team
// Strengths, Complementary Skills, Potential Gaps, Compatibility, Potential
// Friction, Team Activities.
export default function TeamProfileScreen({ route, navigation }) {
  const teamId = route.params?.teamId;
  const isAdmin = useAuthStore(s => s.user?.role === 'admin');
  const darkMode = useAppStore(s => s.darkMode);
  const C = darkMode ? investorColors : colors;
  const styles = makeStyles(C);
  const navItems = isAdmin ? ADMIN_NAV_ITEMS : FOUNDER_NAV_ITEMS;
  const activeNav = isAdmin ? 'teams' : undefined;

  const [team, setTeam] = useState(null);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  // Member management (TEAM-05/06) — backend already supported PUT
  // /teams/:id/members (full-replace) and DELETE /teams/:id; this was purely
  // a missing frontend surface.
  const [managing, setManaging] = useState(false);
  const [availableFounders, setAvailableFounders] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [savingMembers, setSavingMembers] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [teamRes, activitiesRes] = await Promise.all([
        getTeam(teamId),
        listActivities(undefined, teamId),
      ]);
      setTeam(teamRes.data);
      setActivities(activitiesRes.data);
    } catch {
      showAlert('Error', 'Could not load this team.');
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      await recomputeTeam(teamId);
      await load();
    } catch {
      showAlert('Error', 'Could not recompute this team.');
    } finally {
      setRecomputing(false);
    }
  };

  const startManaging = async () => {
    setManaging(true);
    setSelectedIds(new Set((team?.members || []).map(m => m.id)));
    try {
      // team_founders.founder_id is unique (one team per founder), same
      // constraint TeamCreationScreen works around — offer this team's
      // current members plus anyone not yet on any team.
      const { data } = await listFounders({});
      setAvailableFounders(data.filter(f => f.teamStatus !== 'in_team' && !f.isProspect));
    } catch {
      setAvailableFounders([]);
    }
  };

  const cancelManaging = () => {
    setManaging(false);
    setSelectedIds(new Set());
  };

  const toggleMember = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const saveMembers = async () => {
    if (selectedIds.size === 0) {
      showAlert('Error', 'A team needs at least one member.');
      return;
    }
    setSavingMembers(true);
    try {
      await setTeamMembers(teamId, [...selectedIds]);
      setManaging(false);
      await load();
    } catch {
      showAlert('Error', 'Could not update team members.');
    } finally {
      setSavingMembers(false);
    }
  };

  const handleDeleteTeam = () => {
    showAlert(
      'Delete team',
      `"${team?.name}" and its compatibility data will be permanently deleted. Members are not removed from the program — this can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteTeam(teamId);
              navigation.goBack();
            } catch {
              showAlert('Error', 'Could not delete this team.');
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <AppShell navigation={navigation} active={activeNav} items={navItems}>
        <View style={styles.centered}><ActivityIndicator size="large" color={C.primary} /></View>
      </AppShell>
    );
  }

  const profile = team?.profile;

  return (
    <AppShell navigation={navigation} active={activeNav} items={navItems}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* NAV-01: reached from both Teams list and a Founder Profile's
            "Team: X →" link — "← Teams" was wrong for the latter. */}
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backRow}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.titleRow}>
          <View style={styles.avatarCluster}>
            {(team?.members || []).slice(0, 3).map((m, i) => (
              <View key={m.id} style={[styles.avatarStack, i > 0 && { marginLeft: -12 }]}>
                <Avatar photoUrl={m.photoUrl} name={m.name} size={48} C={C} />
              </View>
            ))}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.teamName}>{team?.name}</Text>
            <Text style={styles.teamMeta}>{(team?.members || []).length} member{(team?.members || []).length === 1 ? '' : 's'}</Text>
          </View>
          {isAdmin && !managing ? (
            <TouchableOpacity style={styles.refreshBtn} onPress={startManaging} activeOpacity={0.85}>
              <Text style={styles.refreshText}>Manage Members</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.refreshBtn} onPress={handleRecompute} disabled={recomputing} activeOpacity={0.85}>
            {recomputing ? <ActivityIndicator color={C.primary} size="small" /> : <Text style={styles.refreshText}>Recompute</Text>}
          </TouchableOpacity>
        </View>

        <ResponsiveRow gap={16} style={{ marginTop: 16 }}>
          <View style={{ flex: 1 }}>
            <SectionCard title="Members" icon="people-outline" C={C} style={{ flex: 1 }}>
              {!managing ? (
                (team?.members || []).map(m => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.memberRow}
                    onPress={() => navigation.navigate('FounderProfile', { founderId: m.id })}
                    activeOpacity={0.75}
                  >
                    <Avatar photoUrl={m.photoUrl} name={m.name} size={36} C={C} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{m.name || 'Unnamed'}</Text>
                      <Text style={styles.memberRole}>{m.roleTitle || ''}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={C.textHint} />
                  </TouchableOpacity>
                ))
              ) : (
                <>
                  <Text style={styles.manageHint}>Selected — will remain or join this team:</Text>
                  {[...(team?.members || []), ...availableFounders.filter(f => !(team?.members || []).some(m => m.id === f.id))]
                    .filter((f, i, arr) => arr.findIndex(x => x.id === f.id) === i)
                    .map(f => {
                      const checked = selectedIds.has(f.id);
                      return (
                        <TouchableOpacity
                          key={f.id}
                          style={styles.memberRow}
                          onPress={() => toggleMember(f.id)}
                          activeOpacity={0.75}
                        >
                          <Ionicons
                            name={checked ? 'checkbox' : 'square-outline'}
                            size={20}
                            color={checked ? C.primary : C.textHint}
                          />
                          <Avatar photoUrl={f.photoUrl} name={f.name} size={32} C={C} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.memberName}>{f.name || 'Unnamed'}</Text>
                            <Text style={styles.memberRole}>{f.role || ''}</Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  <View style={styles.manageActions}>
                    <TouchableOpacity style={styles.cancelBtn} onPress={cancelManaging} activeOpacity={0.85} disabled={savingMembers}>
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.saveBtn} onPress={saveMembers} activeOpacity={0.85} disabled={savingMembers}>
                      {savingMembers ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </SectionCard>
          </View>

          <View style={{ flex: 1 }}>
            <SectionCard title="Compatibility" icon="heart-outline" iconColor={C.success} iconBg={C.successLight} C={C} style={{ flex: 1 }}>
              <View style={styles.scoreBlock}>
                <Text style={styles.scoreValue}>{profile?.compatibility ?? '—'}%</Text>
                {profile?.isProvisional ? (
                  <Pill label="Provisional" C={C} bg={C.surfaceElevated} color={C.textSecondary} />
                ) : null}
                <Text style={styles.scoreCaption}>
                  {profile?.pairsScored ?? 0} of {profile?.pairsExpected ?? 0} member pairs scored
                </Text>
              </View>
            </SectionCard>
          </View>
        </ResponsiveRow>

        <ResponsiveRow gap={16} style={{ marginTop: 16 }}>
          {profile?.strengths?.length > 0 && (
            <View style={{ flex: 1 }}>
              <SectionCard title="Team Strengths" icon="star-outline" iconColor={C.success} iconBg={C.successLight} C={C} style={{ flex: 1 }}>
                {profile.strengths.map(d => (
                  <View key={d} style={styles.checkLine}>
                    <Ionicons name="checkmark-circle" size={16} color={C.success} />
                    <Text style={styles.checkLineText}>{DIMENSION_LABELS[d] || d}</Text>
                  </View>
                ))}
              </SectionCard>
            </View>
          )}

          {profile?.complementarySkills?.length > 0 && (
            <View style={{ flex: 1 }}>
              <SectionCard title="Complementary Skills" icon="extension-puzzle-outline" C={C} style={{ flex: 1 }}>
                <View style={styles.chipWrap}>
                  {profile.complementarySkills.map(s => (
                    <Pill key={s} label={s} C={C} bg={C.surfaceElevated} color={C.primary} />
                  ))}
                </View>
              </SectionCard>
            </View>
          )}
        </ResponsiveRow>

        <ResponsiveRow gap={16} style={{ marginTop: 16 }}>
          {(profile?.potentialGaps?.length > 0 || profile?.capabilityGaps?.length > 0) && (
            <View style={{ flex: 1 }}>
              <SectionCard title="Potential Gaps" icon="alert-circle-outline" iconColor={C.warning} iconBg={C.warningLight} C={C} style={{ flex: 1 }}>
                {profile.potentialGaps.map(d => (
                  <Text key={d} style={[styles.bullet, { color: C.warning }]}>• Weak {DIMENSION_LABELS[d] || d}</Text>
                ))}
                {profile.capabilityGaps.length > 0 && (
                  <Text style={[styles.bodyText, { color: C.warning, marginTop: 6 }]}>
                    No one provides: {profile.capabilityGaps.join(', ')}
                  </Text>
                )}
              </SectionCard>
            </View>
          )}

          {profile?.potentialFriction?.length > 0 && (
            <View style={{ flex: 1 }}>
              <SectionCard title="Potential Friction" icon="flash-outline" iconColor={C.error} iconBg={C.errorLight} C={C} style={{ flex: 1 }}>
                {profile.potentialFriction.map((f, i) => <Text key={i} style={[styles.bullet, { color: C.error }]}>• {f}</Text>)}
              </SectionCard>
            </View>
          )}
        </ResponsiveRow>

        <View style={{ marginTop: 16 }}>
          <SectionCard title="Team Activities" icon="calendar-outline" C={C}>
            {activities.length === 0 ? (
              <Text style={styles.emptyText}>No activities logged for this team yet.</Text>
            ) : (
              activities.map(a => (
                <TouchableOpacity key={a.id} style={styles.activityRow} onPress={() => navigation.navigate('ActivityDetail', { activityId: a.id })} activeOpacity={0.75}>
                  <Text style={styles.memberName}>{a.title}</Text>
                  <Text style={styles.memberRole}>{ACTIVITY_TYPE_LABELS[a.type] || a.type}</Text>
                </TouchableOpacity>
              ))
            )}
          </SectionCard>
        </View>

        {isAdmin ? (
          <View style={{ marginTop: 16 }}>
            <SectionCard title="Danger Zone" icon="warning-outline" iconColor={C.error} iconBg={C.errorLight} C={C}>
              <Text style={styles.bodyText}>Permanently delete this team and its compatibility data.</Text>
              <TouchableOpacity style={styles.deleteBtn} onPress={handleDeleteTeam} activeOpacity={0.85} disabled={deleting}>
                {deleting ? <ActivityIndicator color={C.error} size="small" /> : <Text style={styles.deleteBtnText}>Delete Team</Text>}
              </TouchableOpacity>
            </SectionCard>
          </View>
        ) : null}
      </ScrollView>
    </AppShell>
  );
}

function makeStyles(C) {
  return StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    scrollContent: { padding: 20, paddingBottom: 48, maxWidth: 1100, width: '100%', alignSelf: 'center' },
    backRow: { marginBottom: 12 },
    backText: { color: C.primary, ...typography.labelLarge },

    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    avatarCluster: { flexDirection: 'row' },
    avatarStack: { borderWidth: 3, borderColor: C.backgroundSoft, borderRadius: 24 },
    teamName: { ...typography.displayMedium, color: C.textPrimary },
    teamMeta: { ...typography.bodyMedium, color: C.textSecondary, marginTop: 2 },
    refreshBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1.5, borderColor: C.surfaceBorder },
    refreshText: { color: C.primary, fontWeight: '700', fontSize: 13 },

    memberRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.surfaceBorder,
    },
    memberName: { ...typography.bodyMedium, color: C.textPrimary },
    memberRole: { ...typography.bodySmall, color: C.textHint },

    scoreBlock: { alignItems: 'center', paddingVertical: 8, gap: 6 },
    scoreValue: { fontSize: 40, fontWeight: '800', color: C.success },
    scoreCaption: { ...typography.caption, color: C.textHint, marginTop: 2 },

    checkLine: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
    checkLineText: { ...typography.bodyMedium, color: C.textPrimary },

    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },

    bullet: { ...typography.bodyMedium, marginBottom: 6, lineHeight: 20 },
    bodyText: { ...typography.bodyMedium, color: C.textPrimary },
    emptyText: { ...typography.bodyMedium, color: C.textHint },
    activityRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.surfaceBorder,
    },

    manageHint: { ...typography.caption, color: C.textHint, marginBottom: 8 },
    manageActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
    cancelBtn: {
      flex: 1, paddingVertical: 12, borderRadius: radius.pill, alignItems: 'center',
      borderWidth: 1.5, borderColor: C.surfaceBorder,
    },
    cancelBtnText: { color: C.textSecondary, fontWeight: '700', fontSize: 14 },
    saveBtn: {
      flex: 2, paddingVertical: 12, borderRadius: radius.pill, alignItems: 'center',
      backgroundColor: C.primary,
    },
    saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    deleteBtn: {
      marginTop: 12, paddingVertical: 12, borderRadius: radius.pill, alignItems: 'center',
      borderWidth: 1.5, borderColor: C.error,
    },
    deleteBtnText: { color: C.error, fontWeight: '700', fontSize: 14 },
  });
}

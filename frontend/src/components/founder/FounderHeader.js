import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { radius, cardShadow, typography } from '../../theme';
import { Pill, useIsDesktop } from '../ui';

const STATUS_COLORS = {
  active: { bg: '#E8F7F2', text: '#1A9E6A', label: 'Active' },
  inactive: { bg: '#FEF6EC', text: '#E67E22', label: 'Inactive' },
  dropped: { bg: '#FDECEA', text: '#C0392B', label: 'Dropped' },
};

function confidenceLevel(pct) {
  if (pct == null) return null;
  if (pct >= 70) return 'High';
  if (pct >= 40) return 'Medium';
  return 'Low';
}

function formatCommitment(type) {
  if (!type) return null;
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatJoined(dateStr) {
  if (!dateStr) return null;
  try {
    return `Joined ${new Date(dateStr).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
  } catch {
    return null;
  }
}

function Avatar({ photoUrl, name, size, C }) {
  if (photoUrl) return <Image source={{ uri: photoUrl }} style={{ width: size, height: size, borderRadius: radius.lg }} />;
  return (
    <View style={[styles.avatarPlaceholder, { width: size, height: size, borderRadius: radius.lg, backgroundColor: C.primary }]}>
      <Text style={{ color: '#fff', fontWeight: '800', fontSize: size * 0.36 }}>
        {name ? name[0].toUpperCase() : '?'}
      </Text>
    </View>
  );
}

function StatTile({ icon, iconColor, iconBg, value, label, progress, C, styles2 }) {
  return (
    <View style={styles2.statTile}>
      <View style={[styles2.statIconCircle, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles2.statValue}>{value}</Text>
        <Text style={styles2.statLabel}>{label}</Text>
        {progress != null ? (
          <View style={styles2.statTrack}>
            <View style={[styles2.statFill, { width: `${Math.max(0, Math.min(100, progress))}%`, backgroundColor: iconColor }]} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

// Founder Profile identity card — bordered card with avatar, name/role/meta
// on the left and confidence/evidence/activity stat tiles on the right
// (row on desktop, stacked below identity on mobile), matching the profile
// page mockup.
export default function FounderHeader({ founder, insights, evidenceCount, activitiesCount, C, isAdmin, onTeamPress }) {
  const isDesktop = useIsDesktop();
  const styles2 = makeStyles(C);
  const status = STATUS_COLORS[founder?.status] || STATUS_COLORS.active;
  const confidencePct = insights?.profileConfidence ?? null;
  const level = confidenceLevel(confidencePct);
  const levelColor = level === 'High' ? C.success : level === 'Medium' ? C.warning : C.error;
  const commitment = formatCommitment(founder?.commitmentType);
  const joined = formatJoined(founder?.onboardingCompletedAt);

  return (
    <View style={[styles2.card, isDesktop && styles2.cardDesktop]}>
      <View style={[styles2.identity, isDesktop && styles2.identityDesktop]}>
        <Avatar photoUrl={founder?.photoUrl} name={founder?.name} size={isDesktop ? 76 : 88} C={C} />
        <View style={isDesktop ? { flex: 1 } : { alignItems: 'center' }}>
          {founder?.currentRole ? (
            // numberOfLines is required here, not cosmetic: at in-between
            // window widths (above the mobile breakpoint but too narrow for
            // the desktop stat-tile row's combined minWidth), this flex:1
            // text container can get squeezed to just a few px wide. RN Web
            // wraps unconstrained Text one character per line in that case
            // (illegible vertical text) instead of truncating — this forces
            // a graceful single-line ellipsis instead.
            <Text style={[styles2.role, !isDesktop && { textAlign: 'center' }]} numberOfLines={1}>{founder.currentRole}</Text>
          ) : null}
          <View style={[styles2.metaRow, !isDesktop && { justifyContent: 'center' }]}>
            {founder?.industry ? (
              <View style={styles2.metaItem}>
                <Ionicons name="briefcase-outline" size={13} color={C.textHint} />
                <Text style={styles2.metaText}>{founder.industry}</Text>
              </View>
            ) : null}
            {founder?.location ? (
              <View style={styles2.metaItem}>
                <Ionicons name="location-outline" size={13} color={C.textHint} />
                <Text style={styles2.metaText}>{founder.location}</Text>
              </View>
            ) : null}
            {commitment ? (
              <View style={styles2.metaItem}>
                <Ionicons name="time-outline" size={13} color={C.textHint} />
                <Text style={styles2.metaText}>{commitment}</Text>
              </View>
            ) : null}
          </View>
          <View style={[styles2.badgeRow, !isDesktop && { justifyContent: 'center' }]}>
            <Pill label={status.label} C={C} bg={status.bg} color={status.text} />
            {joined ? <Text style={styles2.joined}>{joined}</Text> : null}
          </View>
          {(founder?.ventureName || founder?.team) ? (
            <View style={[styles2.ventureRow, !isDesktop && { justifyContent: 'center' }]}>
              {founder?.ventureName ? <Text style={styles2.venture}>Venture: {founder.ventureName}</Text> : null}
              {founder?.team ? (
                <TouchableOpacity onPress={onTeamPress} activeOpacity={0.75}>
                  <Text style={[styles2.venture, { color: C.primary, fontWeight: '700' }]}>Team: {founder.team.name} →</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      <View style={[styles2.stats, isDesktop && styles2.statsDesktop]}>
        <StatTile
          icon="shield-checkmark"
          iconColor={levelColor}
          iconBg={C.surfaceElevated}
          value={confidencePct != null ? `${confidencePct}%` : '—'}
          label="Profile Confidence"
          progress={confidencePct}
          C={C}
          styles2={styles2}
        />
        {isAdmin ? (
          <StatTile
            icon="layers"
            iconColor={C.primary}
            iconBg={C.surfaceElevated}
            value={evidenceCount ?? 0}
            label="Evidence Items Verified"
            C={C}
            styles2={styles2}
          />
        ) : null}
        <StatTile
          icon="checkmark-circle"
          iconColor={C.success}
          iconBg={C.surfaceElevated}
          value={activitiesCount ?? 0}
          label="Activities Completed"
          C={C}
          styles2={styles2}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarPlaceholder: { justifyContent: 'center', alignItems: 'center' },
});

function makeStyles(C) {
  return StyleSheet.create({
    card: {
      backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: C.surfaceBorder,
      padding: 20, gap: 20, ...cardShadow,
    },
    cardDesktop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 24 },

    identity: { alignItems: 'center', gap: 12 },
    // minWidth stops this from being crushed toward 0 by the stat tiles'
    // own minWidth under justify-content:space-between at in-between window
    // widths — see the numberOfLines note on the role Text above.
    identityDesktop: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 260 },

    role: { ...typography.titleMedium, color: C.textPrimary },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 6 },
    metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    metaText: { ...typography.bodySmall, color: C.textSecondary },

    badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
    joined: { ...typography.caption, color: C.textHint },

    ventureRow: { flexDirection: 'row', gap: 16, marginTop: 10, flexWrap: 'wrap' },
    venture: { ...typography.bodySmall, color: C.textSecondary },

    stats: { gap: 14, alignSelf: 'stretch' },
    statsDesktop: { flexDirection: 'row', gap: 22, alignSelf: 'auto' },

    statTile: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 150 },
    statIconCircle: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
    statValue: { ...typography.titleMedium, color: C.textPrimary, fontWeight: '800' },
    statLabel: { ...typography.caption, color: C.textSecondary },
    statTrack: { height: 4, borderRadius: 2, backgroundColor: C.surfaceElevated, marginTop: 5, overflow: 'hidden' },
    statFill: { height: 4, borderRadius: 2 },
  });
}

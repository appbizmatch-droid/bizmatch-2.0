import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Share,
} from 'react-native';
import { useState, useEffect, useMemo, useRef } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import useAppStore from '../../store/appStore';
import { colors, investorColors, radius, typography, cardShadow } from '../../theme';
import { getFounderInterview, editCompletedInterviewAnswers } from '../../services/interviews.service';
import { showAlert } from '../../services/alert';
import AppShell from '../../components/AppShell';
import { ADMIN_NAV_ITEMS } from '../../config/nav';
import { SectionCard, Avatar } from '../../components/ui';
import RecordingPlayer from '../../components/interview/RecordingPlayer';
import { formatAnswerForReview, formatDuration, groupBookmarksBySection } from '../../interview/formatAnswer';

import { compileTree, computeActivePath } from '../../interview/engine/InterviewEngine';
import { substituteQuestionPlaceholders } from '../../interview/engine/textPlaceholders';
import { questionTree } from '../../interview/data/questionTree.bizmatch';

const TREE = compileTree(questionTree);

// Read-only view of a completed interview: full section-grouped Q&A, the
// recording (if any) with a tap-to-jump bookmark outline, and a "Share"
// action that exports the same content as plain text.
export default function InterviewSummaryScreen({ route, navigation }) {
  const darkMode = useAppStore(s => s.darkMode);
  const C = darkMode ? investorColors : colors;
  const styles = makeStyles(C);

  const interviewId = route.params?.interviewId;
  const playerRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [interview, setInterview] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draftAnswers, setDraftAnswers] = useState({});
  const [savingEdits, setSavingEdits] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await getFounderInterview(interviewId);
        setInterview(data);
      } catch {
        showAlert('Error', 'Could not load this interview.');
        navigation.goBack();
      } finally {
        setLoading(false);
      }
    })();
  }, [interviewId]);

  const activePath = useMemo(
    () => (interview ? computeActivePath(TREE, interview.answers || {}) : []),
    [interview],
  );

  const reviewIds = useMemo(
    () => activePath.filter((id) => {
      const q = TREE.byId[id];
      return q && q.type !== 'info' && q.type !== 'end';
    }),
    [activePath],
  );

  const bookmarkGroups = useMemo(() => {
    if (!interview?.recordingBookmarks?.length) return [];
    const sorted = [...interview.recordingBookmarks].sort((a, b) => a.timeSeconds - b.timeSeconds);
    return groupBookmarksBySection(TREE, sorted);
  }, [interview]);

  // Editing after completion: live interviews aren't always long enough to record
  // everything, so an evaluator needs to come back and fix/fill in what they wrote —
  // this must re-score the evidence this interview produced, not just the raw text.
  const startEditing = () => {
    setDraftAnswers(interview.answers || {});
    setEditing(true);
  };

  const cancelEditing = () => setEditing(false);

  const setDraftValue = (id, value) => {
    setDraftAnswers((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), value, skipped: false, updatedAt: new Date().toISOString() },
    }));
  };

  const setDraftNote = (id, note) => {
    setDraftAnswers((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), interviewerNote: note, updatedAt: new Date().toISOString() },
    }));
  };

  const saveEdits = async () => {
    setSavingEdits(true);
    try {
      await editCompletedInterviewAnswers(interviewId, { answers: draftAnswers });
      const { data } = await getFounderInterview(interviewId);
      setInterview(data);
      setEditing(false);
    } catch {
      showAlert('Error', 'Could not save these edits.');
    } finally {
      setSavingEdits(false);
    }
  };

  const handleShare = async () => {
    if (!interview) return;
    const lines = [`Interview: ${interview.meta?.entrepreneurName || 'Unnamed founder'}`];
    if (interview.meta?.ventureName) lines.push(`Venture: ${interview.meta.ventureName}`);
    if (interview.completedAt) lines.push(`Completed: ${new Date(interview.completedAt).toLocaleDateString()}`);
    lines.push('');
    let lastSection = null;
    for (const id of reviewIds) {
      const question = TREE.byId[id];
      const section = TREE.sections.find((s) => s.id === question.section);
      if (section?.label !== lastSection) {
        lines.push(`\n${section?.label?.toUpperCase() || ''}`);
        lastSection = section?.label;
      }
      lines.push(`Q: ${substituteQuestionPlaceholders(question.text, interview.meta || {})}`);
      lines.push(`A: ${formatAnswerForReview(question, interview.answers?.[id])}`);
      const note = interview.answers?.[id]?.interviewerNote;
      if (note) lines.push(`   Note: ${note}`);
    }
    const text = lines.join('\n');
    try {
      await Share.share({ message: text });
      // Note: RN's Share.share resolves (doesn't throw) when the user simply dismisses the
      // native share sheet — a caught error here is a genuine failure, most commonly the web
      // fallback below: react-native-web's Share wraps navigator.share, which is unavailable
      // on most desktop browsers (and always over plain http://localhost).
    } catch {
      try {
        await Clipboard.setStringAsync(text);
        showAlert('Copied to clipboard', "Sharing isn't available in this browser, so the summary was copied instead.");
      } catch {
        showAlert('Error', 'Could not share or copy the summary.');
      }
    }
  };

  if (loading) {
    return (
      <AppShell navigation={navigation} active="interviews" items={ADMIN_NAV_ITEMS}>
        <View style={styles.centered}><ActivityIndicator size="large" color={C.primary} /></View>
      </AppShell>
    );
  }

  if (!interview) return null;

  return (
    <AppShell navigation={navigation} active="interviews" items={ADMIN_NAV_ITEMS}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backRow}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.headerRow}>
          <Avatar photoUrl={interview.founderPhotoUrl} name={interview.meta?.entrepreneurName} size={48} C={C} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{interview.meta?.entrepreneurName || 'Unnamed founder'}</Text>
            <Text style={styles.subtitle}>
              {interview.interviewerName ? `Interviewer: ${interview.interviewerName} · ` : ''}
              Completed {interview.completedAt ? new Date(interview.completedAt).toLocaleDateString() : '—'}
            </Text>
          </View>
          {!editing && (
            <TouchableOpacity style={styles.editBtn} onPress={startEditing} activeOpacity={0.85}>
              <Ionicons name="create-outline" size={16} color={C.primary} />
              <Text style={styles.editBtnText}>Edit Answers</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.shareBtn} onPress={handleShare} activeOpacity={0.85}>
            <Ionicons name="share-outline" size={16} color="#fff" />
            <Text style={styles.shareBtnText}>Share</Text>
          </TouchableOpacity>
        </View>

        {editing && (
          <View style={styles.editBar}>
            <Text style={styles.editBarText}>Editing answers will re-score this interview's evidence and recompute the founder's profile.</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={styles.cancelBtn} onPress={cancelEditing} disabled={savingEdits}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, savingEdits && { opacity: 0.6 }]} onPress={saveEdits} disabled={savingEdits}>
                {savingEdits ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {interview.recordingSegments?.length > 0 && (
          <SectionCard title="Recording" icon="mic-outline" C={C} style={{ marginTop: 16 }}>
            <RecordingPlayer ref={playerRef} segments={interview.recordingSegments} C={C} />
            {bookmarkGroups.length > 0 && (
              <View style={{ marginTop: 12 }}>
                {bookmarkGroups.map((group) => (
                  <View key={group.sectionId} style={{ marginTop: 8 }}>
                    <Text style={styles.bookmarkSectionLabel}>{group.sectionLabel}</Text>
                    {group.bookmarks.map((b) => {
                      const q = TREE.byId?.[b.questionId];
                      return (
                        <TouchableOpacity
                          key={b.questionId}
                          style={styles.bookmarkRow}
                          onPress={() => playerRef.current?.seekAndPlay(b.segmentIndex, b.timeSeconds)}
                          activeOpacity={0.75}
                        >
                          <Text style={styles.bookmarkTime}>{formatDuration(b.timeSeconds)}</Text>
                          <Text style={styles.bookmarkQuestion} numberOfLines={1}>{q?.text ?? b.questionId}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </View>
            )}
          </SectionCard>
        )}

        <SectionCard title="Answers" icon="document-text-outline" C={C} style={{ marginTop: 16 }}>
          {reviewIds.map((id) => {
            const question = TREE.byId[id];
            const section = TREE.sections.find((s) => s.id === question.section);
            const note = editing ? (draftAnswers[id]?.interviewerNote ?? '') : interview.answers?.[id]?.interviewerNote;
            return (
              <View key={id} style={styles.reviewRow}>
                <Text style={styles.reviewSectionLabel}>{section?.label}</Text>
                <Text style={styles.reviewQuestion}>{substituteQuestionPlaceholders(question.text, interview.meta || {})}</Text>
                {editing ? (
                  <>
                    <AnswerEditor
                      question={question}
                      value={draftAnswers[id]?.value}
                      onChange={(value) => setDraftValue(id, value)}
                      C={C}
                      styles={styles}
                    />
                    <TextInput
                      style={styles.editNoteInput}
                      multiline
                      placeholder="Evaluator note (optional)"
                      placeholderTextColor={C.textHint}
                      value={note}
                      onChangeText={(text) => setDraftNote(id, text)}
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.reviewAnswer}>{formatAnswerForReview(question, interview.answers?.[id])}</Text>
                    {note ? (
                      <View style={styles.reviewNoteRow}>
                        <Ionicons name="create-outline" size={13} color={C.textHint} />
                        <Text style={styles.reviewNoteText}>{note}</Text>
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            );
          })}
        </SectionCard>
      </ScrollView>
    </AppShell>
  );
}

// Per-type inline editor for AUDIT item 2g (edit a completed interview's
// answers) — mirrors the value shapes InterviewRunnerScreen's recordAnswer
// produces (formatAnswer.js documents them) so a saved edit round-trips
// through the exact same scoring path a live answer would.
function AnswerEditor({ question, value, onChange, C, styles }) {
  switch (question.type) {
    case 'yes_no':
      return (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[{ label: 'Yes', v: true }, { label: 'No', v: false }].map((opt) => (
            <TouchableOpacity
              key={opt.label}
              style={[styles.editChoiceBtn, value?.value === opt.v && styles.editChoiceBtnActive]}
              onPress={() => onChange({ type: 'yes_no', value: opt.v })}
            >
              <Text style={[styles.editChoiceText, value?.value === opt.v && styles.editChoiceTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      );
    case 'single_choice':
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(question.options || []).map((opt) => (
            <TouchableOpacity
              key={opt.id}
              style={[styles.editChoiceBtn, value?.optionId === opt.id && styles.editChoiceBtnActive]}
              onPress={() => onChange({ type: 'single_choice', optionId: opt.id })}
            >
              <Text style={[styles.editChoiceText, value?.optionId === opt.id && styles.editChoiceTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      );
    case 'multi_choice': {
      const selected = value?.optionIds || [];
      const toggle = (id) => {
        const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
        onChange({ type: 'multi_choice', optionIds: next });
      };
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(question.options || []).map((opt) => (
            <TouchableOpacity
              key={opt.id}
              style={[styles.editChoiceBtn, selected.includes(opt.id) && styles.editChoiceBtnActive]}
              onPress={() => toggle(opt.id)}
            >
              <Text style={[styles.editChoiceText, selected.includes(opt.id) && styles.editChoiceTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      );
    }
    case 'short_text':
    case 'long_text':
      return (
        <TextInput
          style={[styles.editTextInput, question.type === 'long_text' && { minHeight: 80 }]}
          multiline={question.type === 'long_text'}
          value={value?.text ?? ''}
          onChangeText={(text) => onChange({ type: question.type, text })}
          placeholderTextColor={C.textHint}
        />
      );
    case 'number':
      return (
        <TextInput
          style={styles.editTextInput}
          keyboardType="numeric"
          value={value?.value != null ? String(value.value) : ''}
          onChangeText={(text) => {
            const n = Number(text);
            onChange({ type: 'number', value: Number.isFinite(n) ? n : 0 });
          }}
          placeholderTextColor={C.textHint}
        />
      );
    case 'duration':
      return (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={[styles.editTextInput, { flex: 1 }]}
            keyboardType="numeric"
            value={value?.amount != null ? String(value.amount) : ''}
            onChangeText={(text) => {
              const n = Number(text);
              onChange({ type: 'duration', amount: Number.isFinite(n) ? n : 0, unit: value?.unit || 'minutes' });
            }}
            placeholderTextColor={C.textHint}
          />
          <Text style={{ color: C.textSecondary }}>{value?.unit || 'minutes'}</Text>
        </View>
      );
    default:
      return null;
  }
}

function makeStyles(C) {
  return StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
    container: { padding: 20, paddingBottom: 60, maxWidth: 680, width: '100%', alignSelf: 'center' },

    backRow: { marginBottom: 12 },
    backText: { ...typography.labelLarge, color: C.primary },

    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { ...typography.titleMedium, color: C.textPrimary },
    subtitle: { ...typography.bodySmall, color: C.textSecondary, marginTop: 2 },
    shareBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: C.primary, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, ...cardShadow,
    },
    shareBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    editBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      borderWidth: 1, borderColor: C.primary, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8,
    },
    editBtnText: { color: C.primary, fontWeight: '700', fontSize: 13 },

    editBar: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      backgroundColor: C.surfaceElevated, borderRadius: radius.md, padding: 12, marginTop: 12,
    },
    editBarText: { ...typography.bodySmall, color: C.textSecondary, flex: 1 },
    cancelBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: C.surfaceBorder },
    cancelBtnText: { color: C.textSecondary, fontWeight: '700', fontSize: 13 },
    saveBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: C.primary, minWidth: 110, alignItems: 'center' },
    saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

    editChoiceBtn: {
      borderWidth: 1, borderColor: C.surfaceBorder, borderRadius: radius.pill,
      paddingHorizontal: 12, paddingVertical: 6,
    },
    editChoiceBtnActive: { borderColor: C.primary, backgroundColor: `${C.primary}1A` },
    editChoiceText: { ...typography.bodySmall, color: C.textSecondary },
    editChoiceTextActive: { color: C.primary, fontWeight: '700' },
    editTextInput: {
      ...typography.bodyMedium, color: C.textPrimary, borderWidth: 1, borderColor: C.surfaceBorder,
      borderRadius: radius.sm, padding: 10,
    },
    editNoteInput: {
      ...typography.bodySmall, color: C.textPrimary, borderWidth: 1, borderColor: C.surfaceBorder,
      borderRadius: radius.sm, padding: 8, marginTop: 8, minHeight: 40, fontStyle: 'italic',
    },

    bookmarkSectionLabel: { ...typography.caption, color: C.textHint, textTransform: 'uppercase', marginBottom: 4 },
    bookmarkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    bookmarkTime: { ...typography.caption, color: C.primary, fontVariant: ['tabular-nums'], width: 42 },
    bookmarkQuestion: { ...typography.bodySmall, color: C.textSecondary, flex: 1 },

    reviewRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.surfaceBorder },
    reviewSectionLabel: { ...typography.caption, color: C.textHint, textTransform: 'uppercase', marginBottom: 4 },
    reviewQuestion: { ...typography.bodyMedium, color: C.textPrimary, fontWeight: '600', marginBottom: 6 },
    reviewAnswer: { ...typography.bodyMedium, color: C.textSecondary },
    reviewNoteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, backgroundColor: C.surfaceElevated, borderRadius: radius.sm, padding: 8 },
    reviewNoteText: { ...typography.bodySmall, color: C.textSecondary, flex: 1, fontStyle: 'italic' },
  });
}

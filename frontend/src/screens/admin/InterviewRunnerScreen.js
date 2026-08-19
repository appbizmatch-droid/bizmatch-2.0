import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import useAppStore from '../../store/appStore';
import { colors, investorColors, radius, typography } from '../../theme';
import {
  getFounderInterview, saveFounderInterview, completeFounderInterview,
  resetFounderInterview, uploadInterviewRecording, uploadInterviewRecordingBlob,
} from '../../services/interviews.service';
import { showAlert } from '../../services/alert';
import AppShell from '../../components/AppShell';
import { useIsDesktop } from '../../components/ui';
import { ADMIN_NAV_ITEMS } from '../../config/nav';
import RecordingPlayer from '../../components/interview/RecordingPlayer';
import { useInterviewRecording } from '../../hooks/useInterviewRecording';
import { formatDuration, groupBookmarksBySection } from '../../interview/formatAnswer';

import { compileTree, computeActivePath, getCurrentFrontierId, isQuestionDynamicallyRequired } from '../../interview/engine/InterviewEngine';
import { getPreviousQuestionId } from '../../interview/engine/NavigationManager';
import { calculateProgress } from '../../interview/engine/ProgressCalculator';
import { substituteQuestionPlaceholders } from '../../interview/engine/textPlaceholders';
import { questionTree } from '../../interview/data/questionTree.bizmatch';

const TREE = compileTree(questionTree);
const DURATION_UNITS = ['minutes', 'hours', 'days', 'months', 'years'];

// A question directed at the evaluator ("rate what they just described",
// "did they take ownership...") rather than asked directly to the founder —
// every such question in questionTree.bizmatch.ts uses an `evaluation.*`
// summaryKey. Founders answering these audio-only would be confusing
// ("who is 'they'?"), so the runner flags them for whoever's conducting
// the interview (AUDIT: confusing founder/evaluator question phrasing).
function isEvaluatorQuestion(question) {
  return !!question?.summaryKey?.startsWith('evaluation.');
}

export default function InterviewRunnerScreen({ route, navigation }) {
  const darkMode = useAppStore(s => s.darkMode);
  const C = darkMode ? investorColors : colors;
  const styles = makeStyles(C);
  const isDesktop = useIsDesktop();

  const interviewId = route.params?.interviewId;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [answers, setAnswers] = useState({});
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState('in_progress');
  const [draftText, setDraftText] = useState('');
  const [draftNumber, setDraftNumber] = useState('');
  const [draftDurationUnit, setDraftDurationUnit] = useState('minutes');
  const [draftMulti, setDraftMulti] = useState([]);
  const [draftNote, setDraftNote] = useState('');
  // The answer record last showing on this question when navigated back to
  // via Back — used to re-populate the draft inputs / highlight the prior
  // choice, so "Back" reads as "review what you answered" instead of
  // silently erasing it (the underlying record is still cleared, since the
  // frontier position is derived from which answers exist).
  const [restoredAnswer, setRestoredAnswer] = useState(null);

  // Recording state, mirrored from the server and kept in sync as the interviewer records,
  // pauses, and moves between questions. Each entry in recordingSegments is one independent
  // start/stop take ({ url, durationSeconds }) — see the recording_segments migration for why
  // they're never merged into a single file.
  const [recordingSegments, setRecordingSegments] = useState([]);
  const [recordingBookmarks, setRecordingBookmarks] = useState([]);
  const [recordingPanelOpen, setRecordingPanelOpen] = useState(false);
  const [uploadingRecording, setUploadingRecording] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Shown once when reopening an interview that already has answers, so the
  // interviewer immediately sees where they left off — dismissed on the
  // first interaction rather than lingering the whole session.
  const [showResumeBanner, setShowResumeBanner] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const saveTimer = useRef(null);
  const playerRef = useRef(null);
  const lastBookmarkedQuestionRef = useRef(null);
  const recording = useInterviewRecording();

  useEffect(() => {
    (async () => {
      try {
        const { data } = await getFounderInterview(interviewId);
        setAnswers(data.answers || {});
        setMeta(data.meta || {});
        setStatus(data.status);
        setRecordingSegments(data.recordingSegments || []);
        setRecordingBookmarks(data.recordingBookmarks || []);
        if (data.status === 'in_progress' && Object.keys(data.answers || {}).length > 0) {
          setShowResumeBanner(true);
        }
      } catch {
        showAlert('Error', 'Could not load this interview.');
        navigation.goBack();
      } finally {
        setLoading(false);
      }
    })();
  }, [interviewId]);

  // Completed interviews live on their own read-only Summary screen (with
  // playback + the full bookmark outline) rather than duplicating that view
  // here — bounce there as soon as we know the status.
  useEffect(() => {
    if (status === 'completed') {
      navigation.replace('InterviewSummary', { interviewId });
    }
  }, [status, interviewId]);

  const activePath = useMemo(() => computeActivePath(TREE, answers), [answers]);
  const currentQuestionId = getCurrentFrontierId(activePath);
  const currentQuestion = currentQuestionId ? TREE.byId[currentQuestionId] : undefined;
  const progress = useMemo(
    () => calculateProgress(TREE, activePath, answers, currentQuestionId),
    [activePath, answers, currentQuestionId],
  );

  // Section-grouped outline of every question reached so far (activePath always ends at the
  // current — possibly still-unanswered — frontier). Only these are jumpable: anything past
  // the frontier depends on answers not given yet, so the tree can't say what it even is.
  const outlineGroups = useMemo(() => {
    const groups = [];
    const bySection = new Map();
    for (const qId of activePath) {
      const q = TREE.byId[qId];
      if (!q) continue;
      let group = bySection.get(q.section);
      if (!group) {
        const label = TREE.sections.find((s) => s.id === q.section)?.label ?? q.section;
        group = { sectionId: q.section, label, questions: [] };
        bySection.set(q.section, group);
        groups.push(group);
      }
      group.questions.push(q);
    }
    return groups;
  }, [activePath]);

  // Reset (or restore) the local draft input whenever the active question
  // changes. If we just navigated Back to review an answered question,
  // restoredAnswer carries its previous value so the input isn't blank.
  useEffect(() => {
    const v = restoredAnswer?.value;
    setDraftText(v?.text ?? '');
    setDraftNumber(v?.value != null && typeof v.value === 'number' ? String(v.value) : v?.amount != null ? String(v.amount) : '');
    setDraftDurationUnit(v?.unit || 'minutes');
    setDraftMulti(v?.optionIds || []);
    // restoredAnswer only carries the prior record when jumping back to an
    // already-reached question (jumpToQuestion trims it out of `answers`
    // first) — for a freshly-arrived question, the note (if one was left
    // before this question was answered) still lives in `answers` itself.
    setDraftNote((restoredAnswer ?? answers[currentQuestionId])?.interviewerNote ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestionId]);

  // Auto-bookmark the current question the moment it changes while
  // recording is live — mirrors the reference tool's behaviour so the
  // interviewer never has to remember to tag anything manually.
  useEffect(() => {
    if (recording.isRecording) lastBookmarkedQuestionRef.current = null;
  }, [recording.isRecording]);

  useEffect(() => {
    if (!recording.isRecording || !currentQuestionId) return;
    if (lastBookmarkedQuestionRef.current === currentQuestionId) return;
    lastBookmarkedQuestionRef.current = currentQuestionId;
    setRecordingBookmarks((prev) => {
      // Only the most recent timestamp per question is kept — revisiting a question during
      // any recording replaces its old bookmark (even one from an earlier segment) rather
      // than piling up duplicates. timeSeconds is relative to THIS segment's own start (0),
      // not a running total — segmentIndex says which segment it belongs to.
      const next = [...prev.filter((b) => b.questionId !== currentQuestionId), {
        questionId: currentQuestionId,
        segmentIndex: recordingSegments.length,
        timeSeconds: recording.elapsedSeconds,
      }];
      scheduleSave({ recordingBookmarks: next });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.isRecording, currentQuestionId]);

  const scheduleSave = useCallback((patch) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await saveFounderInterview(interviewId, patch);
      } catch {
        // Silent — next successful save will catch up; nothing to lose locally.
      } finally {
        setSaving(false);
      }
    }, 600);
  }, [interviewId]);

  const dismissResumeBanner = () => setShowResumeBanner(false);

  // Answering/skipping a question that already has a note (left before it was answered, or
  // while reviewing it via Back/the outline) must not clobber that note — both functions
  // carry forward whatever's already on the record.
  const existingNote = () => answers[currentQuestionId]?.interviewerNote ?? restoredAnswer?.interviewerNote;

  const recordAnswer = (value) => {
    dismissResumeBanner();
    const note = existingNote();
    const record = { value, updatedAt: new Date().toISOString(), ...(note ? { interviewerNote: note } : {}) };
    const next = { ...answers, [currentQuestionId]: record };
    setAnswers(next);
    setRestoredAnswer(null);
    scheduleSave({ answers: next });
  };

  const skipQuestion = () => {
    dismissResumeBanner();
    const note = existingNote();
    const record = { skipped: true, updatedAt: new Date().toISOString(), ...(note ? { interviewerNote: note } : {}) };
    const next = { ...answers, [currentQuestionId]: record };
    setAnswers(next);
    setRestoredAnswer(null);
    scheduleSave({ answers: next });
  };

  // Notes save independently of answering — an evaluator can jot one down before, while
  // reviewing, or after answering a question, and it's carried forward regardless of what
  // recordAnswer/skipQuestion do to the rest of the record afterward (see existingNote above).
  const setNote = (text) => {
    setDraftNote(text);
    const prev = answers[currentQuestionId];
    const record = { ...prev, interviewerNote: text, updatedAt: prev?.updatedAt ?? new Date().toISOString() };
    const next = { ...answers, [currentQuestionId]: record };
    setAnswers(next);
    scheduleSave({ answers: next });
  };

  // Jumps back to any already-reached question (anywhere on activePath, not just the
  // immediately previous one) — used by both the single-step Back button and the outline
  // panel's tap-to-jump.
  //
  // AUDIT-9: this used to clear the target question AND everything after it on activePath
  // in one go, holding only the single question being reviewed in `restoredAnswer` (a lone
  // scalar, not keyed by question). Reviewing back through several already-answered
  // questions in one session (Q5 -> review Q3 -> review Q2 without resubmitting Q3 first)
  // silently discarded whatever was sitting in `restoredAnswer` each time it got
  // overwritten by the next jump — Q3's real interview answer was gone for good, forcing a
  // blank re-ask, which is the "answers keep getting deleted" bug report.
  //
  // Now this only pulls the single target question out of `answers` for editing — nothing
  // downstream is touched. If the interviewer resubmits the same answer, computeActivePath
  // walks forward through the tree exactly as before and finds Q4/Q5's answers still sitting
  // in `answers`, so it skips straight past them without re-asking anything. If the new
  // answer actually changes which branch comes next, the old downstream answers simply
  // become unreachable (harmless leftover data, same as an abandoned branch always was) —
  // the interview asks the new branch's questions fresh, same end result as before, but
  // without punishing a same-answer review with data loss.
  const jumpToQuestion = (targetId) => {
    if (targetId === currentQuestionId) return;
    dismissResumeBanner();
    const record = answers[targetId];
    if (!record) return;
    const trimmed = { ...answers };
    delete trimmed[targetId];
    setAnswers(trimmed);
    setRestoredAnswer(record);
    scheduleSave({ answers: trimmed });
  };

  const goBack = () => jumpToQuestion(getPreviousQuestionId(activePath, currentQuestionId));

  const handleFinish = async () => {
    setSaving(true);
    try {
      await saveFounderInterview(interviewId, { answers, recordingBookmarks });
      await completeFounderInterview(interviewId);
      showAlert('Interview complete', `${meta?.entrepreneurName || 'This interview'} has been saved.`, [
        { text: 'OK', onPress: () => navigation.replace('InterviewSummary', { interviewId }) },
      ]);
    } catch {
      showAlert('Error', 'Could not complete the interview. Your answers are saved — try finishing again.');
    } finally {
      setSaving(false);
    }
  };

  const handleRecordToggle = async () => {
    if (recording.isRecording) {
      recording.pause();
      return;
    }
    // hasSession tells us whether there's a live, merely-paused recorder to continue in
    // place. Once it's false — after any Stop, or on a fresh mount/reload — the next Start
    // always begins a brand-new independent segment; there's nothing to "resume" onto.
    if (recording.hasSession && !recording.error) {
      recording.resume();
      return;
    }
    await recording.start();
  };

  const handleStopRecording = async () => {
    const { uri, durationSeconds } = await recording.stop();
    if (!uri) return;
    setUploadingRecording(true);
    try {
      // Web's expo-audio recorder yields a blob: URL (audio/webm), not a native file
      // path — resolve it to a real Blob first, same fix as founders.service.js's
      // upload{FounderCv,FounderCvWeb} split.
      const { data } = Platform.OS === 'web'
        ? await uploadInterviewRecordingBlob(interviewId, await (await fetch(uri)).blob(), durationSeconds, `interview-${interviewId}-${Date.now()}.webm`)
        : await uploadInterviewRecording(interviewId, uri, durationSeconds, `interview-${interviewId}-${Date.now()}.m4a`);
      setRecordingSegments((prev) => [...prev, { url: data.url, durationSeconds: data.durationSeconds }]);
      setRecordingPanelOpen(true);
    } catch {
      showAlert('Error', 'Could not upload the recording. It stayed on this device — try stopping again.');
    } finally {
      setUploadingRecording(false);
    }
  };

  const goToBookmark = (segmentIndex, timeSeconds) => {
    playerRef.current?.seekAndPlay(segmentIndex, timeSeconds);
  };

  // Pauses the mic (if live) and leaves — progress is already autosaved, so this is really
  // just a clearly-labeled exit, but also flushes any still-debounced save immediately rather
  // than leaving it to fire after the screen's already gone, and stopping the mic explicitly
  // means the interviewer isn't relying on remembering to do it themselves before walking away.
  const handlePauseInterview = () => {
    if (recording.isRecording) recording.pause();
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      saveFounderInterview(interviewId, { answers, recordingBookmarks }).catch(() => {});
    }
    navigation.goBack();
  };

  const handleReset = () => {
    showAlert(
      'Reset interview',
      'This clears every answer, the recording, and its bookmarks — the interview starts over from question 1. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setResetting(true);
            try {
              await resetFounderInterview(interviewId);
              setAnswers({});
              setRestoredAnswer(null);
              setRecordingSegments([]);
              setRecordingBookmarks([]);
              setShowResumeBanner(false);
              setRecordingPanelOpen(false);
            } catch {
              showAlert('Error', 'Could not reset this interview. Try again.');
            } finally {
              setResetting(false);
            }
          },
        },
      ],
    );
  };

  if (loading || status === 'completed') {
    return (
      <AppShell navigation={navigation} active="interviews" items={ADMIN_NAV_ITEMS}>
        <View style={styles.centered}><ActivityIndicator size="large" color={C.primary} /></View>
      </AppShell>
    );
  }

  if (!currentQuestion) {
    return (
      <AppShell navigation={navigation} active="interviews" items={ADMIN_NAV_ITEMS}>
        <View style={styles.centered}><Text style={styles.emptyText}>This interview has no questions to show.</Text></View>
      </AppShell>
    );
  }

  const required = isQuestionDynamicallyRequired(currentQuestion);
  const section = TREE.sections.find(s => s.id === currentQuestion.section);

  // AUDIT-10/11: Continue used to silently act as Skip on an empty answer
  // (submitOrSkip fell through to skipQuestion whenever hasValue was
  // false) — confusing, since the button said "Continue" but behaved like
  // the separate "Skip this question" link below it. For the four
  // free-form/selection types that have a Continue button, it's now
  // disabled instead of falling back to skip; only the explicit Skip link
  // skips. Centralized here so Continue can live in the shared footer next
  // to Back instead of being duplicated inline per question type.
  const continuableTypes = ['multi_choice', 'short_text', 'long_text', 'number', 'duration'];
  const hasContinueButton = continuableTypes.includes(currentQuestion.type);
  const currentHasValue = (() => {
    switch (currentQuestion.type) {
      case 'multi_choice': return draftMulti.length > 0;
      case 'short_text':
      case 'long_text': return draftText.trim().length > 0;
      case 'number': return draftNumber.trim().length > 0 && !Number.isNaN(Number(draftNumber));
      case 'duration': return draftNumber.trim().length > 0 && !Number.isNaN(Number(draftNumber));
      default: return false;
    }
  })();
  const handleContinue = () => {
    if (!currentHasValue) return;
    switch (currentQuestion.type) {
      case 'multi_choice':
        recordAnswer({ type: 'multi_choice', optionIds: draftMulti });
        break;
      case 'short_text':
      case 'long_text':
        recordAnswer({ type: currentQuestion.type, text: draftText });
        break;
      case 'number':
        recordAnswer({ type: 'number', value: Number(draftNumber) });
        break;
      case 'duration':
        recordAnswer({ type: 'duration', amount: Number(draftNumber), unit: draftDurationUnit });
        break;
      default:
        break;
    }
  };
  const sortedBookmarks = [...recordingBookmarks].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const bookmarkGroups = groupBookmarksBySection(TREE, sortedBookmarks);

  // The question index (legend + jump-to-question list) — a collapsible
  // panel on mobile (screen space is tight), an always-open left sidebar
  // on desktop instead, per user request. Same content either way.
  const outlineContent = (
    <>
      <View style={styles.outlineLegend}>
        <View style={styles.outlineLegendItem}>
          <Ionicons name="checkmark-circle" size={13} color={C.success} />
          <Text style={styles.outlineLegendText}>Answered</Text>
        </View>
        <View style={styles.outlineLegendItem}>
          <Ionicons name="remove-circle-outline" size={13} color={C.textHint} />
          <Text style={styles.outlineLegendText}>Skipped</Text>
        </View>
        <View style={styles.outlineLegendItem}>
          <Ionicons name="radio-button-on" size={13} color={C.primary} />
          <Text style={styles.outlineLegendText}>Current</Text>
        </View>
        <View style={styles.outlineLegendItem}>
          <Ionicons name="person-circle-outline" size={13} color={C.primary} />
          <Text style={styles.outlineLegendText}>For evaluator</Text>
        </View>
      </View>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {outlineGroups.map((group) => (
          <View key={group.sectionId} style={{ marginBottom: 10 }}>
            <Text style={styles.outlineSectionLabel}>{group.label}</Text>
            {group.questions.map((q) => {
              const isCurrent = q.id === currentQuestionId;
              const isSkipped = answers[q.id]?.skipped;
              return (
                <TouchableOpacity
                  key={q.id}
                  style={[styles.outlineRow, isCurrent && styles.outlineRowActive]}
                  onPress={() => { jumpToQuestion(q.id); setOutlineOpen(false); }}
                  disabled={isCurrent}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={isCurrent ? 'radio-button-on' : isSkipped ? 'remove-circle-outline' : 'checkmark-circle'}
                    size={14}
                    color={isCurrent ? C.primary : isSkipped ? C.textHint : C.success}
                  />
                  <Text
                    style={[styles.outlineQuestionText, isCurrent && styles.outlineQuestionTextActive]}
                    numberOfLines={1}
                  >
                    {substituteQuestionPlaceholders(q.text, meta || {})}
                  </Text>
                  {isEvaluatorQuestion(q) && <Ionicons name="person-circle-outline" size={13} color={C.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </>
  );

  return (
    <AppShell navigation={navigation} active="interviews" items={ADMIN_NAV_ITEMS}>
      <View style={[styles.container, isDesktop && styles.containerDesktop]}>
        {isDesktop && (
          <View style={styles.outlineSidebar}>
            <Text style={styles.outlineSidebarTitle}>Questions</Text>
            {outlineContent}
          </View>
        )}
        <View style={isDesktop && styles.mainColumn}>
        <View style={styles.headerRow}>
          <Text style={styles.entrepreneurName}>{meta?.entrepreneurName}</Text>
          <View style={styles.headerActions}>
            {saving ? <Text style={styles.savingText}>Saving…</Text> : null}
            <TouchableOpacity onPress={handlePauseInterview}>
              <Text style={styles.pauseInterviewText}>Pause interview</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleReset} disabled={resetting}>
              <Text style={styles.resetText}>Reset</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress.percent}%` }]} />
        </View>
        {!isDesktop && (
          <>
            <TouchableOpacity style={styles.sectionLabelRow} onPress={() => setOutlineOpen((o) => !o)} activeOpacity={0.7}>
              <Text style={styles.sectionLabel}>{section?.label} · {progress.completedCount}/{progress.totalActiveCount}</Text>
              <Ionicons name={outlineOpen ? 'chevron-up' : 'list-outline'} size={14} color={C.textHint} />
            </TouchableOpacity>

            {outlineOpen && (
              <View style={styles.outlinePanel}>
                {outlineContent}
              </View>
            )}
          </>
        )}
        {isDesktop && (
          <View style={styles.sectionLabelRow}>
            <Text style={styles.sectionLabel}>{section?.label} · {progress.completedCount}/{progress.totalActiveCount}</Text>
          </View>
        )}

        {showResumeBanner && (
          <View style={styles.resumeBanner}>
            <Text style={styles.resumeBannerText}>
              Resuming at question {progress.completedCount + 1} of {progress.totalActiveCount}
            </Text>
            <TouchableOpacity onPress={dismissResumeBanner}>
              <Ionicons name="close" size={16} color={C.textHint} />
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.recordingCard}>
          <TouchableOpacity
            style={styles.recordingHeader}
            onPress={() => setRecordingPanelOpen((o) => !o)}
            activeOpacity={0.8}
          >
            <View style={styles.recordingHeaderLeft}>
              {recording.isRecording && <View style={styles.recDot} />}
              <Text style={styles.recordingHeaderText}>Interview recording</Text>
              {recording.isRecording && <Text style={styles.recordingTime}>{formatDuration(recording.elapsedSeconds)}</Text>}
            </View>
            <Ionicons name={recordingPanelOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.textHint} />
          </TouchableOpacity>

          {recordingPanelOpen && (
            <View style={styles.recordingBody}>
              {recording.error ? (
                <View style={styles.recordingError}>
                  <Text style={styles.recordingErrorText}>{recording.error}</Text>
                  <TouchableOpacity onPress={recording.clearError}><Ionicons name="close" size={14} color={C.error} /></TouchableOpacity>
                </View>
              ) : null}

              <View style={styles.recordingBtnRow}>
                {!recording.isRecording ? (
                  <TouchableOpacity style={styles.recordBtn} onPress={handleRecordToggle} activeOpacity={0.85} disabled={uploadingRecording}>
                    <Ionicons name="mic" size={16} color="#fff" />
                    <Text style={styles.recordBtnText}>
                      {recording.hasSession
                        ? 'Resume recording'
                        : recordingSegments.length > 0 ? 'Record another segment' : 'Start recording'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <TouchableOpacity style={styles.pauseBtn} onPress={handleRecordToggle} activeOpacity={0.85}>
                      <Ionicons name="pause" size={16} color={C.textPrimary} />
                      <Text style={styles.pauseBtnText}>Pause</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.stopBtn} onPress={handleStopRecording} activeOpacity={0.85} disabled={uploadingRecording}>
                      {uploadingRecording ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="stop" size={16} color="#fff" />}
                      <Text style={styles.recordBtnText}>Stop</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>

              {recordingSegments.length > 0 && !recording.isRecording && (
                <RecordingPlayer ref={playerRef} segments={recordingSegments} C={C} />
              )}

              {sortedBookmarks.length > 0 && (
                <View style={styles.bookmarkList}>
                  <Text style={styles.bookmarkListLabel}>Bookmarks — tap to jump the recording to that question:</Text>
                  {bookmarkGroups.map((group) => (
                    <View key={group.sectionId} style={{ marginTop: 8 }}>
                      <Text style={styles.bookmarkSectionLabel}>{group.sectionLabel}</Text>
                      {group.bookmarks.map((b) => {
                        const q = TREE.byId?.[b.questionId];
                        const isCurrent = b.questionId === currentQuestionId;
                        return (
                          <TouchableOpacity
                            key={b.questionId}
                            style={[styles.bookmarkRow, isCurrent && styles.bookmarkRowActive]}
                            onPress={() => goToBookmark(b.segmentIndex, b.timeSeconds)}
                            disabled={recordingSegments.length === 0}
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
            </View>
          )}
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {isEvaluatorQuestion(currentQuestion) && (
            <View style={styles.audienceBadge}>
              <Ionicons name="person-circle-outline" size={13} color={C.primary} />
              <Text style={styles.audienceBadgeText}>This is a question for the evaluator</Text>
            </View>
          )}
          <Text style={styles.questionText}>{substituteQuestionPlaceholders(currentQuestion.text, meta || {})}</Text>
          {currentQuestion.helpText ? <Text style={styles.helpText}>{currentQuestion.helpText}</Text> : null}

          {currentQuestion.type !== 'info' && currentQuestion.type !== 'end' && (
            <View style={styles.noteBlock}>
              <Text style={styles.noteLabel}>Evaluator note (optional, not shown to the founder)</Text>
              <TextInput
                style={styles.noteInput}
                multiline
                placeholder="Add a note about this answer…"
                placeholderTextColor={C.textHint}
                value={draftNote}
                onChangeText={setNote}
              />
            </View>
          )}

          {currentQuestion.type === 'info' && (
            <TouchableOpacity style={styles.primaryBtn} onPress={() => recordAnswer({ type: 'info', acknowledged: true })} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>Continue</Text>
            </TouchableOpacity>
          )}

          {currentQuestion.type === 'end' && (
            <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.6 }]} onPress={handleFinish} disabled={saving} activeOpacity={0.85}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Complete Interview</Text>}
            </TouchableOpacity>
          )}

          {currentQuestion.type === 'yes_no' && (
            <View style={styles.rowGap}>
              <TouchableOpacity
                style={[styles.choiceBtn, restoredAnswer?.value?.type === 'yes_no' && restoredAnswer.value.value === true && { borderColor: C.primary }]}
                onPress={() => recordAnswer({ type: 'yes_no', value: true })} activeOpacity={0.85}
              >
                <Text style={styles.choiceBtnText}>Yes</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.choiceBtn, restoredAnswer?.value?.type === 'yes_no' && restoredAnswer.value.value === false && { borderColor: C.primary }]}
                onPress={() => recordAnswer({ type: 'yes_no', value: false })} activeOpacity={0.85}
              >
                <Text style={styles.choiceBtnText}>No</Text>
              </TouchableOpacity>
            </View>
          )}

          {currentQuestion.type === 'single_choice' && (
            <View style={styles.chipRow}>
              {(currentQuestion.options || []).map((opt) => (
                <TouchableOpacity
                  key={opt.id}
                  style={[styles.choiceBtnFull, restoredAnswer?.value?.type === 'single_choice' && restoredAnswer.value.optionId === opt.id && { borderColor: C.primary }]}
                  onPress={() => recordAnswer({ type: 'single_choice', optionId: opt.id })} activeOpacity={0.85}
                >
                  <Text style={styles.choiceBtnText}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {currentQuestion.type === 'multi_choice' && (
            <View style={styles.chipRow}>
              {(currentQuestion.options || []).map((opt) => {
                const on = draftMulti.includes(opt.id);
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[styles.chip, on && { backgroundColor: C.primary, borderColor: C.primary }]}
                    onPress={() => setDraftMulti(on ? draftMulti.filter(o => o !== opt.id) : [...draftMulti, opt.id])}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.chipText, on && { color: '#fff' }]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {(currentQuestion.type === 'short_text' || currentQuestion.type === 'long_text') && (
            <TextInput
              style={[styles.input, currentQuestion.type === 'long_text' && styles.inputMultiline]}
              multiline={currentQuestion.type === 'long_text'}
              placeholder="Type the answer…"
              placeholderTextColor={C.textHint}
              value={draftText}
              onChangeText={setDraftText}
            />
          )}

          {currentQuestion.type === 'number' && (
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={C.textHint}
              value={draftNumber}
              onChangeText={setDraftNumber}
            />
          )}

          {currentQuestion.type === 'duration' && (
            <View>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                placeholder="Amount"
                placeholderTextColor={C.textHint}
                value={draftNumber}
                onChangeText={setDraftNumber}
              />
              <View style={[styles.chipRow, { marginTop: 10 }]}>
                {DURATION_UNITS.map((u) => (
                  <TouchableOpacity
                    key={u}
                    style={[styles.chip, draftDurationUnit === u && { backgroundColor: C.primary, borderColor: C.primary }]}
                    onPress={() => setDraftDurationUnit(u)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.chipText, draftDurationUnit === u && { color: '#fff' }]}>{u}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {!required && currentQuestion.type !== 'info' && currentQuestion.type !== 'end' && (
            <TouchableOpacity onPress={skipQuestion} style={{ marginTop: 14 }}>
              <Text style={styles.skipText}>Skip this question</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.backBtn, !getPreviousQuestionId(activePath, currentQuestionId) && { opacity: 0.4 }]}
            onPress={goBack}
            disabled={!getPreviousQuestionId(activePath, currentQuestionId)}
            activeOpacity={0.85}
          >
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          {hasContinueButton && (
            <TouchableOpacity
              style={[styles.primaryBtn, styles.continueBtn, !currentHasValue && { opacity: 0.5 }]}
              onPress={handleContinue}
              disabled={!currentHasValue}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Continue</Text>
            </TouchableOpacity>
          )}
        </View>
        </View>
      </View>
    </AppShell>
  );
}

function makeStyles(C) {
  return StyleSheet.create({
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
    emptyText: { ...typography.bodyMedium, color: C.textHint },

    container: { flex: 1, maxWidth: 680, width: '100%', alignSelf: 'center', paddingHorizontal: 20, paddingTop: 16 },
    containerDesktop: {
      flexDirection: 'row', alignItems: 'flex-start', maxWidth: 960, gap: 24,
    },
    mainColumn: { flex: 1, minWidth: 0 },
    outlineSidebar: {
      width: 260, flexShrink: 0, backgroundColor: C.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: C.surfaceBorder, padding: 14, marginTop: 4,
      maxHeight: 720, ...(Platform.OS === 'web' ? { position: 'sticky', top: 16 } : null),
    },
    outlineSidebarTitle: { ...typography.labelLarge, color: C.textPrimary, fontWeight: '700', marginBottom: 10 },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', rowGap: 8 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
    entrepreneurName: { ...typography.titleMedium, color: C.textPrimary },
    savingText: { ...typography.caption, color: C.textHint },
    pauseInterviewText: { ...typography.labelLarge, color: C.primary, fontWeight: '700' },
    resetText: { ...typography.labelLarge, color: C.error, fontWeight: '700' },

    progressTrack: { height: 5, borderRadius: 3, backgroundColor: C.surfaceBorder, marginTop: 10, overflow: 'hidden' },
    progressFill: { height: 5, borderRadius: 3, backgroundColor: C.primary },
    sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, alignSelf: 'flex-start' },
    sectionLabel: { ...typography.caption, color: C.textHint },

    outlinePanel: {
      backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: C.surfaceBorder,
      marginTop: 10, padding: 12, maxHeight: 300, overflow: 'hidden',
    },
    outlineLegend: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingBottom: 10, marginBottom: 8,
      borderBottomWidth: 1, borderBottomColor: C.surfaceBorder,
    },
    outlineLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    outlineLegendText: { ...typography.caption, color: C.textHint },
    outlineSectionLabel: { ...typography.caption, color: C.textHint, textTransform: 'uppercase', marginBottom: 4 },
    outlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, paddingHorizontal: 4, borderRadius: radius.sm },
    outlineRowActive: { backgroundColor: C.surfaceElevated },
    outlineQuestionText: { ...typography.bodySmall, color: C.textSecondary, flex: 1 },
    outlineQuestionTextActive: { color: C.primary, fontWeight: '700' },

    resumeBanner: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: C.surfaceElevated, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 14, marginTop: 12,
    },
    resumeBannerText: { ...typography.bodySmall, color: C.textPrimary, fontWeight: '600', flex: 1, marginRight: 8 },

    recordingCard: {
      backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: C.surfaceBorder, marginTop: 12, overflow: 'hidden',
    },
    recordingHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12 },
    recordingHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    recordingHeaderText: { ...typography.bodyMedium, fontWeight: '700', color: C.textPrimary },
    recordingTime: { ...typography.caption, color: C.error, fontVariant: ['tabular-nums'] },
    recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.error },

    recordingBody: { paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
    recordingError: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: C.errorLight, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8,
    },
    recordingErrorText: { ...typography.bodySmall, color: C.error, flex: 1, marginRight: 8 },

    recordingBtnRow: { flexDirection: 'row', gap: 10 },
    recordBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.primary,
      borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 10,
    },
    pauseBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.surfaceElevated,
      borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: C.surfaceBorder,
    },
    stopBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.error,
      borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 10,
    },
    recordBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    pauseBtnText: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },

    bookmarkList: { marginTop: 4 },
    bookmarkListLabel: { ...typography.caption, color: C.textHint },
    bookmarkSectionLabel: { ...typography.caption, color: C.textHint, textTransform: 'uppercase', marginBottom: 4 },
    bookmarkRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.sm,
    },
    bookmarkRowActive: { backgroundColor: C.surfaceElevated },
    bookmarkTime: { ...typography.caption, color: C.primary, fontVariant: ['tabular-nums'], width: 42 },
    bookmarkQuestion: { ...typography.bodySmall, color: C.textSecondary, flex: 1 },

    scrollContent: { paddingVertical: 24, paddingBottom: 60 },
    audienceBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
      backgroundColor: `${C.primary}1A`,
      borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 10,
    },
    audienceBadgeText: { ...typography.caption, color: C.primary, fontWeight: '700' },
    questionText: {
      ...typography.displayMedium, fontSize: 22, color: C.textPrimary, marginBottom: 8,
    },
    helpText: {
      ...typography.bodySmall, color: C.textSecondary, marginBottom: 16,
    },

    noteBlock: { marginBottom: 18 },
    noteLabel: { ...typography.caption, color: C.textHint, marginBottom: 6 },
    noteInput: {
      backgroundColor: C.backgroundSoft, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10,
      fontSize: 13, color: C.textPrimary, borderWidth: 1, borderColor: C.surfaceBorder, minHeight: 44, textAlignVertical: 'top',
    },

    rowGap: { flexDirection: 'row', gap: 12, marginTop: 8 },
    choiceBtn: { flex: 1, backgroundColor: C.surface, borderWidth: 1.5, borderColor: C.surfaceBorder, borderRadius: radius.md, paddingVertical: 16, alignItems: 'center' },
    choiceBtnFull: { backgroundColor: C.surface, borderWidth: 1.5, borderColor: C.surfaceBorder, borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 8 },
    choiceBtnText: { ...typography.bodyMedium, fontWeight: '700', color: C.textPrimary },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    chip: { borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: C.surface, borderWidth: 1.5, borderColor: C.surfaceBorder },
    chipText: { fontSize: 13, fontWeight: '600', color: C.textSecondary },

    input: {
      backgroundColor: C.backgroundSoft, borderRadius: radius.md, paddingHorizontal: 16, paddingVertical: 14,
      fontSize: 15, color: C.textPrimary, borderWidth: 1, borderColor: C.surfaceBorder, marginTop: 8,
    },
    inputMultiline: { height: 120, textAlignVertical: 'top' },

    primaryBtn: { backgroundColor: C.primary, borderRadius: radius.pill, paddingVertical: 16, alignItems: 'center', marginTop: 16 },
    primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

    skipText: { ...typography.labelLarge, color: C.textHint },

    // AUDIT-10/11: Back used to sit alone in the footer, far from wherever
    // that question type's own inline Continue button happened to be —
    // now they're a single row, Back at 30% / Continue at 70% (flex ratio
    // below), so the two primary actions are always in the same place.
    footer: { flexDirection: 'row', gap: 12, paddingVertical: 16, borderTopWidth: 1, borderTopColor: C.surfaceBorder },
    backBtn: {
      flex: 3, borderRadius: radius.pill, paddingVertical: 16, alignItems: 'center',
      borderWidth: 1.5, borderColor: C.surfaceBorder,
    },
    backBtnText: { ...typography.labelLarge, color: C.primary, fontWeight: '700' },
    continueBtn: { flex: 7, marginTop: 0 },
  });
}

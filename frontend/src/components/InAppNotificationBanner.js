import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { navigationRef } from '../navigation/navigationRef';
import useAppStore from '../store/appStore';

const TYPE_ICON = {
  evidence_added:        '📊',
  assessment_requested:  '📝',
  match_ready:           '🤝',
  deal_breaker_flagged:  '⚠️',
  team_joined:           '👥',
  activity_added:        '📅',
};

const DISMISS_AFTER_MS = 4500;

export default function InAppNotificationBanner() {
  const insets       = useSafeAreaInsets();
  const pendingBanner  = useAppStore(s => s.pendingBanner);
  const dismissBanner  = useAppStore(s => s.dismissBanner);

  const translateY  = useRef(new Animated.Value(-160)).current;
  const opacity     = useRef(new Animated.Value(0)).current;
  const timerRef    = useRef(null);
  const currentRef  = useRef(null);

  useEffect(() => {
    if (!pendingBanner) {
      slide('out');
      return;
    }
    currentRef.current = pendingBanner;
    slide('in');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(dismissBanner, DISMISS_AFTER_MS);
    return () => clearTimeout(timerRef.current);
  }, [pendingBanner]);

  function slide(dir) {
    if (dir === 'in') {
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: false, friction: 10, tension: 70 }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: false }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -160, duration: 260, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: false }),
      ]).start();
    }
  }

  const handlePress = () => {
    clearTimeout(timerRef.current);
    const banner = currentRef.current;
    dismissBanner();
    if (!navigationRef.isReady()) return;
    if (banner?.data?.founderId) {
      navigationRef.navigate('FounderProfile', { founderId: banner.data.founderId });
      return;
    }
    if ((banner?.data?.type === 'assessment_requested' || banner?.data?.type === 'activity_added') && banner?.data?.activityId) {
      navigationRef.navigate('ActivityDetail', { activityId: banner.data.activityId });
      return;
    }
    if (banner?.data?.type === 'team_joined' && banner?.data?.teamId) {
      navigationRef.navigate('TeamProfile', { teamId: banner.data.teamId });
    }
  };

  const handleDismiss = () => {
    clearTimeout(timerRef.current);
    dismissBanner();
  };

  const banner = pendingBanner || currentRef.current;
  const icon   = TYPE_ICON[banner?.data?.type] || '🔔';

  return (
    <Animated.View
      pointerEvents={pendingBanner ? 'box-none' : 'none'}
      style={[
        styles.wrapper,
        { top: insets.top + 8, opacity, transform: [{ translateY }] },
      ]}
    >
      <TouchableOpacity style={styles.card} onPress={handlePress} activeOpacity={0.92}>
        <View style={styles.appRow}>
          <View style={styles.appDot} />
          <Text style={styles.appName}>BizMatch</Text>
          <TouchableOpacity onPress={handleDismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.body}>
          <Text style={styles.icon}>{icon}</Text>
          <View style={styles.textBlock}>
            {!!banner?.title && (
              <Text style={styles.title} numberOfLines={1}>{banner.title}</Text>
            )}
            {!!banner?.body && (
              <Text style={styles.bodyText} numberOfLines={2}>{banner.body}</Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 9999,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 12,
  },
  appRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 6,
  },
  appDot: {
    width: 14,
    height: 14,
    borderRadius: 4,
    backgroundColor: '#022466',
  },
  appName: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: '#8A96AE',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  close: {
    fontSize: 13,
    color: '#8A96AE',
    fontWeight: '600',
  },
  body: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    fontSize: 28,
  },
  textBlock: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
    color: '#022466',
    marginBottom: 2,
  },
  bodyText: {
    fontSize: 13,
    color: '#4A5A7A',
    lineHeight: 18,
  },
});

import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { navigationRef } from './src/navigation/navigationRef';
import * as Device from 'expo-device';
import {
  setNotificationHandler,
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  requestPermissionsAsync,
  getExpoPushTokenAsync,
} from './src/utils/pushNotifications';
import AppNavigator, { linking } from './src/navigation/AppNavigator';
import useAuthStore from './src/store/authStore';
import useAppStore from './src/store/appStore';
import api from './src/services/api';

// Show push alerts even while the app is foregrounded (no-op on web)
setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPushNotifications() {
  if (!Device.isDevice) return;
  const { status } = await requestPermissionsAsync();
  if (status !== 'granted') return;
  const { data: token } = await getExpoPushTokenAsync();
  if (!token) return;
  try {
    await api.patch('/users/me/push-token', { pushToken: token });
  } catch { /* silent */ }
}

export default function App() {
  const token = useAuthStore(s => s.token);
  const isRestoring = useAuthStore(s => s.isRestoring);
  const restoreAuth = useAuthStore(s => s.restoreAuth);

  const initDarkMode = useAppStore(s => s.initDarkMode);

  useEffect(() => {
    restoreAuth();
    initDarkMode();
  }, []);

  useEffect(() => {
    if (token) registerForPushNotifications();
  }, [token]);

  useEffect(() => {
    const bumpTick = useAppStore.getState().bumpNotificationTick;

    // Notification arrives while app is open → show in-app banner + refresh bell (no-op on web)
    const receivedSub = addNotificationReceivedListener((notification) => {
      const { title, body, data } = notification.request.content;
      useAppStore.getState().showBanner({ title, body, data: data || {} });
      bumpTick();
    });

    // User taps a system notification → navigate to the relevant screen
    // (no-op on web)
    const responseSub = addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data || {};
      if (!navigationRef.isReady()) return;
      if (data.founderId) {
        navigationRef.navigate('FounderProfile', { founderId: data.founderId });
      } else if ((data.type === 'assessment_requested' || data.type === 'activity_added') && data.activityId) {
        navigationRef.navigate('ActivityDetail', { activityId: data.activityId });
      } else if (data.type === 'team_joined' && data.teamId) {
        navigationRef.navigate('TeamProfile', { teamId: data.teamId });
      }
    });

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, []);

  if (isRestoring) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F8F9FC' }}>
          <ActivityIndicator size="large" color="#022466" />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef} linking={linking}>
        <AppNavigator />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

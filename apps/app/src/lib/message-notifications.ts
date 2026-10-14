// React Native wiring for the host phone's new-message notifications (see message-notifier.ts).
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';

import { clearMessageNotifications, showMessageNotification } from '../../modules/loam-hotspot';
import { ALERT_LEVEL_ITEM, createMessageNotifier } from './message-notifier';

export { alertLevelForClientMessage, conversationPath } from './message-notifier';

export const messageNotifier = createMessageNotifier({
  isAppActive: () => AppState.currentState === 'active',
  show: showMessageNotification,
  clear: clearMessageNotifications,
  readLevel: () => SecureStore.getItemAsync(ALERT_LEVEL_ITEM),
  writeLevel: (level) => SecureStore.setItemAsync(ALERT_LEVEL_ITEM, level),
});

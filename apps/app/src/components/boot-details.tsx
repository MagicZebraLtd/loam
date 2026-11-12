import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/i18n';

/**
 * The launcher's or server's own words about a boot error, behind a Details disclosure (F-054). They are
 * English and technical, for the log and for whoever helps the host; the screen above them says the same
 * thing in the host's language. Left to right whatever the app language, since the text is English.
 */
export function BootDetails({ text }: { text: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (!text) {
    return null;
  }
  return (
    <>
      <Pressable
        onPress={() => setOpen((current) => !current)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={Spacing.two}>
        <ThemedText type="link">{open ? t('boot.hideDetails') : t('boot.details')}</ThemedText>
      </Pressable>
      {open ? (
        <ThemedText type="small" themeColor="textSecondary" selectable style={styles.detail}>
          {text}
        </ThemedText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  detail: { textAlign: 'left', writingDirection: 'ltr' },
});

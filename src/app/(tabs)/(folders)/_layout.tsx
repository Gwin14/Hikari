import { Stack } from 'expo-router';

import { largeHeader } from '@/ui/headers';
import { useTheme } from '@/ui/theme';

// A folder opened by link still has the folder list underneath it.
export const unstable_settings = { initialRouteName: 'folders' };

export default function FoldersStack() {
  const c = useTheme();
  return <Stack screenOptions={largeHeader(c)} />;
}

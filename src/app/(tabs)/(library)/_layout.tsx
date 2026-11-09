import { Stack } from 'expo-router';

import { largeHeader } from '@/ui/headers';
import { useTheme } from '@/ui/theme';

export default function LibraryStack() {
  const c = useTheme();
  return <Stack screenOptions={largeHeader(c)} />;
}

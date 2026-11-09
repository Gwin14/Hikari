import { SymbolView, unstable_getMaterialSymbolSourceAsync, type AndroidSymbol, type SymbolWeight } from 'expo-symbols';
import { useEffect, useState } from 'react';
import type { ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

/**
 * The app's single icon family: SF Symbols on iOS, Material Symbols on Android.
 * Screens name icons by meaning; this table picks the glyph per platform.
 */
const ICONS = {
  // navigation & chrome
  library: { sf: 'photo.on.rectangle', md: 'photo_library' },
  libraryFill: { sf: 'photo.fill.on.rectangle.fill', md: 'photo_library' },
  folders: { sf: 'folder', md: 'folder' },
  foldersFill: { sf: 'folder.fill', md: 'folder' },
  settings: { sf: 'gearshape', md: 'settings' },
  settingsFill: { sf: 'gearshape.fill', md: 'settings' },
  albums: { sf: 'rectangle.stack', md: 'photo_album' },
  close: { sf: 'xmark', md: 'close' },
  back: { sf: 'chevron.left', md: 'arrow_back' },
  chevron: { sf: 'chevron.right', md: 'chevron_right' },
  chevronDown: { sf: 'chevron.down', md: 'expand_more' },
  more: { sf: 'ellipsis', md: 'more_horiz' },
  filter: { sf: 'line.3.horizontal.decrease', md: 'filter_list' },
  sort: { sf: 'arrow.up.arrow.down', md: 'sort' },
  check: { sf: 'checkmark', md: 'check' },
  checkCircle: { sf: 'checkmark.circle.fill', md: 'check_circle' },
  circle: { sf: 'circle', md: 'radio_button_unchecked' },
  add: { sf: 'plus', md: 'add' },
  addCircle: { sf: 'plus.circle', md: 'add_circle' },
  removeCircle: { sf: 'minus.circle', md: 'remove_circle' },
  share: { sf: 'square.and.arrow.up', md: 'ios_share' },
  download: { sf: 'square.and.arrow.down', md: 'download' },
  trash: { sf: 'trash', md: 'delete' },
  copy: { sf: 'doc.on.doc', md: 'content_copy' },
  paste: { sf: 'doc.on.clipboard', md: 'content_paste' },
  info: { sf: 'info.circle', md: 'info' },
  lock: { sf: 'lock', md: 'lock' },
  folderOpen: { sf: 'folder.badge.plus', md: 'folder_open' },
  photo: { sf: 'photo', md: 'image' },
  photos: { sf: 'photo.on.rectangle.angled', md: 'collections' },
  camera: { sf: 'camera', md: 'photo_camera' },
  bookmark: { sf: 'bookmark', md: 'bookmark' },
  selectAll: { sf: 'checkmark.circle.badge.plus', md: 'select_all' },
  star: { sf: 'star.fill', md: 'star' },
  flag: { sf: 'flag.fill', md: 'flag' },
  reject: { sf: 'xmark.circle', md: 'block' },
  edited: { sf: 'slider.horizontal.3', md: 'tune' },
  language: { sf: 'globe', md: 'language' },
  appearance: { sf: 'circle.lefthalf.filled', md: 'contrast' },
  haptics: { sf: 'iphone.radiowaves.left.and.right', md: 'vibration' },
  cache: { sf: 'externaldrive.badge.xmark', md: 'cleaning_services' },
  person: { sf: 'person', md: 'person' },
  copyright: { sf: 'c.circle', md: 'copyright' },
  quality: { sf: 'speedometer', md: 'speed' },
  sidecar: { sf: 'doc.badge.gearshape', md: 'description' },
  raw: { sf: 'camera.aperture', md: 'camera' },
  // editor
  undo: { sf: 'arrow.uturn.backward', md: 'undo' },
  redo: { sf: 'arrow.uturn.forward', md: 'redo' },
  compare: { sf: 'rectangle.split.2x1', md: 'vertical_split' },
  histogram: { sf: 'chart.bar', md: 'bar_chart' },
  reset: { sf: 'arrow.counterclockwise', md: 'restart_alt' },
  eye: { sf: 'eye', md: 'visibility' },
  eyeOff: { sf: 'eye.slash', md: 'visibility_off' },
  invert: { sf: 'arrow.left.arrow.right', md: 'swap_horiz' },
  overlay: { sf: 'square.2.layers.3d.top.filled', md: 'layers' },
  rotate: { sf: 'rotate.left', md: 'rotate_left' },
  flipH: { sf: 'arrow.left.and.right.righttriangle.left.righttriangle.right', md: 'swap_horiz' },
  flipV: { sf: 'arrow.up.and.down.righttriangle.up.righttriangle.down', md: 'swap_vert' },
  straighten: { sf: 'level', md: 'straighten' },
  toolPresets: { sf: 'square.stack.3d.up', md: 'stacks' },
  toolVersions: { sf: 'square.on.square', md: 'account_tree' },
  toolAuto: { sf: 'wand.and.stars', md: 'auto_awesome' },
  toolLight: { sf: 'sun.max', md: 'wb_sunny' },
  toolColor: { sf: 'thermometer.medium', md: 'thermostat' },
  toolCurves: { sf: 'point.topleft.down.to.point.bottomright.curvepath', md: 'show_chart' },
  toolHsl: { sf: 'paintpalette', md: 'palette' },
  toolGrading: { sf: 'circle.circle', md: 'tonality' },
  toolMasks: { sf: 'circle.dashed.inset.filled', md: 'layers' },
  toolRetouch: { sf: 'bandage', md: 'healing' },
  toolDetail: { sf: 'triangle.lefthalf.filled', md: 'deblur' },
  toolGeometry: { sf: 'crop.rotate', md: 'crop' },
  toolOptics: { sf: 'camera.aperture', md: 'lens' },
  toolEffects: { sf: 'camera.filters', md: 'filter_vintage' },
  toolLut: { sf: 'cube', md: 'view_in_ar' },
  toolRaw: { sf: 'cpu', md: 'memory' },
  maskSubject: { sf: 'person.crop.circle', md: 'person' },
  maskSky: { sf: 'cloud', md: 'cloud' },
  maskBackground: { sf: 'mountain.2', md: 'landscape' },
  maskPeople: { sf: 'person.2', md: 'group' },
  maskObject: { sf: 'viewfinder', md: 'center_focus_strong' },
  maskBrush: { sf: 'paintbrush.pointed', md: 'brush' },
  maskLinear: { sf: 'square.bottomhalf.filled', md: 'gradient' },
  maskRadial: { sf: 'circle.dotted', md: 'radio_button_checked' },
  maskLuminance: { sf: 'circle.lefthalf.filled', md: 'contrast' },
  maskColor: { sf: 'eyedropper', md: 'colorize' },
  erase: { sf: 'eraser', md: 'ink_eraser' },
  layers: { sf: 'square.3.layers.3d', md: 'layers' },
} as const satisfies Record<string, { sf: SFSymbol; md: AndroidSymbol }>;

export type IconName = keyof typeof ICONS;

export function Icon(props: {
  name: IconName;
  size?: number;
  color: string;
  weight?: SymbolWeight;
  style?: StyleProp<ViewStyle>;
}) {
  const glyph = ICONS[props.name];
  const size = props.size ?? 22;
  return (
    <SymbolView
      name={{ ios: glyph.sf, android: glyph.md, web: glyph.md }}
      size={size}
      tintColor={props.color}
      weight={props.weight ?? 'regular'}
      resizeMode="scaleAspectFit"
      style={[{ width: size, height: size }, props.style]}
    />
  );
}

/** SF Symbol name for native APIs (tab bar, header toolbar, menus) on iOS. */
export const sf = (name: IconName): SFSymbol => ICONS[name].sf;
/** Material Symbol name for native APIs on Android. */
export const md = (name: IconName): AndroidSymbol => ICONS[name].md;

/**
 * Icon for native header toolbar items: an SF Symbol name on iOS, a rendered Material Symbol
 * image on Android (its toolbars only take image sources).
 */
export function useToolbarIcon(name: IconName, color: string): SFSymbol | ImageSourcePropType | undefined {
  const [source, setSource] = useState<ImageSourcePropType | null>(null);
  useEffect(() => {
    if (process.env.EXPO_OS !== 'android') return;
    let alive = true;
    unstable_getMaterialSymbolSourceAsync(ICONS[name].md, 24, color)
      .then((s) => alive && setSource(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [name, color]);
  if (process.env.EXPO_OS === 'ios') return ICONS[name].sf;
  return source ?? undefined;
}

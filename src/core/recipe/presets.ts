import { defaultSettings } from './defaults';
import type { RecipeSection, RecipeSettings } from './schema';

export interface Preset {
  id: string;
  name: string;
  group: string;
  builtIn: boolean;
  /** Only these sections are applied. */
  settings: Partial<RecipeSettings>;
}

type Look = (s: RecipeSettings) => void;

function make(id: string, name: string, group: string, sections: RecipeSection[], look: Look): Preset {
  const s = defaultSettings();
  look(s);
  const settings: Partial<RecipeSettings> = {};
  for (const k of sections) (settings as Record<string, unknown>)[k] = s[k];
  return { id, name, group, builtIn: true, settings };
}

const LOOK: RecipeSection[] = ['profile', 'light', 'color', 'curves', 'hsl', 'grading', 'effects', 'detail'];

/** Built-in looks. Names are proper nouns shared across languages. */
export const BUILT_IN_PRESETS: Preset[] = [
  make('hk-clean', 'Clean', 'Essentials', LOOK, (s) => {
    s.light.contrast = 10;
    s.light.highlights = -25;
    s.light.shadows = 20;
    s.color.vibrance = 12;
    s.detail.clarity = 8;
  }),
  make('hk-punch', 'Punch', 'Essentials', LOOK, (s) => {
    s.profile = 'vivid';
    s.light.contrast = 20;
    s.light.blacks = -10;
    s.detail.clarity = 15;
    s.color.vibrance = 20;
  }),
  make('hk-soft', 'Soft', 'Essentials', LOOK, (s) => {
    s.light.contrast = -15;
    s.light.highlights = -30;
    s.light.shadows = 25;
    s.detail.clarity = -12;
    s.curves.rgb = [{ x: 0, y: 0.05 }, { x: 0.5, y: 0.52 }, { x: 1, y: 0.96 }];
  }),
  make('hk-portra', 'Portrait Film', 'Film', LOOK, (s) => {
    s.light.contrast = -8;
    s.light.highlights = -20;
    s.color.temperature = 8;
    s.color.saturation = -10;
    s.curves.rgb = [{ x: 0, y: 0.06 }, { x: 0.25, y: 0.24 }, { x: 0.75, y: 0.78 }, { x: 1, y: 0.95 }];
    s.hsl.orange.sat = -10;
    s.hsl.orange.lum = 10;
    s.hsl.green.hue = -20;
    s.hsl.blue.sat = -20;
    s.grading.shadows = { hue: 200, sat: 12, lum: 0 };
    s.grading.highlights = { hue: 40, sat: 10, lum: 0 };
    s.effects.grainAmount = 18;
  }),
  make('hk-velvia', 'Slide Film', 'Film', LOOK, (s) => {
    s.profile = 'vivid';
    s.light.contrast = 25;
    s.light.blacks = -15;
    s.color.saturation = 15;
    s.hsl.blue.lum = -15;
    s.hsl.green.sat = 15;
    s.effects.vignetteAmount = -15;
  }),
  make('hk-cinestill', 'Night Tungsten', 'Film', LOOK, (s) => {
    s.color.temperature = -25;
    s.light.contrast = 15;
    s.hsl.red.sat = 15;
    s.grading.shadows = { hue: 190, sat: 25, lum: -5 };
    s.grading.highlights = { hue: 20, sat: 20, lum: 0 };
    s.effects.grainAmount = 25;
  }),
  make('hk-fade', 'Faded', 'Film', LOOK, (s) => {
    s.curves.rgb = [{ x: 0, y: 0.12 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.92 }];
    s.color.saturation = -20;
    s.grading.global = { hue: 35, sat: 8, lum: 0 };
    s.effects.grainAmount = 20;
  }),
  make('hk-teal', 'Teal & Orange', 'Cinema', LOOK, (s) => {
    s.light.contrast = 12;
    s.hsl.orange.sat = 15;
    s.hsl.aqua.hue = 20;
    s.hsl.blue.hue = -25;
    s.grading.shadows = { hue: 190, sat: 30, lum: 0 };
    s.grading.highlights = { hue: 32, sat: 25, lum: 0 };
    s.grading.balance = -10;
  }),
  make('hk-moody', 'Moody', 'Cinema', LOOK, (s) => {
    s.light.exposure = -0.3;
    s.light.contrast = 15;
    s.light.highlights = -40;
    s.color.saturation = -25;
    s.detail.clarity = 20;
    s.grading.shadows = { hue: 220, sat: 15, lum: -5 };
    s.effects.vignetteAmount = -25;
  }),
  make('hk-golden', 'Golden Hour', 'Cinema', LOOK, (s) => {
    s.color.temperature = 20;
    s.color.tint = 5;
    s.light.highlights = -20;
    s.hsl.orange.sat = 10;
    s.grading.highlights = { hue: 45, sat: 25, lum: 5 };
  }),
  make('hk-bw-classic', 'Classic B&W', 'Black & White', LOOK, (s) => {
    s.profile = 'mono';
    s.effects.bw = true;
    s.light.contrast = 20;
    s.effects.bwMix.blue = -20;
    s.effects.bwMix.orange = 15;
    s.effects.grainAmount = 15;
  }),
  make('hk-bw-high', 'High Contrast B&W', 'Black & White', LOOK, (s) => {
    s.profile = 'mono';
    s.effects.bw = true;
    s.light.contrast = 45;
    s.light.blacks = -25;
    s.light.whites = 20;
    s.detail.clarity = 25;
    s.effects.bwMix.blue = -45;
    s.effects.bwMix.red = 20;
  }),
  make('hk-bw-soft', 'Soft B&W', 'Black & White', LOOK, (s) => {
    s.profile = 'mono';
    s.effects.bw = true;
    s.light.contrast = -10;
    s.curves.rgb = [{ x: 0, y: 0.08 }, { x: 1, y: 0.94 }];
    s.effects.grainAmount = 22;
  }),
];

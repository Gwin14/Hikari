
import { identityStrip, parseCube, stripToCube } from '@/core/color/cube';
import { defaultSettings } from '@/core/recipe/defaults';
import { parsePresetFile, presetToLightroom } from '@/core/recipe/presetStore';
import { crsToSettings, parseLrTemplate, parseXmpCrs, settingsToCrs } from '@/core/xmp/crs';

jest.mock('@/core/db/db', () => ({ newId: () => 'id', upsertJson: jest.fn(), listJson: () => [], deleteRow: jest.fn() }));

const LR_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal"
   crs:UUID="0123456789ABCDEF0123456789ABCDEF"
   crs:SupportsAmount="True"
   crs:Version="15.0"
   crs:ProcessVersion="11.0"
   crs:Exposure2012="+0.35"
   crs:Contrast2012="+18"
   crs:Highlights2012="-40"
   crs:WhiteBalance="Custom"
   crs:IncrementalTemperature="+8"
   crs:Vibrance="+15"
   crs:HueAdjustmentGreen="-30"
   crs:SaturationAdjustmentBlue="-25"
   crs:SplitToningShadowHue="210"
   crs:SplitToningShadowSaturation="20"
   crs:ColorGradeMidtoneHue="40"
   crs:ColorGradeMidtoneSat="10"
   crs:ColorGradeBlending="60"
   crs:GrainAmount="25"
   crs:PostCropVignetteAmount="-20"
   crs:HasSettings="True">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Warm Film</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Film</rdf:li>
    </rdf:Alt>
   </crs:Group>
   <crs:Look>
    <rdf:Description crs:Name="Adobe Vivid" crs:Amount="1"/>
   </crs:Look>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 20</rdf:li>
     <rdf:li>128, 128</rdf:li>
     <rdf:li>255, 240</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:LocalExposure2012="+1" crs:Exposure2012="+3"/>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

const LR_TEMPLATE = `s = {
	id = "8D3E1C5B-1C3D-4C55-9B3F-0E0B8C1E2A11",
	internalName = "Old Matte",
	title = ZSTR "$$$/Old/Matte=Old Matte",
	type = "Develop",
	value = {
		settings = {
			Exposure2012 = -0.2,
			Shadows2012 = 30,
			ConvertToGrayscale = true,
			GrayMixerBlue = -40,
			ToneCurvePV2012 = {
				0,
				30,
				255,
				235,
			},
			ParametricShadows = 0,
		},
		uuid = "E9B0B5F1",
	},
	version = 0,
}`;

describe('Lightroom presets', () => {
  it('imports a Lightroom .xmp develop preset', () => {
    const p = parsePresetFile(LR_XMP, 'Warm Film.xmp');
    expect(p.name).toBe('Warm Film');
    const s = p.settings;
    expect(s.light).toMatchObject({ exposure: 0.35, contrast: 18, highlights: -40, shadows: 0 });
    expect(s.color?.temperature).toBeCloseTo(10);
    expect(s.color?.vibrance).toBe(15);
    expect(s.hsl?.green.hue).toBe(-30);
    expect(s.hsl?.blue.sat).toBe(-25);
    expect(s.grading?.shadows).toEqual({ hue: 210, sat: 20, lum: 0 });
    expect(s.grading?.midtones).toEqual({ hue: 40, sat: 10, lum: 0 });
    expect(s.grading?.blending).toBe(60);
    expect(s.effects).toMatchObject({ grainAmount: 25, vignetteAmount: -20 });
    expect(s.curves?.rgb[0]).toEqual({ x: 0, y: 20 / 255 });
    expect(s.profile).toBe('vivid');
    // local mask values must not leak into the global settings
    expect(s.light?.exposure).not.toBe(3);
    expect(s.masks).toBeUndefined();
  });

  it('imports a legacy .lrtemplate preset', () => {
    const lr = parseLrTemplate(LR_TEMPLATE);
    expect(lr.name).toBe('Old Matte');
    const { settings } = crsToSettings(lr.values);
    expect(settings.light).toMatchObject({ exposure: -0.2, shadows: 30 });
    expect(settings.effects?.bw).toBe(true);
    expect(settings.effects?.bwMix.blue).toBe(-40);
    expect(settings.profile).toBe('mono');
    expect(settings.curves?.rgb).toEqual([
      { x: 0, y: 30 / 255 },
      { x: 1, y: 235 / 255 },
    ]);
    expect(parsePresetFile(LR_TEMPLATE, 'x.lrtemplate').name).toBe('Old Matte');
  });

  it('round-trips every Lightroom-compatible setting through .xmp', () => {
    const s = defaultSettings();
    s.light = { exposure: -0.75, contrast: 22, highlights: -60, shadows: 45, whites: 10, blacks: -12 };
    s.color = { temperature: 25, tint: -10, vibrance: 30, saturation: -5 };
    s.curves.rgb = [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.55 }, { x: 1, y: 0.9 }].map((p) => ({ x: Math.round(p.x * 255) / 255, y: Math.round(p.y * 255) / 255 }));
    s.hsl.orange = { hue: 10, sat: -20, lum: 15 };
    s.grading.shadows = { hue: 200, sat: 30, lum: -10 };
    s.grading.global = { hue: 35, sat: 5, lum: 3 };
    s.grading.balance = -20;
    s.detail = { ...s.detail, sharpenAmount: 60, sharpenRadius: 1.2, clarity: 15, texture: -10, dehaze: 8, noiseLuma: 20 };
    s.effects = { ...s.effects, vignetteAmount: -30, vignetteMidpoint: 40, grainAmount: 20, grainSize: 30 };
    const sections = { light: s.light, color: s.color, curves: s.curves, hsl: s.hsl, grading: s.grading, detail: s.detail, effects: s.effects };
    const xml = presetToLightroom({ id: 'a', name: 'Round & "Trip"', group: 'mine', builtIn: false, settings: sections });
    expect(xml).toContain('crs:PresetType="Normal"');
    const back = parsePresetFile(xml);
    expect(back.name).toBe('Round & "Trip"');
    expect(back.settings.light).toEqual(s.light);
    expect(back.settings.color).toEqual(s.color);
    expect(back.settings.curves).toEqual(s.curves);
    expect(back.settings.hsl).toEqual(s.hsl);
    expect(back.settings.grading).toEqual(s.grading);
    expect(back.settings.detail).toEqual(s.detail);
    expect(back.settings.effects).toEqual(s.effects);
  });

  it('only emits the sections a preset contains', () => {
    const crs = settingsToCrs({ light: defaultSettings().light });
    expect(Object.keys(crs)).toContain('Exposure2012');
    expect(Object.keys(crs)).not.toContain('Vibrance');
    expect(crsToSettings(parseXmpCrs('<x/>').values).used).toBe(0);
  });

  it('rejects files without settings', () => {
    expect(() => parsePresetFile('<x:xmpmeta></x:xmpmeta>')).toThrow();
  });
});

describe('LUT export', () => {
  it('writes a valid identity .cube from an identity render', () => {
    const n = 5;
    const id = identityStrip(n);
    // identity render: 16-bit value = 8-bit value * 257 → high byte = v, low byte = v
    const cube = parseCube(stripToCube(id, id, n, 'Test'));
    expect(cube.size).toBe(n);
    expect(cube.title).toBe('Test');
    // red fastest
    expect(Array.from(cube.data.slice(3, 6)).map((v) => Math.round(v * 4))).toEqual([1, 0, 0]);
    const last = cube.data.length - 3;
    expect(Array.from(cube.data.slice(last))).toEqual([1, 1, 1]);
  });
});

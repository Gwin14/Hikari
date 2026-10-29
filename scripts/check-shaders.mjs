// Compiles every SkSL source with CanvasKit (same SkSL compiler as react-native-skia)
// and prints errors plus the uniform layout. Usage: node scripts/check-shaders.mjs
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const src = fs.readFileSync(path.resolve('src/core/pipeline/shaders.ts'), 'utf8');
// Evaluate the TS module (only template literals + consts) by stripping type syntax.
const js = src.replace(/export const/g, 'exports.').replace(/exports\.(\w+) =/g, 'exports.$1 =').replace(/^const COMMON/m, 'var COMMON');
const exports = {};
new Function('exports', js.replace(/exports\.(\w+) =/g, 'exports.$1 =').replace(/^exports\./gm, 'exports.').replace(/exports\.(\w+)\s=\s/g,'exports.$1 = '))(exports);
const CK = await CanvasKitInit({ locateFile: (f) => require.resolve('canvaskit-wasm/bin/full/' + f) });
let failed = false;
for (const [name, code] of Object.entries(exports)) {
  let err = '';
  const eff = CK.RuntimeEffect.Make(code, (e) => (err += e));
  if (!eff) { failed = true; console.log(`✗ ${name}\n${err}`); continue; }
  const u = [];
  for (let i = 0; i < eff.getUniformCount(); i++) u.push(eff.getUniformName(i));
  console.log(`✓ ${name}: ${eff.getUniformFloatCount()} floats, ${u.length} uniforms`);
}
process.exit(failed ? 1 : 0);

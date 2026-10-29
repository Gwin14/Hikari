import { createWorkletRuntime, runOnRuntimeAsync, type WorkletRuntime } from 'react-native-worklets';

let runtime: WorkletRuntime | null | undefined;

/**
 * Runs a CPU-heavy worklet (mask refinement, content-aware fill) on a background JS runtime so
 * the editor stays responsive. Typed arrays are copied in and out. Falls back to the calling
 * thread where worklet runtimes are unavailable (tests, web).
 */
export function runCompute<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<R> {
  if (runtime === undefined) {
    try {
      runtime = createWorkletRuntime({ name: 'hikari-compute' });
    } catch {
      runtime = null;
    }
  }
  if (!runtime) return new Promise((resolve) => setTimeout(() => resolve(fn(...args)), 0));
  return runOnRuntimeAsync(runtime, fn, ...args);
}

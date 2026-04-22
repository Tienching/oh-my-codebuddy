import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AdaptPathSet, type AdaptTarget } from './contracts.js';

function getAdaptersBaseDir(cwd: string): string {
  const canonical = join(cwd, '.omb', 'adapters');
  const legacy = join(cwd, '.omx', 'adapters');
  if (existsSync(canonical) || !existsSync(legacy)) {
    return canonical;
  }
  return legacy;
}

export function resolveAdaptPaths(
  cwd: string,
  target: AdaptTarget,
): AdaptPathSet {
  const adapterRoot = join(getAdaptersBaseDir(cwd), target);
  const reportsDir = join(adapterRoot, 'reports');
  return {
    adapterRoot,
    configPath: join(adapterRoot, 'adapter.json'),
    envelopePath: join(adapterRoot, 'envelope.json'),
    reportsDir,
    probeReportPath: join(reportsDir, 'probe.json'),
    statusReportPath: join(reportsDir, 'status.json'),
  };
}

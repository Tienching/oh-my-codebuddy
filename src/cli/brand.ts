import { basename } from 'node:path';
import { resolveOmxEntryPath } from '../utils/paths.js';

export interface CliBrand {
  command: 'omx' | 'omb';
  product: 'CodeBuddy';
  project: 'oh-my-codebuddy';
  acronym: 'OMB';
}

const OMB_BRAND: CliBrand = {
  command: 'omb',
  product: 'CodeBuddy',
  project: 'oh-my-codebuddy',
  acronym: 'OMB',
};

const OMX_BRAND: CliBrand = {
  command: 'omx',
  product: 'CodeBuddy',
  project: 'oh-my-codebuddy',
  acronym: 'OMB',
};

export function resolveCliBrand(): CliBrand {
  const entry = resolveOmxEntryPath();
  const base = basename(entry || '').toLowerCase();
  return base === 'omx.js' ? OMX_BRAND : OMB_BRAND;
}

export function formatCliText(template: string, brand = resolveCliBrand()): string {
  return template
    .replaceAll('{cmd}', brand.command)
    .replaceAll('{product}', brand.product)
    .replaceAll('{project}', brand.project)
    .replaceAll('{acronym}', brand.acronym);
}

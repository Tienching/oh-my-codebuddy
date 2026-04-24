export interface CliBrand {
  command: 'omb';
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


export function resolveCliBrand(): CliBrand {
  return OMB_BRAND;
}

export function formatCliText(template: string, brand = resolveCliBrand()): string {
  return template
    .replaceAll('{cmd}', brand.command)
    .replaceAll('{product}', brand.product)
    .replaceAll('{project}', brand.project)
    .replaceAll('{acronym}', brand.acronym);
}

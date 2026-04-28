import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ENV_KEYS = ['CODEBUDDY_HOME', 'OMB_OPENCLAW'] as const;

let tempCodeBuddyHome: string;
let getNotificationConfig: typeof import('../config.js').getNotificationConfig;
let getOpenClawConfig: typeof import('../../openclaw/config.js').getOpenClawConfig;
let resetOpenClawConfigCache: typeof import('../../openclaw/config.js').resetOpenClawConfigCache;

async function writeCodeBuddyConfig(contents: unknown): Promise<void> {
  await mkdir(tempCodeBuddyHome, { recursive: true });
  await writeFile(join(tempCodeBuddyHome, '.omb-config.json'), JSON.stringify(contents, null, 2));
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('notification custom alias enablement defaults', () => {
  before(async () => {
    clearEnv();
    tempCodeBuddyHome = await mkdtemp(join(tmpdir(), 'omb-custom-alias-'));
    process.env.CODEBUDDY_HOME = tempCodeBuddyHome;
    process.env.OMB_OPENCLAW = '1';

    ({ getNotificationConfig } = await import('../config.js'));
    ({ getOpenClawConfig, resetOpenClawConfigCache } = await import('../../openclaw/config.js'));
  });

  beforeEach(() => {
    process.env.CODEBUDDY_HOME = tempCodeBuddyHome;
    process.env.OMB_OPENCLAW = '1';
    resetOpenClawConfigCache();
  });

  afterEach(async () => {
    resetOpenClawConfigCache();
    await rm(join(tempCodeBuddyHome, '.omb-config.json'), { force: true });
  });

  after(async () => {
    clearEnv();
    resetOpenClawConfigCache();
    if (tempCodeBuddyHome) {
      await rm(tempCodeBuddyHome, { recursive: true, force: true });
    }
  });

  it('treats custom_webhook_command without enabled as active across notifications and openclaw layers', async () => {
    await writeCodeBuddyConfig({
      notifications: {
        enabled: true,
        custom_webhook_command: {
          url: 'https://example.com/hook',
          events: ['session-end'],
        },
      },
    });

    const notificationConfig = getNotificationConfig();
    const openclawConfig = getOpenClawConfig();

    assert.ok(notificationConfig);
    assert.equal(notificationConfig.enabled, true);
    assert.equal(notificationConfig.openclaw?.enabled, true);
    assert.ok(openclawConfig);
    assert.equal(openclawConfig?.enabled, true);
    assert.equal(openclawConfig?.hooks['session-end']?.gateway, 'custom-webhook');
  });

  it('treats custom_cli_command without enabled as active across notifications and openclaw layers', async () => {
    await writeCodeBuddyConfig({
      notifications: {
        enabled: true,
        custom_cli_command: {
          command: 'echo hello',
          events: ['ask-user-question'],
        },
      },
    });

    const notificationConfig = getNotificationConfig();
    const openclawConfig = getOpenClawConfig();

    assert.ok(notificationConfig);
    assert.equal(notificationConfig.enabled, true);
    assert.equal(notificationConfig.openclaw?.enabled, true);
    assert.ok(openclawConfig);
    assert.equal(openclawConfig?.enabled, true);
    assert.equal(openclawConfig?.hooks['ask-user-question']?.gateway, 'custom-cli');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { safeStateText, safeStateMetadata, redactSensitiveValues, redactMetadataSecrets, STATE_TEXT_LIMITS } from '../state-text-safety.js';

describe('state-text-safety', () => {
  describe('safeStateText', () => {
    it('preserves text within limit', () => {
      assert.equal(safeStateText('hello', 100), 'hello');
    });

    it('truncates text exceeding limit', () => {
      const long = 'a'.repeat(200);
      const result = safeStateText(long, 100);
      assert.ok(result.length <= 100);
      assert.ok(result.includes('truncated'));
    });

    it('preserves start of text when truncating', () => {
      const long = 'Hello World ' + 'x'.repeat(200);
      const result = safeStateText(long, 50);
      assert.ok(result.startsWith('Hello'));
    });
  });

  describe('safeStateMetadata', () => {
    it('passes small metadata through', () => {
      const meta = { key: 'value' };
      const { value, info } = safeStateMetadata(meta, 10000);
      assert.deepEqual(value, meta);
      assert.equal(info.truncated, false);
    });

    it('truncates large metadata', () => {
      const meta = { key: 'x'.repeat(50000) };
      const { value, info } = safeStateMetadata(meta, 1000);
      assert.equal(info.truncated, true);
      assert.ok(info.original_bytes > 1000);
    });

    it('returns undefined for undefined input', () => {
      const { value, info } = safeStateMetadata(undefined, 10000);
      assert.equal(value, undefined);
      assert.equal(info.truncated, false);
    });
  });

  describe('redactSensitiveValues', () => {
    it('redacts Bearer tokens', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456';
      const result = redactSensitiveValues(text);
      assert.ok(result.includes('[REDACTED:bearer]'));
      assert.ok(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    });

    it('redacts API key patterns', () => {
      const text = 'sk_live: "sk-abc123def456ghi789jkl012mno345pqr"';
      const result = redactSensitiveValues(text);
      assert.ok(result.includes('[REDACTED:apikey]'));
    });

    it('preserves non-secret text', () => {
      const text = 'Worker completed task successfully';
      assert.equal(redactSensitiveValues(text), text);
    });
  });

  describe('redactMetadataSecrets', () => {
    it('redacts string values containing secrets', () => {
      const meta = { token: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456', name: 'worker-1' };
      const result = redactMetadataSecrets(meta);
      assert.ok(typeof result.token === 'string');
      assert.ok((result.token as string).includes('[REDACTED'));
      assert.equal(result.name, 'worker-1');
    });

    it('handles nested objects', () => {
      const meta = { config: { api_key: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456' } };
      const result = redactMetadataSecrets(meta);
      const config = result.config as Record<string, unknown>;
      assert.ok(typeof config.api_key === 'string');
      assert.ok((config.api_key as string).includes('[REDACTED'));
    });
  });

  describe('STATE_TEXT_LIMITS', () => {
    it('has all required limits defined', () => {
      assert.ok(STATE_TEXT_LIMITS.MAX_EVENT_REASON_LENGTH > 0);
      assert.ok(STATE_TEXT_LIMITS.MAX_MAILBOX_BODY_LENGTH > 0);
      assert.ok(STATE_TEXT_LIMITS.MAX_TRIGGER_MESSAGE_LENGTH > 0);
    });
  });
});

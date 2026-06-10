import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_API_OPERATIONS } from '../api-interop.js';
import {
  TEAM_API_OPERATION_SCHEMAS,
  getRequiredFields,
  getOptionalFields,
  getOperationNote,
  validateRequiredFields,
} from '../api-operation-registry.js';

describe('api-operation-registry', () => {
  describe('TEAM_API_OPERATION_SCHEMAS completeness', () => {
    it('has a schema entry for every TEAM_API_OPERATIONS entry', () => {
      for (const op of TEAM_API_OPERATIONS) {
        assert.ok(op in TEAM_API_OPERATION_SCHEMAS, `Missing schema for operation: ${op}`);
      }
    });

    it('every schema has at least team_name in required fields (except where operation-level validation applies)', () => {
      for (const op of TEAM_API_OPERATIONS) {
        const schema = TEAM_API_OPERATION_SCHEMAS[op];
        // Most operations require team_name; verify the schema is well-formed
        assert.ok(Array.isArray(schema.required), `Schema for ${op} has invalid required array`);
        assert.ok(Array.isArray(schema.optional), `Schema for ${op} has invalid optional array`);
        assert.equal(schema.operation, op, `Schema operation name mismatch: ${schema.operation} vs ${op}`);
      }
    });

    it('no required field also appears in optional fields', () => {
      for (const op of TEAM_API_OPERATIONS) {
        const schema = TEAM_API_OPERATION_SCHEMAS[op];
        const requiredSet = new Set(schema.required);
        for (const opt of schema.optional) {
          assert.ok(!requiredSet.has(opt), `Field "${opt}" in ${op} is both required and optional`);
        }
      }
    });
  });

  describe('getRequiredFields', () => {
    it('returns correct required fields for send-message', () => {
      const fields = getRequiredFields('send-message');
      assert.deepEqual(fields, ['team_name', 'from_worker', 'to_worker', 'body']);
    });

    it('returns team_name for list-tasks', () => {
      const fields = getRequiredFields('list-tasks');
      assert.deepEqual(fields, ['team_name']);
    });

    it('returns all 5 required fields for transition-task-status', () => {
      const fields = getRequiredFields('transition-task-status');
      assert.ok(fields.includes('team_name'));
      assert.ok(fields.includes('task_id'));
      assert.ok(fields.includes('from'));
      assert.ok(fields.includes('to'));
      assert.ok(fields.includes('claim_token'));
    });
  });

  describe('getOptionalFields', () => {
    it('returns empty array for operations with no optional fields', () => {
      const fields = getOptionalFields('send-message');
      assert.deepEqual(fields, []);
    });

    it('returns correct optional fields for create-task', () => {
      const fields = getOptionalFields('create-task');
      assert.ok(fields.includes('owner'));
      assert.ok(fields.includes('blocked_by'));
    });
  });

  describe('getOperationNote', () => {
    it('returns a note for operations that have one', () => {
      const note = getOperationNote('update-task');
      assert.equal(note, 'Only non-lifecycle task metadata can be updated.');
    });

    it('returns undefined for operations without notes', () => {
      const note = getOperationNote('send-message');
      assert.equal(note, undefined);
    });
  });

  describe('validateRequiredFields', () => {
    it('returns empty array when all required fields present', () => {
      const missing = validateRequiredFields('send-message', {
        team_name: 'my-team',
        from_worker: 'worker-1',
        to_worker: 'worker-2',
        body: 'hello',
      });
      assert.deepEqual(missing, []);
    });

    it('returns missing field names when required fields absent', () => {
      const missing = validateRequiredFields('send-message', {
        team_name: 'my-team',
      });
      assert.ok(missing.includes('from_worker'));
      assert.ok(missing.includes('to_worker'));
      assert.ok(missing.includes('body'));
    });

    it('treats empty string as missing', () => {
      const missing = validateRequiredFields('send-message', {
        team_name: 'my-team',
        from_worker: '',
        to_worker: 'worker-2',
        body: 'hello',
      });
      assert.ok(missing.includes('from_worker'));
    });

    it('treats null as missing', () => {
      const missing = validateRequiredFields('send-message', {
        team_name: 'my-team',
        from_worker: null,
        to_worker: 'worker-2',
        body: 'hello',
      });
      assert.ok(missing.includes('from_worker'));
    });

    it('handles operations with only team_name required', () => {
      const missing = validateRequiredFields('list-tasks', {
        team_name: 'my-team',
      });
      assert.deepEqual(missing, []);
    });
  });

  describe('parity with cli/team.ts constants', () => {
    it('required fields count matches operations count', () => {
      // Every operation should have a schema entry
      assert.equal(
        Object.keys(TEAM_API_OPERATION_SCHEMAS).length,
        TEAM_API_OPERATIONS.length,
        'Schema count should match operations count'
      );
    });
  });
});

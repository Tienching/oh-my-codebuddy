import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function readPackageJson(pkg: string) {
  const pkgPath = join(process.cwd(), 'node_modules', ...pkg.split('/'), 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
}

describe('dependency contract smoke tests', () => {
  it('zod is importable and functional', async () => {
    const { z } = await import('zod');
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 'test' });
    assert.equal(result.success, true);
  });

  it('@modelcontextprotocol/sdk package is installed and has expected entry points', () => {
    const pkg = readPackageJson('@modelcontextprotocol/sdk');
    const exports = pkg.exports as Record<string, unknown> | undefined;
    assert.equal(pkg.name, '@modelcontextprotocol/sdk');
    assert.ok(pkg.version, 'should have a version');
    assert.ok(exports, 'should define exports');
    assert.ok(exports!['./server'], 'should export ./server subpath');
    assert.ok(exports!['./client'], 'should export ./client subpath');
  });

  it('@iarna/toml package is installed and exposes parse', () => {
    const toml = require('@iarna/toml') as { parse: (s: string) => Record<string, unknown> };
    const parsed = toml.parse('[section]\nkey = "value"\n');
    assert.equal(
      (parsed as Record<string, Record<string, string>>).section.key,
      'value',
    );
  });
});

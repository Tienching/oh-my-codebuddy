import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TOML from '@iarna/toml';

describe('version sync contract', () => {
  it('keeps package.json, workspace metadata, and Rust members aligned for releases', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
    const workspace = TOML.parse(readFileSync(join(process.cwd(), 'Cargo.toml'), 'utf-8')) as {
      workspace?: { package?: { version?: string }; members?: string[] };
    };
    const explore = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omb-explore', 'Cargo.toml'), 'utf-8')) as {
      package?: { version?: string | { workspace?: boolean } };
    };
    const runtimeCore = TOML.parse(
      readFileSync(join(process.cwd(), 'crates', 'omb-runtime-core', 'Cargo.toml'), 'utf-8'),
    ) as { package?: { version?: string | { workspace?: boolean } } };
    const mux = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omb-mux', 'Cargo.toml'), 'utf-8')) as {
      package?: { version?: string | { workspace?: boolean } };
    };
    const runtime = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omb-runtime', 'Cargo.toml'), 'utf-8')) as {
      package?: { version?: string | { workspace?: boolean } };
    };
    const sparkshell = TOML.parse(readFileSync(join(process.cwd(), 'crates', 'omb-sparkshell', 'Cargo.toml'), 'utf-8')) as {
      package?: { version?: string | { workspace?: boolean } };
    };

    assert.equal(workspace.workspace?.package?.version, pkg.version);
    assert.deepEqual(workspace.workspace?.members, [
      'crates/omb-explore',
      'crates/omb-mux',
      'crates/omb-runtime-core',
      'crates/omb-runtime',
      'crates/omb-sparkshell',
    ]);
    assert.deepEqual(explore.package?.version, { workspace: true });
    assert.deepEqual(runtimeCore.package?.version, { workspace: true });
    assert.deepEqual(mux.package?.version, { workspace: true });
    assert.deepEqual(runtime.package?.version, { workspace: true });
    assert.deepEqual(sparkshell.package?.version, { workspace: true });
  });
});

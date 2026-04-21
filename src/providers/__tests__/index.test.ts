import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRepositoryProviders,
  parseRepositoryRemote,
  selectPrimaryRepositoryProvider,
} from '../index.js';

describe('parseRepositoryRemote', () => {
  it('parses GitHub https remotes', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'https://github.com/acme/rocket.git',
    });

    assert.equal(snapshot.provider, 'github');
    assert.equal(snapshot.owner, 'acme');
    assert.equal(snapshot.repo, 'rocket');
    assert.equal(snapshot.slug, 'acme/rocket');
  });

  it('parses GitLab ssh remotes', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'git@gitlab.com:acme/platform.git',
    });

    assert.equal(snapshot.provider, 'gitlab');
    assert.equal(snapshot.owner, 'acme');
    assert.equal(snapshot.repo, 'platform');
  });

  it('parses Bitbucket remotes', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'https://bitbucket.org/acme/mobile.git',
    });

    assert.equal(snapshot.provider, 'bitbucket');
    assert.equal(snapshot.slug, 'acme/mobile');
  });

  it('parses Gitea-style remotes from gitea hosts', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'https://gitea.example.com/acme/internal.git',
    });

    assert.equal(snapshot.provider, 'gitea');
    assert.equal(snapshot.slug, 'acme/internal');
  });

  it('parses Azure DevOps https remotes', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'https://dev.azure.com/acme/core/_git/portal',
    });

    assert.equal(snapshot.provider, 'azure');
    assert.equal(snapshot.owner, 'acme');
    assert.equal(snapshot.project, 'core');
    assert.equal(snapshot.repo, 'portal');
    assert.equal(snapshot.slug, 'acme/core/portal');
  });

  it('degrades invalid remotes to unknown snapshots', () => {
    const snapshot = parseRepositoryRemote({
      name: 'origin',
      url: 'not-a-valid-remote',
    });

    assert.equal(snapshot.provider, 'unknown');
    assert.equal(snapshot.slug, null);
  });
});

describe('collectRepositoryProviders', () => {
  it('prefers origin as the primary remote', () => {
    const collection = collectRepositoryProviders([
      { name: 'upstream', url: 'https://github.com/acme/upstream.git' },
      { name: 'origin', url: 'https://github.com/acme/origin.git' },
    ]);

    assert.equal(collection.primary?.remoteName, 'origin');
    assert.equal(collection.primary?.repo, 'origin');
  });

  it('falls back to the first remote when origin is unavailable', () => {
    const remotes = [
      parseRepositoryRemote({
        name: 'upstream',
        url: 'https://github.com/acme/upstream.git',
      }),
    ];

    assert.equal(selectPrimaryRepositoryProvider(remotes)?.remoteName, 'upstream');
  });
});

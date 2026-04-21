/**
 * Background Job Manager
 * Minimal job lifecycle management using JSON file storage
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Job, JobCreate, JobUpdate, JobFilter, JobStatus, NotificationHook } from './types.js';

const JOBS_DIR = '.omb/jobs';

function getJobsDir(cwd: string): string {
  return join(cwd, JOBS_DIR);
}

function getJobPath(cwd: string, jobId: string): string {
  return join(getJobsDir(cwd), `${jobId}.json`);
}

async function ensureJobsDir(cwd: string): Promise<void> {
  const dir = getJobsDir(cwd);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

// ── Core CRUD ────────────────────────────────────────────────────────────────

export async function createJob(cwd: string, input: JobCreate): Promise<Job> {
  await ensureJobsDir(cwd);
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
  };
  const path = getJobPath(cwd, job.id);
  await writeFile(path, JSON.stringify(job, null, 2), 'utf-8');
  return job;
}

export async function getJob(cwd: string, jobId: string): Promise<Job | null> {
  const path = getJobPath(cwd, jobId);
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as Job;
  } catch {
    return null;
  }
}

export async function updateJob(cwd: string, jobId: string, update: JobUpdate): Promise<Job | null> {
  const job = await getJob(cwd, jobId);
  if (!job) return null;

  const now = new Date().toISOString();
  const updated: Job = {
    ...job,
    ...update,
    updatedAt: now,
  };

  if (update.status === 'running' && !job.startedAt) {
    updated.startedAt = now;
  }
  if (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled') {
    updated.completedAt = now;
  }

  const path = getJobPath(cwd, jobId);
  await writeFile(path, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export async function deleteJob(cwd: string, jobId: string): Promise<boolean> {
  const path = getJobPath(cwd, jobId);
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function listJobs(cwd: string, filter?: JobFilter): Promise<Job[]> {
  const dir = getJobsDir(cwd);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir).catch(() => []);
  const jobs: Job[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const content = await readFile(join(dir, entry), 'utf-8');
      const job = JSON.parse(content) as Job;
      if (filter?.status && job.status !== filter.status) continue;
      jobs.push(job);
    } catch {
      // Skip invalid files
    }
  }

  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── Job Lifecycle Helpers ────────────────────────────────────────────────────

export async function startJob(cwd: string, jobId: string, hooks?: NotificationHook): Promise<Job | null> {
  const job = await getJob(cwd, jobId);
  if (!job || job.status !== 'pending') return null;

  const updated = await updateJob(cwd, jobId, { status: 'running' });
  if (updated && hooks?.onJobStart) {
    hooks.onJobStart(updated);
  }
  return updated;
}

export async function completeJob(
  cwd: string,
  jobId: string,
  result: string,
  hooks?: NotificationHook
): Promise<Job | null> {
  const updated = await updateJob(cwd, jobId, { status: 'completed', result, progress: 100 });
  if (updated && hooks?.onJobComplete) {
    hooks.onJobComplete(updated);
  }
  return updated;
}

export async function failJob(
  cwd: string,
  jobId: string,
  error: string,
  hooks?: NotificationHook
): Promise<Job | null> {
  const updated = await updateJob(cwd, jobId, { status: 'failed', error });
  if (updated && hooks?.onJobFail) {
    hooks.onJobFail(updated);
  }
  return updated;
}

export async function cancelJob(cwd: string, jobId: string, hooks?: NotificationHook): Promise<Job | null> {
  const job = await getJob(cwd, jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return null;

  const updated = await updateJob(cwd, jobId, { status: 'cancelled' });
  if (updated && hooks?.onJobFail) {
    hooks.onJobFail(updated);
  }
  return updated;
}

export async function setJobProgress(
  cwd: string,
  jobId: string,
  progress: number,
  hooks?: NotificationHook
): Promise<Job | null> {
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const updated = await updateJob(cwd, jobId, { progress: clampedProgress });
  if (updated && hooks?.onJobProgress) {
    hooks.onJobProgress(updated);
  }
  return updated;
}

// ── Query Helpers ───────────────────────────────────────────────────────────

export async function getJobsByStatus(cwd: string, status: JobStatus): Promise<Job[]> {
  return listJobs(cwd, { status });
}

export async function getActiveJobs(cwd: string): Promise<Job[]> {
  return listJobs(cwd).then(jobs =>
    jobs.filter(j => j.status === 'pending' || j.status === 'running')
  );
}

export async function getJobStats(cwd: string): Promise<{
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}> {
  const jobs = await listJobs(cwd);
  return {
    total: jobs.length,
    pending: jobs.filter(j => j.status === 'pending').length,
    running: jobs.filter(j => j.status === 'running').length,
    completed: jobs.filter(j => j.status === 'completed').length,
    failed: jobs.filter(j => j.status === 'failed').length,
    cancelled: jobs.filter(j => j.status === 'cancelled').length,
  };
}

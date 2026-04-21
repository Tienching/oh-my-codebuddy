/**
 * Background Job Manager Types
 * Minimal job state persistence for OMB
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  name: string;
  description?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number; // 0-100
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface JobCreate {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface JobUpdate {
  status?: JobStatus;
  progress?: number;
  result?: string;
  error?: string;
}

export interface JobFilter {
  status?: JobStatus;
}

export interface NotificationHook {
  onJobStart?: (job: Job) => void;
  onJobComplete?: (job: Job) => void;
  onJobFail?: (job: Job) => void;
  onJobProgress?: (job: Job) => void;
}

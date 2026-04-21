export type TaskDecompositionStrategy = 'numbered' | 'bulleted' | 'conjunction' | 'atomic';

export interface TaskDecompositionTask {
  subject: string;
  description: string;
  owner: string;
  role?: string;
  route_confidence?: 'high' | 'medium' | 'low';
  route_reason?: string;
}

export interface TaskDecompositionMetadata {
  strategy: TaskDecompositionStrategy;
  usedAspectSubtasks: boolean;
  fallbackRole: string;
  requestedWorkerCount: number;
  explicitAgentType: boolean;
  explicitWorkerCount: boolean;
}

export interface TaskDecompositionPlan {
  workerCount: number;
  tasks: TaskDecompositionTask[];
  metadata: TaskDecompositionMetadata;
}

export interface TaskDecomposerOptions {
  workerCount: number;
  agentType: string;
  explicitAgentType: boolean;
  explicitWorkerCount?: boolean;
}

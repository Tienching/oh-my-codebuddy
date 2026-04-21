/**
 * Project Memory Types
 *
 * Shared type definitions for project memory system.
 */

export interface HotPath {
  path: string;
  accessCount: number;
  lastAccessed: number;
  type: 'file' | 'directory';
}

export interface Directive {
  directive: string;
  priority: 'high' | 'normal';
  context?: string;
  timestamp: number;
}

export interface ProjectMemory {
  version: number;
  lastScanned: number;
  techStack?: TechStack;
  build?: BuildInfo;
  conventions?: CodeConventions;
  structure?: ProjectStructure;
  notes?: Array<{ category: string; content: string; timestamp: number }>;
  directives?: Directive[];
  hotPaths?: HotPath[];
  directoryMap?: Record<string, DirectoryInfo>;
}

export interface TechStack {
  languages: LanguageDetection[];
  frameworks: FrameworkDetection[];
  packageManager: string | null;
  runtime: string | null;
}

export interface LanguageDetection {
  name: string;
  version: string | null;
  confidence: 'high' | 'medium' | 'low';
  markers: string[];
}

export interface FrameworkDetection {
  name: string;
  version: string | null;
  category: string;
}

export interface BuildInfo {
  buildCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  devCommand: string | null;
  scripts: Record<string, string>;
}

export interface CodeConventions {
  namingStyle: string | null;
  importStyle: string | null;
  testPattern: string | null;
  fileOrganization: string | null;
}

export interface ProjectStructure {
  isMonorepo: boolean;
  workspaces: string[];
  mainDirectories: string[];
}

export interface DirectoryInfo {
  path: string;
  purpose: string | null;
  fileCount: number;
  lastAccessed: number;
  keyFiles: string[];
}

export interface CustomNote {
  category: string;
  content: string;
  timestamp: number;
  source?: 'learned' | 'manual';
}

export const SCHEMA_VERSION = 1;

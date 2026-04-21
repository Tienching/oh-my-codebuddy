/**
 * Setup module barrel export for oh-my-codebuddy.
 *
 * Provides the plan/preview/apply architecture for setup operations.
 */

export {
  type SetupActionKind,
  type SetupAction,
  type SetupPlan,
  type SetupPlanSummary,
  type SetupPlanOptions,
  computePlanSummary,
  generateSetupPlan,
  SETUP_SCOPES,
  type SetupScope,
  type ScopeDirectories,
  resolveScopeDirectories,
} from "./plan.js";

export {
  type ApplyOptions,
  type ApplyResult,
  applySetupPlan,
} from "./apply.js";

export {
  type ConfigMergeInput,
  type ConfigMergeResult,
  mergeConfig,
  shouldOmxManageTui,
  buildDesiredSettingsState,
  buildBootstrapSettingsJson,
} from "./config-merger.js";

export {
  type CompatRule,
  COMPAT_RULES,
  getCompatRule,
  getLegacyScopeMigration,
  getLegacySetupModel,
} from "./compat-rules.js";

export {
  type AssetInstaller,
  type InstallerOptions,
  promptsInstaller,
  skillsInstaller,
  nativeAgentsInstaller,
  agentsMdInstaller,
  hooksInstaller,
} from "./installers/index.js";

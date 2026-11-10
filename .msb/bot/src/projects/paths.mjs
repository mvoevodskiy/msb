/**
 * Base workspace + saved project → captured execution cwd; no state/env writes.
 * Old qA/_A root contract: [reference](../../tests/reference/parity-projects-contract.txt).
 * Callers: [selection](./selection.mjs), [files](./files.mjs),
 * [runner](../agent/turn.mjs), [compact](../agent/compact.mjs).
 * [Execution checks](../../tests/project-execution.test.mjs), [UI checks](../../tests/projects.test.mjs).
 * Implementation shared with the overlay: [project paths](../../shared/project-paths.mjs).
 */
export {projectLocations, projectMissing, projectPath, resolveProjectDirectory, resolveProjectCwd}
  from '../../shared/project-paths.mjs';

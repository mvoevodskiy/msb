// Keep the existing provider-store API while sharing the OS-released lock.
export { withFileLock as withStoreLock } from '../shared/file-lock.mjs';

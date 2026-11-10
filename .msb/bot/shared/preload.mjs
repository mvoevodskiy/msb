import profile from './profile.cjs';

// Import this before application modules that capture env at module initialization.
// Навигация: [Runtime profile](./README.md); resolver — [profile.cjs](./profile.cjs).
profile.initialize(process.env);

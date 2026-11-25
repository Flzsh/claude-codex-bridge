// The plugin's types file augments Claude Code's module; the app only needs it to exist.
declare module 'claude-code' {
  interface PluginState {}
  type Shaped<T> = T
}

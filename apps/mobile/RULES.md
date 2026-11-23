# Mobile development rules

- **Android first:** Android is the only actively developed and validated mobile
  platform.
- **iOS deferred:** Do not develop, build, test, or configure iOS unless it is
  explicitly requested. Preserve all existing iOS source, native project
  configuration, and platform assets.
- **Toolchain:** Use the project-pinned Flutter SDK and the existing Android
  toolchain. Do not change their versions or configuration as part of unrelated
  work.
- **Architecture:** Preserve the established feature-first Flutter architecture
  and existing backend contracts.
- **Quality:** Validate relevant changes with Flutter analysis, focused tests,
  and Android build checks.
- **Security:** Preserve Android permission boundaries, credential protection,
  and secure release-signing requirements.
- **Scope:** Avoid unrelated refactoring, unnecessary dependencies, and changes
  outside the assigned task.

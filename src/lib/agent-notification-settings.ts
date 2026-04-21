import type { AgentNotificationSettings } from '../types'

export const DEFAULT_AGENT_NOTIFICATION_SETTINGS: AgentNotificationSettings = {
  enabled: true,
  playSound: true,
  onlyWhenUnfocused: true,
  notifyOnDone: true,
  notifyOnAttention: true,
  notifyOnError: true,
}

export function normalizeAgentNotificationSettings(
  value?: Partial<AgentNotificationSettings> | null,
): AgentNotificationSettings {
  return {
    enabled: value?.enabled ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.enabled,
    playSound: value?.playSound ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.playSound,
    onlyWhenUnfocused:
      value?.onlyWhenUnfocused ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.onlyWhenUnfocused,
    notifyOnDone: value?.notifyOnDone ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.notifyOnDone,
    notifyOnAttention:
      value?.notifyOnAttention ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.notifyOnAttention,
    notifyOnError: value?.notifyOnError ?? DEFAULT_AGENT_NOTIFICATION_SETTINGS.notifyOnError,
  }
}

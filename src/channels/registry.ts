import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional hook fired when an unregistered chat sends a message;
  // wired by the orchestrator's open_dm path. Used by WhatsApp;
  // Telegram and Slack ignore.
  tryAutoRegister?: (chatJid: string) => void;
}

/**
 * Factory return shape. Most channel kinds (Telegram, Slack, Discord)
 * return one channel — the singleton case. WhatsApp returns one channel
 * *per pairing* so the deployment can run multiple WhatsApp accounts in
 * parallel (multi-agent-completion-blueprint § 4.1). The boot loop
 * normalises both forms into a flat array.
 */
export type ChannelFactoryResult = Channel | Channel[] | null;
export type ChannelFactory = (opts: ChannelOpts) => ChannelFactoryResult;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/**
 * Normalise a factory result into a flat array of live channels.
 * Filters out nulls (factory returned "I'm not configured on this
 * deployment") and unwraps array results from multi-instance factories
 * like WhatsApp.
 */
export function normaliseFactoryResult(
  result: ChannelFactoryResult,
): Channel[] {
  if (result == null) return [];
  if (Array.isArray(result))
    return result.filter((c): c is Channel => c != null);
  return [result];
}

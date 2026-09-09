import { record, type AcpHistory } from './acpContract';

export type AgentMessage = { id: string; role: string; text: string };
export function acpContentText(value: unknown, depth = 0): string {
  if (depth > 4) return '[Nested content omitted]';
  if (Array.isArray(value)) return value.map((block) => acpContentText(block, depth + 1)).join('\n');
  if (!record(value)) return '';
  if ((value.type === 'text' || value.type === undefined) && typeof value.text === 'string') return value.text;
  const label = (field: unknown, limit = 256) => (typeof field === 'string' ? field.slice(0, limit) : '');
  if (value.type === 'image' || value.type === 'audio')
    return `[${value.type === 'image' ? 'Image' : 'Audio'}${value.mimeType ? `: ${label(value.mimeType)}` : ''}; media is not fetched or played]`;
  if (value.type === 'resource_link')
    return `[Resource link: ${label(value.title ?? value.name)}${value.uri ? ` (${label(value.uri, 1024)})` : ''}; not fetched]`;
  if (value.type === 'resource' && record(value.resource))
    return `[Resource: ${label(value.resource.uri, 1024)}${value.resource.mimeType ? `; ${label(value.resource.mimeType)}` : ''}]${typeof value.resource.text === 'string' ? `\n${value.resource.text}` : '\n[Binary payload not displayed]'}`;
  return `[${label(value.type) || 'Unsupported'} content; payload not displayed]`;
}
export function agentMessages(history: AcpHistory[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of history) {
    if (!['agent-message', 'user-message'].includes(entry.kind) || !record(entry.content)) continue;
    const body = entry.content;
    const text = acpContentText(body.content ?? body);
    const id = typeof body.messageId === 'string' ? body.messageId : `${entry.turnId ?? 'replay'}:${entry.kind}`;
    const previous = messages.at(-1);
    if (previous?.id === id && previous.role === entry.kind) previous.text += text;
    else messages.push({ id, role: entry.kind, text });
  }
  return messages;
}
export function agentTools(history: AcpHistory[]): Record<string, unknown>[] {
  const tools = new Map<string, Record<string, unknown>>();
  for (const entry of history) {
    if (entry.kind !== 'tool-call' || !record(entry.content) || typeof entry.content.toolCallId !== 'string') continue;
    const id = entry.content.toolCallId;
    tools.set(id, { ...tools.get(id), ...entry.content });
  }
  return [...tools.values()];
}

/**
 * Stage 0 text extraction: flatten the replayed region messages into one
 * line-based text document for deterministic preprocessing and chunking.
 *
 * @module dsh-quilt-compact/stage0/text
 */

/**
 * Flatten one message's content blocks into text lines.
 * @param message - a request message (durable or one-shot).
 * @returns content text lines (without the role header).
 */
export function messageContentLines(message) {
  const lines = [];
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        lines.push(...splitLines(block.text));
        break;
      case 'tool-call':
        lines.push(`[tool-call ${block.name}]`);
        lines.push(...splitLines(block.arguments));
        break;
      case 'image': {
        const name = block.attachment?.name;
        const identity = name === undefined ? '' : `: ${name}`;
        lines.push(`[image${identity}${block.offloaded ? ' (offloaded)' : ''}]`);
        break;
      }
      case 'file': {
        const name = block.attachment?.name;
        const identity = name === undefined ? '' : `: ${name}`;
        lines.push(`[file${identity}]`);
        break;
      }
      default:
        lines.push(`[block ${String(block.type)}]`);
        try {
          lines.push(...splitLines(JSON.stringify(block)));
        } catch {
          lines.push(String(block));
        }
    }
  }
  return lines;
}

/**
 * Extract a line-based text document from the summarization input messages.
 * Each message contributes a role header line followed by its content lines.
 * @param messages - the summarization input (`{ tools?, messages }` replay prefix).
 * @returns non-mutated line array; empty when there is nothing to condense.
 */
export function extractRegionLines(messages) {
  const lines = [];
  for (const message of messages) {
    lines.push(`[${String(message.role)}]`);
    lines.push(...messageContentLines(message));
  }
  return lines;
}

/** Split a text block into lines, preserving interior blank lines. */
export function splitLines(text) {
  if (text === '') return [''];
  return String(text).split(/\r\n|\r|\n/);
}

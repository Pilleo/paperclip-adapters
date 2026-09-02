/**
 * Removes Paperclip bookkeeping from backlog text before it becomes task
 * content. These fields belong to the sync layer and must never identify a
 * different issue to an agent or provider.
 */
export function stripPaperclipIdentityMetadata(markdown: string): string {
  return markdown
    .replace(/^paperclip_issue_id\s*:\s*[^\n]*\n?/gim, "")
    .replace(/^paperclip_identifier\s*:\s*[^\n]*\n?/gim, "")
    .replace(/\n{3,}/g, "\n\n");
}

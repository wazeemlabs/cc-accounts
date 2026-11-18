// The Claude in Chrome extension after a move to another account.
//
// The extension is signed in to one claude.ai account, and Claude Code lists
// only the browsers whose extension is signed in to the account and
// organization it runs on itself: "the extension is signed in to a different
// claude.ai account or organization than Claude Code" is the documented cause
// of "Browser extension is not connected" (code.claude.com/docs/en/chrome,
// read 2026-11-18). Another seat of the same organization is another account,
// so a conversation that moves loses its browser, with no setting that keeps
// it. What the plugin can do is say so, to a conversation that used one.

const TOOL = 'mcp__claude-in-chrome__'

export function usesBrowser(tool: string): boolean {
  return tool.startsWith(TOOL)
}

// What a conversation that used the browser tools is told after a move to `to`.
export function browserText(to: string): string {
  return `This conversation used the Claude in Chrome tools, and the extension is tied to one account: they work here only through ` +
    `a Chrome profile whose extension is signed in to the ${to} account. Before the next browser step call list_connected_browsers ` +
    `and select one; if none is listed, tell the person which account's browser is needed and do not try again.`
}

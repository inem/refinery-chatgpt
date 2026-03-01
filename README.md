# Refinery — Extract Value from ChatGPT

Chrome extension to extract, highlight, and organize valuable fragments from ChatGPT conversations.

## The problem

Your best ChatGPT conversations are long. The most valuable insights are buried in a stream of thousands of messages. You can't bookmark them, and copy-pasting loses context.

## How it works

1. Open any ChatGPT conversation
2. Select valuable text in an assistant message
3. Press **Cmd+Shift+E** (or Ctrl+Shift+E on Windows)
4. Done — the fragment is highlighted and saved to your account

Extracted fragments are highlighted in yellow with numbered badges. A navigation ribbon on the right lets you jump between them. When you revisit the conversation, highlights are restored automatically.

## Features

- **Cmd+Shift+E** to extract selected text
- Yellow highlights with numbered badges
- Fragment navigator ribbon (right edge)
- Automatic conversation backups (full JSON, every 60s)
- Sidebar badges showing extract counts per conversation
- Cross-device sync via Google Sign-In

## Install

### From Chrome Web Store
*(Coming soon)*

### From source
1. Clone this repo
2. Go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" → select this folder

## Privacy

Your extracts are stored in a secure database (Supabase) with row-level security. No analytics, no tracking, no data sharing. See [privacy-policy.md](privacy-policy.md).

## Related

- [Unfreeze for ChatGPT](https://github.com/inem/Unfreeze-for-ChatGPT) — makes long conversations load instantly
- [chatgpt-ui.js](https://github.com/inem/chathpt-ui.js) — DOM manipulation library for ChatGPT extensions

## License

MIT

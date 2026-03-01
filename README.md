# Refinery — Save ChatGPT Quotes

Chrome extension to save, highlight, and organize quotes from ChatGPT conversations.

## The problem

You have long ChatGPT conversations full of valuable insights — but they disappear into the scroll. You can't bookmark individual messages, and copy-pasting loses context.

## How it works

1. Open any ChatGPT conversation
2. Select text in an assistant message
3. Press **Cmd+Shift+S** (or Ctrl+Shift+S on Windows)
4. Done — the text is highlighted and saved to your account

Your quotes are highlighted in yellow with numbered badges. A navigation ribbon on the right lets you jump between saved quotes. When you revisit the conversation, highlights are restored automatically.

## Features

- **Cmd+Shift+S** to save selected text
- Yellow highlights with numbered badges
- Quote navigator ribbon (right edge)
- Automatic conversation backups (full JSON, every 60s)
- Sidebar badges showing quote counts per conversation
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

Your quotes are stored in a secure database (Supabase) with row-level security. No analytics, no tracking, no data sharing. See [privacy-policy.md](privacy-policy.md).

## Related

- [Unfreeze for ChatGPT](https://github.com/inem/Unfreeze-for-ChatGPT) — makes long conversations load instantly
- [chatgpt-ui.js](https://github.com/inem/chathpt-ui.js) — DOM manipulation library for ChatGPT extensions

## License

MIT

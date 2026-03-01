# Privacy Policy — Refinery: Save ChatGPT Quotes

**Last updated:** March 1, 2026

## What this extension does

Refinery lets you select and save quotes from ChatGPT conversations. Saved quotes are highlighted in the conversation and synced to your personal account for later reference.

## Data collected

When you use Refinery, the following data is stored on our servers:

- **Quotes you save** — the selected text and its position in the conversation
- **Conversation metadata** — ChatGPT conversation URL and title (to organize your quotes)
- **Conversation backups** — full conversation JSON (for quote context and search)
- **Your email address** — via Google Sign-In, to identify your account

## How data is stored

- Data is stored in a Supabase database with row-level security
- Each user can only access their own data
- Data is transmitted over HTTPS
- No data is shared with third parties

## What we do NOT do

- No analytics or tracking
- No advertising
- No selling or sharing of your data
- No access to your data by anyone other than you

## Data deletion

To delete your data, sign out from the extension popup and contact us at the email below. We will delete all your data within 30 days.

## Permissions used

- **storage** — to cache quotes locally for faster loading
- **activeTab** — to read selected text on the active ChatGPT tab
- **identity** — for Google Sign-In authentication
- **Host access to chatgpt.com** — to inject the content script

## Contact

For questions about this privacy policy: https://github.com/inem/refinery-chatgpt

## Changes

Any changes to this policy will be posted in the extension's GitHub repository.

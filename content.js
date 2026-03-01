// Refinery Extract — content script
// Source: chatgpt-extension/src/content.js (rewritten)
// Changes:
//   1. Removed inlined ChatGPTUI (~500 lines) → use shared chatgpt-ui.js
//   2. Added postMessage listener for Refinery Simple data (full conversation)
//   3. parseConversationMessages() uses postMessage data, fallback to DOM
//   4. showToast() delegates to ChatGPTUI.showToast()

console.log('[refinery-extract] content script loaded');

// ChatGPTUI is loaded by manifest (chatgpt-ui.js runs before content.js)
const ChatGPTUI = window.ChatGPTUI;

// === Refinery Simple integration ===
// Refinery Simple (MAIN world) sends full conversation data via postMessage.
// We listen here (ISOLATED world) to get untruncated messages for dump.
let refinerySimpleData = null;

window.addEventListener('message', (event) => {
  if (event.data?.source === 'refinery-003' && event.data?.type === 'SYNC_CONVERSATION') {
    refinerySimpleData = event.data.data;
    console.log('[refinery-extract] received full conversation from Refinery Simple:',
      refinerySimpleData.messages?.length, 'messages');
  }
});

// State
let existingQuotes = [];

// XPath utilities for range serialization
function getXPath(node) {
  const parts = [];
  for (; node && (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE); node = node.parentNode) {
    let index = 1;
    const nodeName = node.nodeType === Node.TEXT_NODE ? 'text()' : node.nodeName.toLowerCase();

    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.nodeType === node.nodeType && sibling.nodeName === node.nodeName) {
        index++;
      }
    }

    parts.unshift(`${nodeName}[${index}]`);
  }
  return '/' + parts.join('/');
}

function serializeRange(range) {
  return {
    startPath: getXPath(range.startContainer),
    startOffset: range.startOffset,
    endPath: getXPath(range.endContainer),
    endOffset: range.endOffset,
  };
}

function deserializeRange(serialized) {
  try {
    const evaluator = new XPathEvaluator();
    const startResult = evaluator.evaluate(serialized.startPath, document.documentElement, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const endResult = evaluator.evaluate(serialized.endPath, document.documentElement, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);

    if (!startResult.singleNodeValue || !endResult.singleNodeValue) {
      return null;
    }

    const range = document.createRange();
    range.setStart(startResult.singleNodeValue, serialized.startOffset);
    range.setEnd(endResult.singleNodeValue, serialized.endOffset);
    return range;
  } catch (e) {
    console.log('Failed to deserialize range:', e);
    return null;
  }
}

// Initialize
function init() {
  setupSaveInPopup();
  setupKeyboardShortcut();

  // Load existing quotes after page settles
  setTimeout(loadExistingQuotes, 800);
}

// Add Save button to the selection popup (next to "Ask ChatGPT")
function setupSaveInPopup() {
  ChatGPTUI.addSelectionPopupButton({
    id: 'refinery-save',
    icon: '📑',
    label: 'Extract',
    onClick: async ({ text, html, range }) => {

      if (!text || text.length < 3) {
        showToast('Select more text', true);
        return;
      }

      const messageEl = findAssistantMessage(range?.commonAncestorContainer);
      if (!messageEl) {
        showToast('Select text from assistant message', true);
        return;
      }

      // Serialize range BEFORE async call (range might become invalid after)
      const serializedRange = serializeRange(range);

      // Also try to highlight BEFORE async call while range is still valid
      let highlighted = false;
      try {
        highlighted = highlightRange(range);
      } catch (e) {
      }

      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_QUOTE',
        data: {
          text,
          html,
          type: 'selection',
          url: window.location.href,
          title: getConversationTitle(),
          positionSelector: JSON.stringify(serializedRange),
        },
      });

      if (response.success) {
        showToast('Quote saved!');

        const quoteId = response.quoteId;
        if (response.conversationId) {
          currentConversationId = response.conversationId;
        }

        if (!highlighted) {
          // Create highlight with quoteId
          try {
            const restoredRange = deserializeRange(serializedRange);
            if (restoredRange) {
              highlightRange(restoredRange, quoteId);
            }
          } catch (e) {
          }
        } else {
          // Find all highlights we created before (without quoteId yet) and add quoteId to all
          const marks = document.querySelectorAll('mark:not([data-quote-id])');
          marks.forEach(mark => {
            mark.dataset.quoteId = quoteId;
          });
          if (marks.length > 0) {
            addDeleteButton(marks[marks.length - 1], quoteId);
          }
        }

        loadConversationCounts();
        updateQuoteNavigator();
        updateAllBadgeNumbers();
        addRefineButton();
      } else {
        showToast(response.error || 'Failed to save', true);
      }

      window.getSelection()?.removeAllRanges();
    },
  });
}

// Setup keyboard shortcut (Cmd/Ctrl+Shift+S to save selection)
function setupKeyboardShortcut() {
  document.addEventListener('keydown', async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();

      const selection = window.getSelection();
      const text = selection?.toString().trim();
      if (!text || text.length < 3) return;

      const range = selection.getRangeAt(0);
      const messageEl = findAssistantMessage(range.commonAncestorContainer);
      if (!messageEl) return;

      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      const html = container.innerHTML;

      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_QUOTE',
        data: {
          text,
          html,
          type: 'selection',
          url: window.location.href,
          title: getConversationTitle(),
          positionSelector: JSON.stringify(serializeRange(range)),
        },
      });

      if (response.success) {
        showToast('Quote saved!');
        const quoteId = response.quoteId;
        if (response.conversationId) {
          currentConversationId = response.conversationId;
        }
        try {
          highlightRange(range, quoteId);
        } catch (e) {}
        loadConversationCounts();
        updateQuoteNavigator();
        updateAllBadgeNumbers();
        addRefineButton();
      } else {
        showToast(response.error || 'Failed to save', true);
      }

      window.getSelection()?.removeAllRanges();
    }
  });
}

// Find parent assistant message element
function findAssistantMessage(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    if (el.getAttribute?.('data-message-author-role') === 'assistant') {
      return el;
    }
    // Also check for message containers
    if (el.classList?.contains('markdown') && el.closest('[data-message-author-role="assistant"]')) {
      return el.closest('[data-message-author-role="assistant"]');
    }
    el = el.parentElement;
  }
  return null;
}

// Get conversation title
function getConversationTitle() {
  // Try nav item (current chat)
  const navTitle = document.querySelector('nav [aria-selected="true"]')?.textContent;
  if (navTitle) return navTitle;

  // Try page title
  const title = document.title.replace(' | ChatGPT', '').replace('ChatGPT', '');
  return title.trim() || 'Untitled';
}

// Generate position selector for message
function generatePositionSelector(messageEl) {
  const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
  const index = Array.from(messages).indexOf(messageEl);
  return `assistant-message-${index}`;
}

// Show notification — inline status, same style as Refinery Simple (003)
function showToast(message, isError = false) {
  const id = 'refinery-extract-status';
  ChatGPTUI.setInlineStatus(message, { id });
  ChatGPTUI.hideInlineStatus(id, 2000);
}

// Colors for alternating quotes
const QUOTE_COLORS = [
  { bg: '#fed7aa', line: '#f97316' }, // Orange
  { bg: '#fef08a', line: '#eab308' }, // Yellow
];

function getQuoteColor(index) {
  return QUOTE_COLORS[index % 2];
}

// Get highlight styles - fixed color to avoid expensive lookups
function getHighlightStyle() {
  return `background-color: ${QUOTE_COLORS[0].bg} !important; border-radius: 2px;`;
}

// Add quote number badge and delete button after highlight
function addDeleteButton(highlight, quoteId) {
  // Container for badge and delete - inserted after the highlight
  const controls = document.createElement('span');
  controls.className = 'cgq-highlight-controls';
  controls.dataset.forQuote = quoteId;
  controls.style.cssText = `
    display: inline;
    user-select: none;
    white-space: nowrap;
  `;

  // Quote number badge
  const badge = document.createElement('span');
  badge.className = 'cgq-highlight-badge';
  badge.style.cssText = `
    font-size: 10px;
    color: #f97316;
    font-weight: 600;
    cursor: pointer;
    opacity: 0.8;
    transition: opacity 0.2s;
    vertical-align: super;
    margin-left: 3px;
    padding: 1px 4px;
    border: 1px solid rgba(249, 115, 22, 0.4);
    border-radius: 3px;
  `;
  badge.title = 'Click to scroll to center';

  // Badge number will be set by updateAllBadgeNumbers()

  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    scrollToQuote(highlight);
  });

  badge.addEventListener('mouseenter', () => badge.style.opacity = '1');
  badge.addEventListener('mouseleave', () => badge.style.opacity = '0.8');

  // Delete button
  const deleteBtn = document.createElement('sup');
  deleteBtn.className = 'cgq-highlight-delete';
  deleteBtn.innerHTML = '×';
  deleteBtn.title = 'Remove quote';
  deleteBtn.style.cssText = `
    cursor: pointer;
    opacity: 0.4;
    font-size: 9px;
    font-weight: bold;
    color: #666;
    transition: opacity 0.2s;
    vertical-align: super;
    margin-left: 1px;
  `;

  deleteBtn.addEventListener('mouseenter', () => deleteBtn.style.opacity = '1');
  deleteBtn.addEventListener('mouseleave', () => deleteBtn.style.opacity = '0.4');

  deleteBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Remove from server
    if (quoteId) {
      const response = await chrome.runtime.sendMessage({ type: 'DELETE_QUOTE', quoteId });
      if (response.success) {
        await removeQuoteFromCache(quoteId);
        loadConversationCounts();
      }
    }

    // Remove controls
    document.querySelectorAll(`[data-for-quote="${quoteId}"]`).forEach(c => c.remove());

    // Remove all highlights with this quoteId
    document.querySelectorAll(`[data-quote-id="${quoteId}"]`).forEach(h => {
      const parent = h.parentNode;
      while (h.firstChild) parent.insertBefore(h.firstChild, h);
      h.remove();
    });

    updateQuoteNavigator();
    updateAllBadgeNumbers();
    addRefineButton();
    showToast('Quote removed');
  });

  controls.appendChild(badge);
  controls.appendChild(deleteBtn);

  // Insert after the highlight
  highlight.after(controls);
}

// Update all badge numbers (call after all quotes are loaded)
function updateAllBadgeNumbers() {
  const highlights = getQuoteHighlights();
  document.querySelectorAll('.cgq-highlight-badge').forEach(badge => {
    const controls = badge.closest('.cgq-highlight-controls');
    if (!controls) return;
    const quoteId = controls.dataset.forQuote;
    const index = highlights.findIndex(h => h.dataset.quoteId === quoteId);
    badge.textContent = index >= 0 ? (index + 1) : '';
  });
}


// Highlight text range with optional delete button
function highlightRange(range, quoteId = null) {

  if (!range) {
    return false;
  }

  // Verify range is still valid
  try {
    const testText = range.toString();
    if (!testText) {
      return false;
    }
  } catch (e) {
    return false;
  }

  try {
    const clonedRange = range.cloneRange();
    const highlight = document.createElement('mark');
    highlight.style.cssText = getHighlightStyle();
    if (quoteId) highlight.dataset.quoteId = quoteId;
    clonedRange.surroundContents(highlight);
    if (quoteId) {
      addDeleteButton(highlight, quoteId);
    }
    return true;
  } catch (e) {
    // Range crosses element boundaries
    try {
      const textNodes = getTextNodesInRange(range);
      if (textNodes.length === 0) {
        return false;
      }
      let lastSpan = null;
      textNodes.forEach((node) => {
        const span = document.createElement('mark');
        span.style.cssText = getHighlightStyle();
        if (quoteId) span.dataset.quoteId = quoteId;
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        nodeRange.surroundContents(span);
        lastSpan = span;
      });
      if (quoteId && lastSpan) {
        addDeleteButton(lastSpan, quoteId);
      }
      return true;
    } catch (e2) {
      return false;
    }
  }
}

// Get all text nodes within a range
function getTextNodesInRange(range) {
  const textNodes = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );

  let node;
  while (node = walker.nextNode()) {
    if (node.textContent.trim()) {
      textNodes.push(node);
    }
  }
  return textNodes;
}

// Wait for messages to appear in DOM
function waitForMessages(maxWait = 10000) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const check = () => {
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      if (messages.length > 0) {
        console.log('Found', messages.length, 'messages after', Date.now() - startTime, 'ms');
        resolve(messages);
        return;
      }

      if (Date.now() - startTime > maxWait) {
        console.log('Timeout waiting for messages');
        resolve(null);
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

// Get URL without hash (for consistent caching/matching)
function getCleanUrl() {
  return window.location.href.split('#')[0];
}

// Get cache key for current URL
function getQuotesCacheKey() {
  return `quotes_${getCleanUrl()}`;
}

// Load and highlight existing quotes (with caching)
// Track restore results for debugging
let restoreResults = { success: 0, failed: 0, failedQuotes: [] };

async function loadExistingQuotes() {
  console.log('[Refinery] loadExistingQuotes called, URL:', window.location.href);

  // Reset restore tracking
  restoreResults = { success: 0, failed: 0, failedQuotes: [] };

  // Wait for messages to appear first
  const messages = await waitForMessages();
  if (!messages) {
    console.log('[Refinery] No messages found on page');
    return;
  }

  const cacheKey = getQuotesCacheKey();

  // 1. Load from cache first (instant)
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]?.length) {
      console.log('[Refinery] Restoring', cached[cacheKey].length, 'quotes from cache');
      existingQuotes = cached[cacheKey];
      for (const quote of existingQuotes) {
        await highlightExistingQuote(quote);
      }
      logRestoreResults('cache');
      setTimeout(() => {
        updateAllBadgeNumbers();
        updateQuoteNavigator();
        addRefineButton();
      }, 50);
    }
  } catch (e) {
    console.log('[Refinery] Cache read error:', e.message);
  }

  // 2. Fetch fresh from server
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_QUOTES',
      url: getCleanUrl(),
    });

    console.log('[Refinery] GET_QUOTES response:', response?.quotes?.length, 'quotes');

    if (!response?.success) {
      return;
    }

    // Store conversation ID for Refine button
    if (response.conversationId) {
      currentConversationId = response.conversationId;
    }

    const serverQuotes = response.quotes || [];
    const cacheIds = new Set(existingQuotes.map(q => q.id));
    const serverIds = new Set(serverQuotes.map(q => q.id));

    // Check for deleted quotes (in cache but not on server)
    const deletedIds = [...cacheIds].filter(id => !serverIds.has(id));
    if (deletedIds.length > 0) {
      console.log('[Refinery] Quotes deleted on server:', deletedIds);
      // Remove highlights, controls, and sidebar lines for deleted quotes
      deletedIds.forEach(id => {
        // Remove sidebar lines and controls
        document.querySelectorAll(`[data-for-quote="${id}"]`).forEach(el => el.remove());
        // Remove highlight marks
        document.querySelectorAll(`mark[data-quote-id="${id}"]`).forEach(el => {
          const parent = el.parentNode;
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          el.remove();
        });
      });
      updateQuoteNavigator();
    }

    // Check for new quotes (on server but not in cache)
    const newQuotes = serverQuotes.filter(q => !cacheIds.has(q.id));
    if (newQuotes.length > 0) {
      console.log('[Refinery] New quotes from server:', newQuotes.length);
      restoreResults = { success: 0, failed: 0, failedQuotes: [] };
      for (const quote of newQuotes) {
        await highlightExistingQuote(quote);
      }
      logRestoreResults('server-new');
      setTimeout(() => {
        updateAllBadgeNumbers();
        updateQuoteNavigator();
        addRefineButton();
      }, 50);
    }

    // 3. Update cache
    await chrome.storage.local.set({ [cacheKey]: serverQuotes });
    existingQuotes = serverQuotes;

  } catch (e) {
    console.log('[Refinery] Failed to load quotes from server:', e.message);
  }
}

function logRestoreResults(source) {
  const { success, failed, failedQuotes } = restoreResults;
  console.log(`[Refinery] Restore from ${source}: ${success} succeeded, ${failed} failed`);
  if (failedQuotes.length > 0) {
    console.group('[Refinery] Failed to restore:');
    failedQuotes.forEach(q => {
      console.log(`- ID: ${q.id}`);
      console.log(`  Text: "${q.text?.substring(0, 100)}..."`);
      console.log(`  Selector: ${q.position_selector?.substring(0, 100)}`);
    });
    console.groupEnd();
  }
}

// Update quotes cache after save
async function addQuoteToCache(quote) {
  const cacheKey = getQuotesCacheKey();
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    const quotes = cached[cacheKey] || [];
    quotes.unshift(quote);
    await chrome.storage.local.set({ [cacheKey]: quotes });
  } catch (e) {
    console.log('Cache update error:', e.message);
  }
}

// Remove quote from cache after delete
async function removeQuoteFromCache(quoteId) {
  const cacheKey = getQuotesCacheKey();
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    const quotes = (cached[cacheKey] || []).filter(q => q.id !== quoteId);
    await chrome.storage.local.set({ [cacheKey]: quotes });
  } catch (e) {
    console.log('Cache update error:', e.message);
  }
}

// Highlight an existing quote
async function highlightExistingQuote(quote) {
  const { id, position_selector, text, type } = quote;
  console.log('highlightExistingQuote:', { id, type, textPreview: text?.substring(0, 50) });

  // Check if this is new format (has XPath)
  let isNewFormat = false;
  try {
    const serialized = JSON.parse(position_selector);
    if (serialized.startPath && serialized.endPath) {
      isNewFormat = true;
      const range = deserializeRange(serialized);
      if (range) {
        const result = highlightRange(range, id);
        if (result) {
          restoreResults.success++;
          return;
        }
      } else {
      }
    }
  } catch (e) {
  }

  // Fallback: search for text in all assistant messages
  const messages = document.querySelectorAll('[data-message-author-role="assistant"]');

  for (const messageEl of messages) {
    if (type === 'full_response') {
      messageEl.style.backgroundColor = '#fed7aa';
      restoreResults.success++;
      return;
    }

    const result = highlightTextInElement(messageEl, text, id);
    if (result.success) {
      restoreResults.success++;

      // Upgrade old quotes with new XPath selector
      if (!isNewFormat && result.range) {
        try {
          const newSelector = JSON.stringify(serializeRange(result.range));
          chrome.runtime.sendMessage({
            type: 'UPDATE_QUOTE_SELECTOR',
            quoteId: id,
            positionSelector: newSelector,
          });
        } catch (e) {
        }
      }
      return;
    }
  }

  console.log('[Refinery] Could not restore highlight for quote', id, '- text:', text?.substring(0, 80));
  restoreResults.failed++;
  restoreResults.failedQuotes.push(quote);
}

// Highlight text within an element (finds start and end to highlight full block)
// Returns { success: boolean, range?: Range } for upgrade purposes
function highlightTextInElement(element, searchText, quoteId = null) {
  if (!searchText || searchText.length < 10) return { success: false };

  // Get start snippet (first 30 chars of first line)
  const lines = searchText.split('\n').filter(l => l.trim());
  const startSnippet = lines[0]?.trim().substring(0, 30);

  // Get end snippet (last 30 chars of last line)
  const lastLine = lines[lines.length - 1]?.trim() || '';
  const endSnippet = lastLine.substring(Math.max(0, lastLine.length - 30));


  if (!startSnippet || startSnippet.length < 10) return { success: false };

  // Collect all text nodes
  const textNodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walker.nextNode()) {
    if (node.textContent.trim()) textNodes.push(node);
  }

  // Find start node and position
  let startNode = null, startOffset = 0;
  for (const n of textNodes) {
    const idx = n.textContent.indexOf(startSnippet);
    if (idx !== -1) {
      startNode = n;
      startOffset = idx;
      break;
    }
  }

  if (!startNode) {
    return { success: false };
  }

  // Find end node and position
  let endNode = null, endOffset = 0;
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const n = textNodes[i];
    const idx = n.textContent.lastIndexOf(endSnippet);
    if (idx !== -1) {
      endNode = n;
      endOffset = idx + endSnippet.length;
      break;
    }
  }

  // If no end found, use end of start node
  if (!endNode) {
    endNode = startNode;
    endOffset = startNode.textContent.length;
  }

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    const rangeForUpgrade = range.cloneRange();

    // If range spans multiple nodes, highlight each
    let lastHighlight = null;
    if (startNode === endNode) {
      const highlight = document.createElement('mark');
      highlight.className = 'cgq-highlight';
      highlight.style.cssText = getHighlightStyle();
      if (quoteId) highlight.dataset.quoteId = quoteId;
      range.surroundContents(highlight);
      lastHighlight = highlight;
    } else {
      // Multi-node: collect info first, then modify DOM
      const nodesInRange = getTextNodesInRange(range);

      // Build list of {node, start, end} before modifying anything
      const wraps = nodesInRange.map(n => ({
        node: n,
        start: n === startNode ? startOffset : 0,
        end: n === endNode ? endOffset : n.textContent.length,
      }));

      wraps.forEach(({ node, start, end }) => {
        const span = document.createElement('mark');
        span.className = 'cgq-highlight';
        span.style.cssText = getHighlightStyle();
        if (quoteId) span.dataset.quoteId = quoteId;

        const nodeRange = document.createRange();
        nodeRange.setStart(node, start);
        nodeRange.setEnd(node, end);

        try {
          nodeRange.surroundContents(span);
          lastHighlight = span;
        } catch (e) {
        }
      });
    }

    // Add delete button to last highlight
    if (quoteId && lastHighlight) {
      addDeleteButton(lastHighlight, quoteId);
    }

    return { success: true, range: rangeForUpgrade };
  } catch (e) {
    return { success: false };
  }
}

// Extract text from API message content object
function extractMessageText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.parts) {
    return content.parts
      .filter(p => typeof p === 'string')
      .join('\n');
  }
  return '';
}

// Parse all messages from the conversation
// Prefers full data from Refinery Simple (via postMessage) over DOM parsing.
// DOM data may be truncated when Refinery Simple is active.
function parseConversationMessages() {
  // Use full data from Refinery Simple when available
  if (refinerySimpleData?.messages?.length > 0) {
    console.log('[refinery-extract] using postMessage data:', refinerySimpleData.messages.length, 'messages');
    return refinerySimpleData.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, index) => ({
        index,
        role: m.role,
        text: extractMessageText(m.content),
        html: '', // no HTML from API data
      }))
      .filter(m => m.text);
  }

  // Fallback: parse from DOM (may be truncated by Refinery Simple)
  console.log('[refinery-extract] no postMessage data, falling back to DOM parsing');
  const messages = [];
  const messageEls = document.querySelectorAll('[data-message-author-role]');

  messageEls.forEach((el, index) => {
    const role = el.getAttribute('data-message-author-role');
    const contentEl = el.querySelector('.markdown') || el;
    const text = contentEl?.textContent?.trim() || '';

    if (text) {
      messages.push({
        index,
        role,
        text,
        html: contentEl?.innerHTML || '',
      });
    }
  });

  return messages;
}

// Add "Dump" button to top header using ChatGPTUI library
function addDumpButton() {
  ChatGPTUI.addTopHeaderButton({
    id: 'refinery-dump',
    icon: '<span style="font-size: 160%; position: relative; top: -1px;">⊚</span>',
    label: 'Dump',
    title: 'Save conversation dump',
    onClick: async (e) => {
      const btn = e.target.closest('button');
      const labelEl = btn.querySelector('span:last-child');
      const originalLabel = labelEl?.textContent;
      if (labelEl) labelEl.textContent = 'Saving...';
      btn.disabled = true;

      const messages = parseConversationMessages();

      if (messages.length === 0) {
        showToast('No messages to save', true);
        btn.disabled = false;
        if (labelEl) labelEl.textContent = originalLabel;
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_CONVERSATION_BACKUP',
        data: {
          url: window.location.href,
          title: getConversationTitle(),
          messages,
        },
      });

      if (response.success) {
        if (response.skipped) {
          showToast(`No changes since #${response.version}`);
        } else {
          showToast(`Dump saved! (#${response.version}, ${messages.length} messages)`);
        }
      } else {
        showToast(response.error || 'Failed to save', true);
      }

      btn.disabled = false;
      if (labelEl) labelEl.textContent = originalLabel;
    },
  });
}

// Store conversation ID from backend
let currentConversationId = null;

// Add Refine button (always visible, dimmed when < 5 quotes)
function addRefineButton() {
  const quoteCount = getQuoteHighlights().length;
  const isActive = quoteCount >= 5;

  // Use stored conversation ID, or extract from URL as fallback
  let conversationId = currentConversationId;
  if (!conversationId) {
    const match = window.location.href.match(/\/c\/([a-f0-9-]+)/);
    conversationId = match?.[1];
  }

  // Update existing button if present
  const existing = document.querySelector('[data-cgq-id="refinery-refine"]');
  if (existing) {
    const badgeEl = existing.querySelector('.refinery-badge');
    if (badgeEl) {
      badgeEl.textContent = quoteCount || '0';
      badgeEl.style.background = isActive ? '#f97316' : '#d1d5db';
      badgeEl.style.color = isActive ? 'white' : '#9ca3af';
    }
    existing.style.opacity = isActive ? '1' : '0.5';
    return;
  }

  const badgeColor = isActive ? '#f97316' : '#d1d5db';
  const badgeTextColor = isActive ? 'white' : '#9ca3af';

  const btn = ChatGPTUI.addTopHeaderButton({
    id: 'refinery-refine',
    icon: `<span class="refinery-badge" style="background: ${badgeColor}; color: ${badgeTextColor}; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 10px; min-width: 18px; text-align: center; display: inline-block; position: relative; top: -1px;">${quoteCount || '0'}</span>`,
    label: 'Refine',
    title: 'Open in Refinery board',
    onClick: () => {
      if (conversationId) {
        window.open(`https://refinery.my/conversation/${conversationId}`, '_blank');
      }
    },
  });

  if (btn) {
    btn.style.opacity = isActive ? '1' : '0.5';
    // Always place Refine at the leftmost position in header actions
    const container = document.querySelector('#conversation-header-actions');
    if (container) {
      container.insertBefore(btn, container.firstChild);
    }
  }
}

// === Auto-dump: silently save conversation on navigation and periodically ===
// Projection of refinery-001/060-auto-ingest.edn:
//   auto-dump :depends-on :content-script
//   auto-dump :reduces-to :auto-ingest
// Dedup handled by background.js (checks message count + last message)

let autoDumpTimer = null;
const AUTO_DUMP_INTERVAL_MS = 60000; // check every 60s

async function autoDump() {
  // Only dump if we're on a conversation page
  if (!window.location.href.match(/\/(c|g)\/[a-f0-9-]/)) return;

  const messages = parseConversationMessages();
  if (messages.length < 2) return; // skip empty/trivial

  try {
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONVERSATION_BACKUP',
      data: {
        url: window.location.href,
        title: getConversationTitle(),
        messages,
      },
    });
    // Silent — no toast. Dedup in background.js skips if unchanged.
  } catch (e) {
    // Extension context invalidated, page reload, etc. — ignore silently
  }
}

function startAutoDumpTimer() {
  if (autoDumpTimer) clearInterval(autoDumpTimer);
  autoDumpTimer = setInterval(autoDump, AUTO_DUMP_INTERVAL_MS);
}

// Initialize dump button and watch for SPA navigation (button gets removed when ChatGPT changes conversation)
let lastUrl = window.location.href;
function initDumpButton() {
  addRefineButton();
  addDumpButton();
}

function watchForNavigation() {
  // Check periodically if URL changed or button disappeared
  setInterval(() => {
    const currentUrl = window.location.href;
    const buttonExists = document.querySelector('[data-cgq-id="refinery-dump"]');
    const shareExists = document.querySelector('[data-testid="share-chat-button"]');

    if (currentUrl !== lastUrl) {
      // Auto-dump the PREVIOUS conversation before switching
      autoDump();

      lastUrl = currentUrl;
      // URL changed - reset state
      resetQuoteNavigator();
      currentConversationId = null;
      refinerySimpleData = null; // clear stale data from previous conversation
      setTimeout(async () => {
        addRefineButton();
        addDumpButton();
        addSidebarFilterToggle();
        await loadExistingQuotes();
        updateQuoteNavigator();
        addRefineButton(); // Update after quotes loaded
        loadConversationCounts();
      }, 500);
    } else {
      // Re-add UI elements if they disappeared
      if (!buttonExists && shareExists) {
        addRefineButton();
        addDumpButton();
      }
      const filterToggleExists = document.querySelector('[data-cgq-id="filter-toggle"]');
      if (!filterToggleExists) {
        addSidebarFilterToggle();
      }
    }
  }, 1000);
}

setTimeout(() => {
  initDumpButton();
  watchForNavigation();
  startAutoDumpTimer();
}, 500);

// Sidebar quote count badges with caching
let conversationCounts = {};
let showOnlyWithQuotes = false;

// Add filter toggle to sidebar
function addSidebarFilterToggle() {
  const sidebar = document.querySelector('nav[aria-label="Chat history"]');
  if (!sidebar) {
    setTimeout(addSidebarFilterToggle, 1000);
    return;
  }

  if (document.querySelector('[data-cgq-id="filter-toggle"]')) return;

  // Find "Your chats" h2 header
  const h2Elements = sidebar.querySelectorAll('h2.__menu-label');
  let yourChatsH2 = null;
  for (const h of h2Elements) {
    if (h.textContent?.trim().toLowerCase() === 'your chats') {
      yourChatsH2 = h;
      break;
    }
  }

  if (!yourChatsH2) {
    // Retry later if not found yet
    setTimeout(addSidebarFilterToggle, 1000);
    return;
  }

  const container = document.createElement('label');
  container.dataset.cgqId = 'filter-toggle';
  container.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    cursor: pointer;
    font-size: 11px;
    color: var(--text-tertiary, #888);
    user-select: none;
    vertical-align: middle;
  `;

  // Switch track (smaller for inline)
  const track = document.createElement('div');
  track.style.cssText = `
    width: 28px;
    height: 16px;
    background: #d1d5db;
    border-radius: 8px;
    position: relative;
    transition: background 0.2s;
    flex-shrink: 0;
  `;

  // Switch thumb
  const thumb = document.createElement('div');
  thumb.style.cssText = `
    width: 12px;
    height: 12px;
    background: white;
    border-radius: 50%;
    position: absolute;
    top: 2px;
    left: 2px;
    transition: transform 0.2s;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  `;

  track.appendChild(thumb);

  const label = document.createElement('span');
  label.textContent = 'quotes';
  label.style.opacity = '0.7';

  const updateUI = () => {
    if (showOnlyWithQuotes) {
      track.style.background = '#f97316';
      thumb.style.transform = 'translateX(12px)';
      label.style.opacity = '1';
    } else {
      track.style.background = '#d1d5db';
      thumb.style.transform = 'translateX(0)';
      label.style.opacity = '0.7';
    }
  };

  updateUI();

  container.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showOnlyWithQuotes = !showOnlyWithQuotes;
    updateUI();
    filterSidebarChats();
  });

  container.appendChild(track);
  container.appendChild(label);

  // Insert after the h2 text, inside the button
  yourChatsH2.after(container);
}

// Filter sidebar chats based on toggle
let isFilteringInProgress = false;

function filterSidebarChats() {
  if (isFilteringInProgress) return;
  isFilteringInProgress = true;

  requestAnimationFrame(() => {
    if (!showOnlyWithQuotes) {
      ChatGPTUI.showAllSidebarChats();
    } else {
      ChatGPTUI.filterSidebarChats(chat => {
        // Check multiple URL formats (full URL, simple /c/ URL, openai.com variant)
        const urls = [
          chat.url,
          chat.simpleUrl,
          chat.url?.replace('chatgpt.com', 'chat.openai.com'),
          chat.simpleUrl?.replace('chatgpt.com', 'chat.openai.com'),
        ].filter(Boolean);

        return urls.some(url => conversationCounts[url] > 0);
      });
    }

    // Reset flag after a short delay to allow DOM to settle
    setTimeout(() => {
      isFilteringInProgress = false;
    }, 100);
  });
}

async function loadConversationCounts() {
  try {
    // 1. Load from cache first (instant)
    const cached = await chrome.storage.local.get('conversationCounts');
    if (cached.conversationCounts) {
      conversationCounts = cached.conversationCounts;
      updateSidebarBadges();
      filterSidebarChats();
    }

    // 2. Fetch fresh data from server
    const response = await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION_COUNTS' });
    if (response.success) {
      // 3. Update cache
      await chrome.storage.local.set({ conversationCounts: response.counts });

      // 4. Update UI if data changed
      if (JSON.stringify(conversationCounts) !== JSON.stringify(response.counts)) {
        conversationCounts = response.counts;
        updateSidebarBadges();
        filterSidebarChats();
      }
    }
  } catch (e) {
    // Ignore errors
  }
}

function updateSidebarBadges() {
  const chats = ChatGPTUI.getSidebarChats();

  chats.forEach(chat => {
    // Check multiple URL formats
    const urls = [
      chat.url,
      chat.simpleUrl,
      chat.url?.replace('chatgpt.com', 'chat.openai.com'),
      chat.simpleUrl?.replace('chatgpt.com', 'chat.openai.com'),
    ].filter(Boolean);

    const count = urls.reduce((c, url) => c || conversationCounts[url], 0);

    const textContainer = chat.link.querySelector('div');
    if (textContainer) {
      ChatGPTUI.addChatBadge(textContainer, count, { color: '#f97316' });
    }
  });
}

// Initialize sidebar badges and filter toggle
setTimeout(() => {
  addSidebarFilterToggle();
  loadConversationCounts();
  ChatGPTUI.onSidebarChange(() => {
    updateSidebarBadges();
    filterSidebarChats();
  }, 300);
}, 800);

// Quote navigator (floating ribbon showing quote positions)
let currentQuoteIndex = -1;

function createQuoteNavigator() {
  if (document.querySelector('[data-cgq-id="quote-navigator"]')) return;

  const nav = document.createElement('div');
  nav.dataset.cgqId = 'quote-navigator';
  nav.style.cssText = `
    position: fixed;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    padding: 4px 0;
    z-index: 1000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  `;

  const btnStyle = `
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    padding: 4px 8px;
    font-size: 10px;
    transition: color 0.15s;
  `;

  // Arrow up - previous quote
  const btnUp = document.createElement('button');
  btnUp.innerHTML = '▲';
  btnUp.title = 'Previous quote';
  btnUp.style.cssText = btnStyle;
  btnUp.addEventListener('mouseenter', () => btnUp.style.color = '#374151');
  btnUp.addEventListener('mouseleave', () => btnUp.style.color = '#6b7280');
  btnUp.addEventListener('click', () => navigateQuotes(-1));

  // Ribbon container (viewport)
  const ribbon = document.createElement('div');
  ribbon.className = 'quote-nav-ribbon';
  ribbon.style.cssText = `
    overflow: hidden;
    height: 130px;
  `;

  // Inner container for items
  const ribbonInner = document.createElement('div');
  ribbonInner.className = 'quote-nav-ribbon-inner';
  ribbonInner.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    transition: transform 0.2s ease-out;
  `;
  ribbon.appendChild(ribbonInner);

  // Arrow down - next quote
  const btnDown = document.createElement('button');
  btnDown.innerHTML = '▼';
  btnDown.title = 'Next quote';
  btnDown.style.cssText = btnStyle;
  btnDown.addEventListener('mouseenter', () => btnDown.style.color = '#374151');
  btnDown.addEventListener('mouseleave', () => btnDown.style.color = '#6b7280');
  btnDown.addEventListener('click', () => navigateQuotes(1));

  nav.appendChild(btnUp);
  nav.appendChild(ribbon);
  nav.appendChild(btnDown);
  document.body.appendChild(nav);

  updateQuoteNavigator();
}

function getQuoteHighlights() {
  const marks = document.querySelectorAll('mark[data-quote-id]');
  const seen = new Set();
  const uniqueQuotes = [];

  for (const mark of marks) {
    const quoteId = mark.dataset.quoteId;
    if (!seen.has(quoteId)) {
      seen.add(quoteId);
      uniqueQuotes.push(mark);
    }
  }

  return uniqueQuotes;
}

const ITEM_HEIGHT = 17;
const VISIBLE_ITEMS = 7;
const RIBBON_HEIGHT = 130;

function updateQuoteNavigator() {
  const nav = document.querySelector('[data-cgq-id="quote-navigator"]');
  if (!nav) return;

  const ribbon = nav.querySelector('.quote-nav-ribbon');
  if (!ribbon) return;
  const ribbonInner = ribbon.querySelector('.quote-nav-ribbon-inner');
  if (!ribbonInner) return;
  const highlights = getQuoteHighlights();

  if (highlights.length === 0) {
    nav.style.opacity = '0';
    nav.style.pointerEvents = 'none';
    currentQuoteIndex = -1;
    return;
  }

  nav.style.opacity = '1';
  nav.style.pointerEvents = 'auto';

  // Clamp currentQuoteIndex
  if (currentQuoteIndex >= highlights.length) {
    currentQuoteIndex = highlights.length - 1;
  }

  const targetIdx = currentQuoteIndex >= 0 ? currentQuoteIndex : highlights.length - 1;

  // Always rebuild - simpler and avoids drift bugs
  const halfSize = Math.floor(VISIBLE_ITEMS / 2);
  const startIdx = Math.max(0, targetIdx - halfSize);
  const endIdx = Math.min(highlights.length - 1, targetIdx + halfSize);

  ribbonInner.innerHTML = '';

  // Add top dot if showing from start
  const hasTopDot = startIdx === 0;
  if (hasTopDot) {
    ribbonInner.appendChild(createDotItem('top'));
  }

  for (let i = startIdx; i <= endIdx; i++) {
    ribbonInner.appendChild(createClickableItem(i, highlights[i], targetIdx));
  }

  // Add bottom dot if showing to end
  const hasBottomDot = endIdx === highlights.length - 1;
  if (hasBottomDot) {
    ribbonInner.appendChild(createDotItem('bottom'));
  }

  // Center on target
  const topDotOffset = hasTopDot ? 1 : 0;
  const targetPosInList = targetIdx - startIdx + topDotOffset;
  const translateY = (RIBBON_HEIGHT / 2) - (targetPosInList * ITEM_HEIGHT) - (ITEM_HEIGHT / 2);
  ribbonInner.style.transform = `translateY(${translateY}px)`;

  // Update dot active states based on scroll position
  const topDot = ribbonInner.querySelector('.ribbon-dot-top');
  const bottomDot = ribbonInner.querySelector('.ribbon-dot-bottom');
  const viewportCenter = window.innerHeight / 2;

  let topDotActive = false;
  let bottomDotActive = false;

  if (highlights.length > 0) {
    const firstQuote = highlights[0];
    const lastQuote = highlights[highlights.length - 1];
    const firstRect = firstQuote.getBoundingClientRect();
    const lastRect = lastQuote.getBoundingClientRect();

    topDotActive = firstRect.top > viewportCenter;
    bottomDotActive = lastRect.bottom < viewportCenter;
  }

  if (topDot) {
    topDot.style.color = topDotActive ? '#f97316' : '#6b7280';
    topDot.style.fontWeight = topDotActive ? '600' : '400';
  }

  if (bottomDot) {
    bottomDot.style.color = bottomDotActive ? '#f97316' : '#6b7280';
    bottomDot.style.fontWeight = bottomDotActive ? '600' : '400';
  }

  // If dot is active, remove highlight from numbers
  if (topDotActive || bottomDotActive) {
    const items = ribbonInner.querySelectorAll('div:not(.ribbon-dot)');
    items.forEach(item => {
      item.style.color = '#6b7280';
      item.style.fontWeight = '400';
      item.style.background = 'transparent';
    });
  }
}

function createClickableItem(idx, targetEl, currentIdx) {
  const el = createRibbonItem(idx + 1, idx === currentIdx);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    flashHighlight(targetEl);
    currentQuoteIndex = idx;
    updateQuoteNavigator();

    // Scroll and re-check which quote is centered after scroll completes
    scrollToQuote(targetEl, () => {
      const highlights = getQuoteHighlights();
      const viewportCenter = window.innerHeight / 2;
      let closestVisibleIdx = -1;
      let closestDist = Infinity;

      highlights.forEach((h, i) => {
        const rect = h.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          const center = rect.top + rect.height / 2;
          const dist = Math.abs(center - viewportCenter);
          if (dist < closestDist) {
            closestDist = dist;
            closestVisibleIdx = i;
          }
        }
      });

      if (closestVisibleIdx >= 0 && closestVisibleIdx !== currentQuoteIndex) {
        currentQuoteIndex = closestVisibleIdx;
        updateQuoteNavigator();
      }
    });
  });
  return el;
}

function createDotItem(position) {
  const dot = document.createElement('div');
  dot.className = `ribbon-dot ribbon-dot-${position}`;
  dot.textContent = '·';
  dot.style.cssText = `
    font-size: 14px;
    color: #6b7280;
    padding: 2px 6px;
    min-width: 20px;
    text-align: center;
    transition: color 0.15s;
  `;
  return dot;
}

function createRibbonItem(text, isCurrent) {
  const item = document.createElement('div');
  item.textContent = text;
  item.style.cssText = `
    font-size: 10px;
    color: ${isCurrent ? '#f97316' : '#6b7280'};
    font-weight: ${isCurrent ? '600' : '400'};
    cursor: pointer;
    padding: 2px 6px;
    min-width: 20px;
    text-align: center;
    transition: color 0.15s;
    ${isCurrent ? 'background: rgba(249, 115, 22, 0.1); border-radius: 4px;' : ''}
  `;
  item.addEventListener('mouseenter', () => {
    if (!isCurrent) item.style.color = '#374151';
  });
  item.addEventListener('mouseleave', () => {
    if (!isCurrent) item.style.color = '#6b7280';
  });
  return item;
}

// Flag to prevent scroll detection during navigation
let isNavigating = false;

// Scroll to quote element with fade effect to hide double-scroll
function scrollToQuote(element, onComplete) {
  if (!element) return;

  const quoteId = element.dataset?.quoteId;
  const allMarks = quoteId
    ? document.querySelectorAll(`mark[data-quote-id="${quoteId}"]`)
    : [element];
  const targetMark = allMarks.length > 1
    ? allMarks[Math.floor(allMarks.length / 2)]
    : element;

  // Check if element is visible on screen
  const rect = targetMark.getBoundingClientRect();
  const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

  if (isVisible) {
    // Element is on screen - just smooth scroll, no fade needed
    targetMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Smooth scroll takes ~300ms, then call onComplete
    if (onComplete) setTimeout(onComplete, 350);
  } else {
    // Element is off screen - use fade to hide double-scroll
    isNavigating = true;
    const chatArea = document.querySelector('main') || document.body;
    const originalTransition = chatArea.style.transition;
    chatArea.style.transition = 'opacity 0.2s ease-out';
    chatArea.style.opacity = '0';

    setTimeout(() => {
      targetMark.scrollIntoView({ block: 'center' });

      setTimeout(() => {
        targetMark.scrollIntoView({ block: 'center' });

        setTimeout(() => {
          chatArea.style.opacity = '1';

          setTimeout(() => {
            chatArea.style.transition = originalTransition;
            isNavigating = false;
            if (onComplete) onComplete();
          }, 200);
        }, 50);
      }, 150);
    }, 200);
  }
}

function flashHighlight(target) {
  // Flash all marks belonging to the same quote
  const quoteId = target.dataset.quoteId;
  const allMarks = quoteId
    ? document.querySelectorAll(`mark[data-quote-id="${quoteId}"]`)
    : [target];

  // Save original colors (from computed style, not inline)
  const originalBgs = [];
  allMarks.forEach((mark, i) => {
    originalBgs[i] = getComputedStyle(mark).backgroundColor;
    mark.style.backgroundColor = '#fbbf24';
  });

  setTimeout(() => {
    allMarks.forEach((mark, i) => {
      mark.style.backgroundColor = originalBgs[i];
    });
  }, 500);
}

function resetQuoteNavigator() {
  currentQuoteIndex = -1;
  const nav = document.querySelector('[data-cgq-id="quote-navigator"]');
  if (nav) {
    nav.style.opacity = '0';
    nav.style.pointerEvents = 'none';
    const ribbonInner = nav.querySelector('.quote-nav-ribbon-inner');
    if (ribbonInner) ribbonInner.innerHTML = '';
  }
}

function navigateQuotes(direction) {
  const highlights = getQuoteHighlights();
  if (highlights.length === 0) return;

  const newIndex = currentQuoteIndex + direction;

  // At first quote and going up → scroll to page top
  if (newIndex < 0) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  // At last quote and going down → scroll to page bottom
  if (newIndex >= highlights.length) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return;
  }

  currentQuoteIndex = newIndex;
  const target = highlights[currentQuoteIndex];
  if (target) {
    scrollToQuote(target);
    flashHighlight(target);
  }

  updateQuoteNavigator();
}

// Initialize quote navigator
createQuoteNavigator();

// Update current quote index on scroll
// Throttled scroll handler for navigator
let lastScrollUpdate = 0;
window.addEventListener('scroll', () => {
  const now = Date.now();
  if (now - lastScrollUpdate > 100) {
    lastScrollUpdate = now;

    // Skip if we're in the middle of a navigation
    if (isNavigating) return;

    // Find visible quote closest to center
    const highlights = getQuoteHighlights();
    const viewportHeight = window.innerHeight;
    const viewportCenter = viewportHeight / 2;
    let closestVisibleIdx = -1;
    let closestDist = Infinity;

    highlights.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < viewportHeight && rect.bottom > 0) {
        const center = rect.top + rect.height / 2;
        const dist = Math.abs(center - viewportCenter);
        if (dist < closestDist) {
          closestDist = dist;
          closestVisibleIdx = i;
        }
      }
    });

    if (closestVisibleIdx >= 0) {
      currentQuoteIndex = closestVisibleIdx;
    }

    updateQuoteNavigator();
  }
}, true);

// Start
init();

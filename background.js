// Background service worker
import { supabase } from './lib/supabase.js';

// Initialize supabase on load
let initPromise = supabase.init();

// Handle messages from content script and popup
if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Wait for init before handling any message
    initPromise
      .then(() => handleMessage(message, sender))
      .then(sendResponse)
      .catch((error) => {
        console.error('Message handler error:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  });
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'SAVE_QUOTE':
      return saveQuote(message.data);

    case 'GET_QUOTES':
      return getQuotesForUrl(message.url);

    case 'DELETE_QUOTE':
      return deleteQuote(message.quoteId);

    case 'UPDATE_QUOTE_SELECTOR':
      return updateQuoteSelector(message.quoteId, message.positionSelector);

    case 'SAVE_CONVERSATION_BACKUP':
      return saveConversationBackup(message.data);

    case 'GET_USER':
      return getUser();

    case 'SIGN_IN':
      return signIn();

    case 'SIGN_OUT':
      return signOut();

    case 'OPEN_BOARD':
      chrome.tabs.create({ url: 'https://refinery.my' });
      return { success: true };

    case 'GET_STATS':
      return getStats();

    case 'GET_CONVERSATION_COUNTS':
      return getConversationCounts();

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

async function getUser() {
  const user = await supabase.getUser();
  return { success: true, user };
}

async function signIn() {
  try {
    const { user } = await supabase.signInWithGoogle();
    return { success: true, user };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function signOut() {
  await supabase.signOut();
  return { success: true };
}

async function saveQuote({ text, html, type, url, title, positionSelector }) {
  const user = await supabase.getUser();

  if (!user) {
    return { success: false, error: 'Not logged in' };
  }

  try {
    // Get or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('chatgpt_url', url)
      .eq('user_id', user.id)
      .single();

    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({
          user_id: user.id,
          chatgpt_url: url,
          title: title || 'Untitled',
        })
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }
      conversation = newConv;
    } else {
      // Update timestamp
      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation.id);
    }

    // Insert quote and return the created record
    const { data: newQuote, error: quoteError } = await supabase
      .from('quotes')
      .insert({
        conversation_id: conversation.id,
        text,
        html,
        type,
        position_selector: positionSelector,
      })
      .select('id')
      .single();

    if (quoteError) {
      return { success: false, error: quoteError.message };
    }

    return { success: true, quoteId: newQuote?.id, conversationId: conversation.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getQuotesForUrl(url) {
  const user = await supabase.getUser();
  if (!user) {
    return { success: false, quotes: [] };
  }

  try {
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('chatgpt_url', url)
      .eq('user_id', user.id)
      .single();

    if (!conversation) {
      return { success: true, quotes: [], conversationId: null };
    }

    const { data: quotes } = await supabase
      .from('quotes')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false });

    return { success: true, quotes: quotes || [], conversationId: conversation.id };
  } catch (error) {
    return { success: false, quotes: [], error: error.message };
  }
}

async function deleteQuote(quoteId) {
  try {
    await supabase
      .from('quotes')
      .delete()
      .eq('id', quoteId);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function updateQuoteSelector(quoteId, positionSelector) {
  try {
    await supabase
      .from('quotes')
      .update({ position_selector: positionSelector })
      .eq('id', quoteId);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getStats() {
  const user = await supabase.getUser();
  if (!user) {
    return { success: true, quotes: 0, conversations: 0 };
  }

  try {
    // Single query with count aggregation - no N+1!
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, quotes(count)')
      .eq('user_id', user.id);

    const convCount = conversations?.length || 0;
    const quotesCount = conversations?.reduce((sum, conv) => {
      return sum + (conv.quotes?.[0]?.count || 0);
    }, 0) || 0;

    return { success: true, quotes: quotesCount, conversations: convCount };
  } catch (error) {
    return { success: true, quotes: 0, conversations: 0 };
  }
}

async function saveConversationBackup({ url, title, messages }) {
  const user = await supabase.getUser();

  if (!user) {
    return { success: false, error: 'Not logged in' };
  }

  try {
    // Get or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('chatgpt_url', url)
      .eq('user_id', user.id)
      .single();

    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({
          user_id: user.id,
          chatgpt_url: url,
          title: title || 'Untitled',
        })
        .single();

      if (convError) {
        return { success: false, error: convError.message };
      }
      conversation = newConv;
    }

    // Get latest backup
    const { data: latestBackup } = await supabase
      .from('conversation_backups')
      .select('version, message_count, file_path')
      .eq('conversation_id', conversation.id)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    // Check if content changed (same message count + same last message = no change)
    if (latestBackup && latestBackup.message_count === messages.length && latestBackup.file_path) {
      try {
        const { data: existingMessages } = await supabase.downloadFile('dumps', latestBackup.file_path);
        if (existingMessages && Array.isArray(existingMessages)) {
          const lastExisting = existingMessages[existingMessages.length - 1];
          const lastNew = messages[messages.length - 1];

          if (lastExisting?.text === lastNew?.text) {
            return { success: true, version: latestBackup.version, skipped: true };
          }
        }
      } catch (e) {
        // Ignore comparison errors, proceed with backup
      }
    }

    const newVersion = (latestBackup?.version || 0) + 1;

    // Upload to Storage
    const filePath = `${conversation.id}/${newVersion}.json`;
    const fileContent = JSON.stringify(messages, null, 2);

    const uploadResponse = await supabase.uploadFile('dumps', filePath, fileContent);
    if (uploadResponse.error) {
      return { success: false, error: uploadResponse.error };
    }

    // Insert backup metadata
    const { error: backupError } = await supabase
      .from('conversation_backups')
      .insert({
        conversation_id: conversation.id,
        message_count: messages.length,
        version: newVersion,
        file_path: filePath,
      });

    if (backupError) {
      return { success: false, error: backupError.message };
    }

    return { success: true, version: newVersion };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getConversationCounts() {
  const user = await supabase.getUser();
  if (!user) {
    return { success: false, counts: {} };
  }

  try {
    const { data: conversations } = await supabase
      .from('conversations')
      .select('chatgpt_url, quotes(count)')
      .eq('user_id', user.id);

    const counts = {};
    for (const conv of conversations || []) {
      const quoteCount = conv.quotes?.[0]?.count || 0;
      if (quoteCount > 0 && conv.chatgpt_url) {
        counts[conv.chatgpt_url] = quoteCount;
      }
    }

    return { success: true, counts };
  } catch (error) {
    return { success: false, counts: {}, error: error.message };
  }
}

console.log('Refinery background script loaded');

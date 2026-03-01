// Supabase client for Chrome extension
const SUPABASE_URL = 'https://upwymawtegcaslfeulrq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVwd3ltYXd0ZWdjYXNsZmV1bHJxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NDgyOTUsImV4cCI6MjA4NTUyNDI5NX0.C62IRPXX9tDEACbGiDdVWh1cZf_u6KvAJLrElf7PynA';

class SupabaseClient {
  constructor(url, key) {
    this.url = url;
    this.key = key;
    this.accessToken = null;
    this.user = null;
  }

  async init() {
    const stored = await chrome.storage.local.get(['supabase_access_token', 'supabase_refresh_token', 'supabase_user']);
    if (stored.supabase_access_token) {
      this.accessToken = stored.supabase_access_token;
      this.user = stored.supabase_user || null;
    }
  }

  async fetch(endpoint, options = {}, isRetry = false) {
    const headers = {
      'apikey': this.key,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${this.url}${endpoint}`, {
      ...options,
      headers,
    });

    // Auto-refresh on 401 and retry once
    if (response.status === 401 && !isRetry) {
      await this.refreshSession();
      if (this.accessToken) {
        return this.fetch(endpoint, options, true);
      }
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || error.error_description || 'Request failed');
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async getUser() {
    if (this.user) return this.user;
    if (!this.accessToken) return null;

    try {
      const data = await this.fetch('/auth/v1/user');
      this.user = data;
      await chrome.storage.local.set({ supabase_user: data });
      return data;
    } catch (e) {
      // Token might be expired, try to refresh
      await this.refreshSession();
      if (this.accessToken) {
        try {
          const data = await this.fetch('/auth/v1/user');
          this.user = data;
          await chrome.storage.local.set({ supabase_user: data });
          return data;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async refreshSession() {
    const stored = await chrome.storage.local.get(['supabase_refresh_token']);
    if (!stored.supabase_refresh_token) return;

    try {
      const response = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'apikey': this.key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refresh_token: stored.supabase_refresh_token,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        this.accessToken = data.access_token;
        this.user = data.user;
        await chrome.storage.local.set({
          supabase_access_token: data.access_token,
          supabase_refresh_token: data.refresh_token,
          supabase_user: data.user,
        });
      }
    } catch (e) {
      console.error('Failed to refresh session:', e);
    }
  }

  async signInWithGoogle() {
    const REDIRECT_URI = chrome.identity.getRedirectURL();

    // Build Supabase OAuth URL
    const authUrl = new URL(`${this.url}/auth/v1/authorize`);
    authUrl.searchParams.set('provider', 'google');
    authUrl.searchParams.set('redirect_to', REDIRECT_URI);

    console.log('Auth URL:', authUrl.toString());
    console.log('Redirect URI:', REDIRECT_URI);

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        async (responseUrl) => {
          if (chrome.runtime.lastError) {
            console.error('launchWebAuthFlow error:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!responseUrl) {
            reject(new Error('No response URL'));
            return;
          }

          console.log('Response URL:', responseUrl);

          try {
            // Supabase returns tokens in the URL hash
            const url = new URL(responseUrl);
            const hashParams = new URLSearchParams(url.hash.substring(1));

            const accessToken = hashParams.get('access_token');
            const refreshToken = hashParams.get('refresh_token');

            if (!accessToken) {
              // Check for error
              const error = hashParams.get('error_description') || hashParams.get('error');
              if (error) {
                reject(new Error(error));
                return;
              }
              reject(new Error('No access token in response'));
              return;
            }

            this.accessToken = accessToken;

            // Store tokens
            await chrome.storage.local.set({
              supabase_access_token: accessToken,
              supabase_refresh_token: refreshToken,
            });

            // Get user info
            const user = await this.getUser();
            resolve({ user });
          } catch (error) {
            console.error('Sign in error:', error);
            reject(error);
          }
        }
      );
    });
  }

  async signOut() {
    this.accessToken = null;
    this.user = null;
    await chrome.storage.local.remove([
      'supabase_access_token',
      'supabase_refresh_token',
      'supabase_user'
    ]);
  }

  from(table) {
    return new QueryBuilder(this, table);
  }

  async uploadFile(bucket, path, content) {
    const response = await fetch(`${this.url}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        'apikey': this.key,
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'x-upsert': 'true',
      },
      body: content,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      return { error: error.message || 'Upload failed' };
    }

    return { error: null };
  }

  async downloadFile(bucket, path) {
    const response = await fetch(`${this.url}/storage/v1/object/${bucket}/${path}`, {
      headers: {
        'apikey': this.key,
        'Authorization': `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      return { data: null, error: 'Download failed' };
    }

    const data = await response.json();
    return { data, error: null };
  }
}

class QueryBuilder {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.params = new URLSearchParams();
    this.method = 'GET';
    this.body = null;
    this.singleResult = false;
    this.headers = {};
  }

  select(columns = '*') {
    this.params.set('select', columns);
    return this;
  }

  eq(column, value) {
    this.params.append(column, `eq.${value}`);
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.params.set('order', `${column}.${ascending ? 'asc' : 'desc'}`);
    return this;
  }

  limit(count) {
    this.params.set('limit', count);
    return this;
  }

  single() {
    this.singleResult = true;
    this.headers['Accept'] = 'application/vnd.pgrst.object+json';
    return this;
  }

  insert(data) {
    this.method = 'POST';
    this.body = data;
    this.headers['Prefer'] = 'return=representation';
    return this;
  }

  update(data) {
    this.method = 'PATCH';
    this.body = data;
    return this;
  }

  delete() {
    this.method = 'DELETE';
    return this;
  }

  async execute() {
    const endpoint = `/rest/v1/${this.table}?${this.params.toString()}`;

    try {
      const data = await this.client.fetch(endpoint, {
        method: this.method,
        body: this.body ? JSON.stringify(this.body) : undefined,
        headers: this.headers,
      });

      if (this.singleResult && Array.isArray(data)) {
        return { data: data[0] || null, error: null };
      }
      return { data, error: null };
    } catch (error) {
      // Handle "no rows" case for single()
      if (this.singleResult && error.message?.includes('JSON')) {
        return { data: null, error: null };
      }
      return { data: null, error };
    }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

export const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

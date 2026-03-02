// Popup script

async function render() {
  const content = document.getElementById('content');

  // Get user
  const { user } = await chrome.runtime.sendMessage({ type: 'GET_USER' });

  if (!user) {
    content.innerHTML = `
      <div class="logged-out">
        <p>Sign in to start clipping from ChatGPT</p>
        <button class="btn" id="login">Sign in with Google</button>
      </div>
    `;
    document.getElementById('login').addEventListener('click', login);
    return;
  }

  // Get stats
  const stats = await chrome.runtime.sendMessage({ type: 'GET_STATS' });

  content.innerHTML = `
    <div class="user-email">${user.email}</div>
    <div class="stats">${stats.quotes} clips from ${stats.conversations} conversations</div>
    <button class="btn" id="open-board">Open Board</button>
    <button class="btn btn-secondary" id="logout">Sign out</button>
    <div class="shortcut">
      Tip: <kbd>Cmd+Shift+E</kbd> to clip selected text
    </div>
  `;

  document.getElementById('open-board').addEventListener('click', openBoard);
  document.getElementById('logout').addEventListener('click', logout);
}

async function login() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Signing in...</div>';

  const response = await chrome.runtime.sendMessage({ type: 'SIGN_IN' });

  if (response.success) {
    render();
  } else {
    content.innerHTML = `
      <div class="logged-out">
        <p style="color: #dc2626;">Sign in failed: ${response.error}</p>
        <button class="btn" id="login">Try again</button>
      </div>
    `;
    document.getElementById('login').addEventListener('click', login);
  }
}

async function logout() {
  await chrome.runtime.sendMessage({ type: 'SIGN_OUT' });
  render();
}

function openBoard() {
  chrome.runtime.sendMessage({ type: 'OPEN_BOARD' });
  window.close();
}

// Init
render();

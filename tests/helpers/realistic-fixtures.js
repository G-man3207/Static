// Static — enriched local fixture pages with realistic dynamic DOM/CSS/async behavior.
//
// These pages exercise the extension with patterns found on real "normie" websites:
// dynamic DOM mutations, CSS animations, async content loading, XHR/fetch,
// postMessage communication, and autocomplete dropdown simulations.
//
// Import in extension-fixture.js and spread into fixtureFiles:
//   const { realisticFixtureFiles } = require("./realistic-fixtures");
//   const fixtureFiles = { ...realisticFixtureFiles, ... };

const autocompleteHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Realistic Autocomplete</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; color: #222; display: flex; justify-content: center; padding-top: 80px; }
  .search-container { position: relative; width: 100%; max-width: 584px; }
  .search-box { width: 100%; padding: 14px 20px; font-size: 16px; border: 1px solid #dfe1e5; border-radius: 24px; outline: none; transition: box-shadow 0.2s ease, border-color 0.2s ease; }
  .search-box:focus { border-color: #4285f4; box-shadow: 0 1px 6px rgba(32,33,36,0.28); }
  .dropdown { display: none; position: absolute; top: 52px; left: 0; right: 0; background: #fff; border: 1px solid #dfe1e5; border-radius: 0 0 24px 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); z-index: 100; overflow: hidden; animation: slideIn 0.15s ease-out; }
  .dropdown.visible { display: block; }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .suggestion { padding: 10px 20px; cursor: pointer; display: flex; align-items: center; gap: 12px; transition: background 0.1s ease; }
  .suggestion:hover { background: #f8f9fa; }
  .suggestion .icon { width: 20px; height: 20px; background: #9aa0a6; border-radius: 50%; flex-shrink: 0; }
  .suggestion .text { font-size: 14px; color: #222; }
  .suggestion .subtext { font-size: 12px; color: #70757a; margin-top: 2px; }
  .loading-dots { display: inline-flex; gap: 4px; padding: 10px 20px; }
  .loading-dots span { width: 6px; height: 6px; background: #9aa0a6; border-radius: 50%; animation: dotPulse 1s ease-in-out infinite; }
  .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
  .loading-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dotPulse {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
</head>
<body>
<div class="search-container" id="app">
  <input class="search-box" id="searchInput" type="text" placeholder="Search or type URL" autocomplete="off">
  <div class="dropdown" id="dropdown"></div>
</div>

<script>
  (function() {
    const input = document.getElementById('searchInput');
    const dropdown = document.getElementById('dropdown');
    let debounceTimer = null;

    // Simulated suggestions data
    const suggestions = [
      { text: 'weather today', subtext: 'weather forecast' },
      { text: 'weather tomorrow', subtext: 'hourly forecast' },
      { text: 'weather radar', subtext: 'live weather map' },
      { text: 'web development', subtext: 'tutorials & docs' },
      { text: 'web design', subtext: 'inspiration & tools' },
      { text: 'web browser', subtext: 'download & update' },
      { text: 'news headlines', subtext: 'top stories' },
      { text: 'nearby restaurants', subtext: 'places to eat' },
      { text: 'movie showtimes', subtext: 'now playing' },
      { text: 'flight status', subtext: 'track flights' },
    ];

    // Simulate async XHR/fetch-like loading
    function simulateAsyncLoad(query) {
      return new Promise(function(resolve) {
        setTimeout(function() {
          var filtered = suggestions.filter(function(s) {
            return s.text.indexOf(query.toLowerCase()) !== -1;
          }).slice(0, 5);
          resolve(filtered);
        }, 200 + Math.random() * 300);
      });
    }

    function renderLoading() {
      dropdown.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
      dropdown.classList.add('visible');
    }

    function renderSuggestions(items) {
      if (items.length === 0) {
        dropdown.classList.remove('visible');
        return;
      }
      dropdown.innerHTML = items.map(function(item) {
        return '<div class="suggestion">' +
          '<div class="icon"></div>' +
          '<div><div class="text">' + item.text + '</div>' +
          '<div class="subtext">' + item.subtext + '</div></div>' +
          '</div>';
      }).join('');
      dropdown.classList.add('visible');
    }

    // Dynamic DOM mutation: periodically shuffle active suggestion
    function startShuffleAnimation() {
      var items = dropdown.querySelectorAll('.suggestion');
      if (items.length === 0) return;
      var idx = 0;
      setInterval(function() {
        items.forEach(function(el) { el.style.background = ''; });
        items[idx].style.background = '#e8f0fe';
        idx = (idx + 1) % items.length;
      }, 800);
    }

    // MutationObserver to react to suggestion rendering
    var observer = new MutationObserver(function() {
      if (dropdown.querySelectorAll('.suggestion').length > 0) {
        startShuffleAnimation();
      }
    });
    observer.observe(dropdown, { childList: true, subtree: true });

    input.addEventListener('input', function() {
      var query = input.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);

      if (query.length === 0) {
        dropdown.classList.remove('visible');
        return;
      }

      renderLoading();

      debounceTimer = setTimeout(function() {
        simulateAsyncLoad(query).then(function(results) {
          renderSuggestions(results);
          // Mark as done for test synchronization
          window.__autocompleteDone = true;
        });
      }, 300);
    });

    input.addEventListener('focus', function() {
      if (input.value.trim().length > 0 && dropdown.querySelectorAll('.suggestion').length > 0) {
        dropdown.classList.add('visible');
      }
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('.search-container')) {
        dropdown.classList.remove('visible');
      }
    });

    window.__fixtureReady = true;
  })();
</script>
</body>
</html>`;

const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Realistic Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
  .header { background: #1a73e8; color: #fff; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 8px rgba(0,0,0,0.15); position: sticky; top: 0; z-index: 50; }
  .header h1 { font-size: 20px; font-weight: 500; }
  .nav { display: flex; gap: 24px; }
  .nav a { color: rgba(255,255,255,0.85); text-decoration: none; font-size: 14px; padding: 4px 0; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
  .nav a:hover, .nav a.active { color: #fff; border-bottom-color: #fff; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); transition: box-shadow 0.2s ease, transform 0.2s ease; }
  .card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); transform: translateY(-2px); }
  .card h3 { font-size: 14px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 600; color: #1a73e8; }
  .card .change { font-size: 12px; color: #34a853; margin-top: 4px; }
  .card .change.negative { color: #ea4335; }
  .chart-area { width: 100%; height: 120px; margin-top: 12px; display: flex; align-items: flex-end; gap: 3px; }
  .chart-bar { flex: 1; background: linear-gradient(to top, #1a73e8, #4285f4); border-radius: 2px 2px 0 0; animation: barGrow 0.6s ease-out forwards; transform-origin: bottom; }
  @keyframes barGrow {
    from { transform: scaleY(0.2); }
    to { transform: scaleY(1); }
  }
  .feed { margin-top: 24px; }
  .feed-item { padding: 12px 0; border-bottom: 1px solid #e8eaed; display: flex; align-items: center; gap: 12px; animation: fadeIn 0.3s ease-out; }
  .feed-item:last-child { border-bottom: none; }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }
  .feed-avatar { width: 36px; height: 36px; border-radius: 50%; background: #e8eaed; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #666; }
  .feed-content { flex: 1; }
  .feed-content .title { font-size: 14px; font-weight: 500; }
  .feed-content .desc { font-size: 12px; color: #666; margin-top: 2px; }
  .feed-time { font-size: 11px; color: #999; }
  .spinner { display: none; width: 24px; height: 24px; border: 3px solid #e8eaed; border-top-color: #1a73e8; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 20px auto; }
  .spinner.active { display: block; }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #323232; color: #fff; padding: 12px 24px; border-radius: 4px; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); opacity: 0; transform: translateY(16px); transition: opacity 0.3s ease, transform 0.3s ease; z-index: 100; }
  .toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>
<div class="header">
  <h1>📊 Dashboard</h1>
  <nav class="nav">
    <a href="#" class="active">Overview</a>
    <a href="#">Analytics</a>
    <a href="#">Reports</a>
    <a href="#">Settings</a>
  </nav>
</div>
<div class="container">
  <div class="grid" id="statsGrid">
    <div class="card"><h3>Page Views</h3><div class="value" id="stat1">--</div><div class="change" id="change1"></div></div>
    <div class="card"><h3>Visitors</h3><div class="value" id="stat2">--</div><div class="change" id="change2"></div></div>
    <div class="card"><h3>Bounce Rate</h3><div class="value" id="stat3">--</div><div class="change" id="change3"></div></div>
    <div class="card"><h3>Avg. Session</h3><div class="value" id="stat4">--</div><div class="change" id="change4"></div></div>
  </div>

  <div class="spinner" id="feedSpinner"></div>
  <div class="feed" id="feed"></div>

  <div class="toast" id="toast"></div>
</div>

<script>
  (function() {
    var statsGrid = document.getElementById('statsGrid');

    // Simulate XHR/fetch-like async data loading
    function fetchStat(name) {
      return new Promise(function(resolve) {
        setTimeout(function() {
          resolve({
            value: Math.floor(Math.random() * 90000) + 10000,
            change: (Math.random() * 20 - 5).toFixed(1)
          });
        }, 300 + Math.random() * 500);
      });
    }

    function fetchFeedItems() {
      return new Promise(function(resolve) {
        setTimeout(function() {
          resolve([
            { title: 'New user signup', desc: 'User joined from organic search', avatar: 'U', time: '2m ago' },
            { title: 'Order completed', desc: 'Order #1234 for $49.99', avatar: 'O', time: '5m ago' },
            { title: 'Server alert', desc: 'CPU usage at 72% on web-01', avatar: 'S', time: '12m ago' },
            { title: 'Deployment finished', desc: 'v2.3.1 deployed to production', avatar: 'D', time: '18m ago' },
            { title: 'Error spike detected', desc: '5xx rate increased on /api/users', avatar: 'E', time: '25m ago' },
          ]);
        }, 500 + Math.random() * 500);
      });
    }

    // Load stats with animation
    async function loadStats() {
      var statIds = ['stat1', 'stat2', 'stat3', 'stat4'];
      var changeIds = ['change1', 'change2', 'change3', 'change4'];
      var names = ['pageViews', 'visitors', 'bounceRate', 'avgSession'];

      for (var i = 0; i < statIds.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        var data = await fetchStat(names[i]);
        var el = document.getElementById(statIds[i]);
        var changeEl = document.getElementById(changeIds[i]);

        // Animate the number counting up
        var target = data.value;
        var current = 0;
        var step = Math.ceil(target / 30);
        var interval = setInterval(function() {
          current += step;
          if (current >= target) {
            current = target;
            clearInterval(interval);
          }
          el.textContent = current.toLocaleString();
        }, 30);

        if (data.change > 0) {
          changeEl.textContent = '+' + data.change + '%';
          changeEl.className = 'change';
        } else {
          changeEl.textContent = data.change + '%';
          changeEl.className = 'change negative';
        }
      }
    }

    async function loadFeed() {
      var spinner = document.getElementById('feedSpinner');
      var feed = document.getElementById('feed');
      spinner.classList.add('active');
      feed.innerHTML = '';

      var items = await fetchFeedItems();
      spinner.classList.remove('active');

      items.forEach(function(item) {
        var div = document.createElement('div');
        div.className = 'feed-item';
        div.innerHTML = '<div class="feed-avatar">' + item.avatar + '</div>' +
          '<div class="feed-content"><div class="title">' + item.title + '</div>' +
          '<div class="desc">' + item.desc + '</div></div>' +
          '<div class="feed-time">' + item.time + '</div>';
        feed.appendChild(div);
      });
    }

    // Show a toast notification with animation
    function showToast(msg) {
      var toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(function() {
        toast.classList.remove('show');
      }, 3000);
    }

    // Dynamic nav highlighting (simulates SPA routing)
    var navLinks = document.querySelectorAll('.nav a');
    navLinks.forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        navLinks.forEach(function(l) { l.classList.remove('active'); });
        link.classList.add('active');
        showToast('Navigated to ' + link.textContent.trim());
      });
    });

    // Periodic background refresh (simulates real-time updates)
    var refreshCount = 0;
    setInterval(function() {
      refreshCount++;
      if (refreshCount <= 3) {
        showToast('Data refreshed (' + refreshCount + ')');
        loadStats();
        loadFeed();
      }
    }, 8000);

    // Initial load
    loadStats();
    loadFeed();
    window.__fixtureReady = true;
    // Signal test can proceed
    setTimeout(function() { window.__dashboardDone = true; }, 3000);
  })();
</script>
</body>
</html>`;

const dynamicDomHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dynamic DOM Fixture</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fafafa; color: #333; padding: 20px; }
  .controls { margin-bottom: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { padding: 8px 16px; border: 1px solid #dadce0; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; transition: background 0.15s, box-shadow 0.15s; }
  button:hover { background: #f1f3f4; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
  button:active { background: #e8eaed; }
  .content { border: 1px solid #dadce0; border-radius: 8px; padding: 16px; min-height: 200px; background: #fff; }
  .item { padding: 8px 12px; margin: 4px 0; background: #f8f9fa; border-radius: 4px; animation: itemIn 0.2s ease-out; display: flex; align-items: center; gap: 8px; }
  .item:hover { background: #e8f0fe; }
  .item .remove { margin-left: auto; cursor: pointer; color: #999; font-size: 16px; padding: 0 4px; }
  .item .remove:hover { color: #ea4335; }
  @keyframes itemIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .counter { font-size: 12px; color: #666; margin-top: 8px; }
  .flash { background: #fce8e6 !important; transition: background 0.5s; }
</style>
</head>
<body>
<div class="controls">
  <button id="addBtn">+ Add Item</button>
  <button id="addManyBtn">+ Add 10</button>
  <button id="shuffleBtn">🔀 Shuffle</button>
  <button id="clearBtn">🗑 Clear</button>
  <button id="toggleAttrBtn">Toggle Data Attr</button>
</div>
<div class="content" id="content">
  <div class="item">Initial item 1 <span class="remove" data-remove="true">✕</span></div>
  <div class="item">Initial item 2 <span class="remove" data-remove="true">✕</span></div>
</div>
<div class="counter" id="counter">2 items</div>

<script>
  (function() {
    var content = document.getElementById('content');
    var counter = document.getElementById('counter');
    var itemCount = 2;

    // Pattern: setAttribute/removeAttribute cycles (exercises DOM scrubber)
    var attrCycleActive = false;
    var attrCycleTimer = null;

    function updateCounter() {
      var items = content.querySelectorAll('.item');
      itemCount = items.length;
      counter.textContent = itemCount + ' item' + (itemCount !== 1 ? 's' : '');
    }

    function addItem(text) {
      var div = document.createElement('div');
      div.className = 'item';
      var span = document.createElement('span');
      span.className = 'remove';
      span.textContent = '✕';
      span.dataset.remove = 'true';
      div.appendChild(document.createTextNode(text || 'Item ' + (itemCount + 1) + ' — ' + new Date().toLocaleTimeString()));
      div.appendChild(span);
      content.appendChild(div);
      updateCounter();
      return div;
    }

    // Add items with dynamic content (setTimeout, DOM mutations)
    document.getElementById('addBtn').addEventListener('click', function() {
      addItem('New item — ' + new Date().toLocaleTimeString());
    });

    document.getElementById('addManyBtn').addEventListener('click', function() {
      for (var i = 0; i < 10; i++) {
        setTimeout(function(n) {
          addItem('Batch item #' + n + ' — ' + new Date().toLocaleTimeString());
        }, i * 50, i + 1);
      }
    });

    document.getElementById('shuffleBtn').addEventListener('click', function() {
      var items = Array.from(content.querySelectorAll('.item'));
      for (var i = items.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        content.insertBefore(items[j], items[i].nextSibling);
      }
    });

    document.getElementById('clearBtn').addEventListener('click', function() {
      content.innerHTML = '';
      updateCounter();
    });

    // Toggle data attributes on items (exercises DOM scrubber attribute stripping)
    document.getElementById('toggleAttrBtn').addEventListener('click', function() {
      if (attrCycleActive) {
        attrCycleActive = false;
        if (attrCycleTimer) clearInterval(attrCycleTimer);
        return;
      }
      attrCycleActive = true;
      var toggle = false;
      attrCycleTimer = setInterval(function() {
        var items = content.querySelectorAll('.item');
        items.forEach(function(el) {
          if (toggle) {
            el.setAttribute('data-grammarly-extension', 'true');
            el.setAttribute('data-lastpass-root', '1');
            el.classList.add('grammarly-card');
          } else {
            el.removeAttribute('data-grammarly-extension');
            el.removeAttribute('data-lastpass-root');
            el.classList.remove('grammarly-card');
          }
        });
        toggle = !toggle;
      }, 500);
    });

    // Remove items via event delegation (dynamic content)
    content.addEventListener('click', function(e) {
      if (e.target && e.target.dataset.remove === 'true') {
        var item = e.target.closest('.item');
        if (item) {
          item.style.background = '#fce8e6';
          setTimeout(function() {
            item.remove();
            updateCounter();
          }, 200);
        }
      }
    });

    // Periodic dynamic addition (mimics live feed)
    var liveInterval = setInterval(function() {
      if (document.hidden) return;  // respect visibility
      if (content.children.length > 30) return;
      addItem('Live — ' + new Date().toLocaleTimeString());
    }, 3000);

    // Clean up interval on page hide
    document.addEventListener('visibilitychange', function() {
      if (document.hidden && liveInterval) {
        clearInterval(liveInterval);
        liveInterval = null;
      }
    });

    window.__fixtureReady = true;
  })();
</script>
</body>
</html>`;

const messagingHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Messaging / postMessage Fixture</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #333; display: flex; justify-content: center; padding: 40px 20px; }
  .chat-container { width: 100%; max-width: 480px; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden; display: flex; flex-direction: column; height: 600px; }
  .chat-header { background: #1a73e8; color: #fff; padding: 16px 20px; font-size: 16px; font-weight: 500; }
  .messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 18px; font-size: 14px; line-height: 1.4; animation: msgIn 0.2s ease-out; word-wrap: break-word; }
  .msg.incoming { background: #f0f0f0; align-self: flex-start; border-bottom-left-radius: 4px; }
  .msg.outgoing { background: #1a73e8; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
  .msg.system { background: transparent; align-self: center; font-size: 11px; color: #999; padding: 4px 8px; }
  @keyframes msgIn {
    from { opacity: 0; transform: translateY(8px) scale(0.95); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .input-area { display: flex; padding: 12px 16px; border-top: 1px solid #e8eaed; gap: 8px; }
  .input-area input { flex: 1; padding: 10px 16px; border: 1px solid #dadce0; border-radius: 24px; outline: none; font-size: 14px; }
  .input-area input:focus { border-color: #1a73e8; }
  .input-area button { padding: 10px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 24px; cursor: pointer; font-size: 14px; transition: background 0.15s; }
  .input-area button:hover { background: #1557b0; }
  .typing { font-size: 12px; color: #999; padding: 0 20px 8px; min-height: 20px; }
</style>
</head>
<body>
<div class="chat-container" id="chatApp">
  <div class="chat-header">💬 Chat (postMessage test)</div>
  <div class="messages" id="messages"></div>
  <div class="typing" id="typing"></div>
  <div class="input-area">
    <input type="text" id="msgInput" placeholder="Type a message..." autocomplete="off">
    <button id="sendBtn">Send</button>
  </div>
</div>

<script>
  (function() {
    var messagesEl = document.getElementById('messages');
    var msgInput = document.getElementById('msgInput');
    var typingEl = document.getElementById('typing');
    var msgCount = 0;

    function addMessage(text, type) {
      var div = document.createElement('div');
      div.className = 'msg ' + type;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      msgCount++;
      // Dispatch a custom event so external observers can track messages
      window.dispatchEvent(new CustomEvent('newmessage', { detail: { text: text, type: type } }));
    }

    function addSystemMessage(text) {
      var div = document.createElement('div');
      div.className = 'msg system';
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Simulate incoming messages via postMessage (like an iframe or web worker)
    function simulateIncoming() {
      var messages = [
        'Hey there! How are you?',
        'Did you see the latest update?',
        'The extension seems to be working well.',
        'Have you tested it on other sites?',
        'Let me know if you find any issues!',
      ];
      var idx = 0;
      var incomingTimer = setInterval(function() {
        if (idx >= messages.length) {
          clearInterval(incomingTimer);
          return;
        }
        // Simulate incoming message via postMessage
        var msgData = {
          source: 'simulator',
          type: 'incoming_message',
          text: messages[idx],
          timestamp: Date.now(),
        };

        // postMessage to self (simulates cross-origin iframe messaging)
        window.postMessage(msgData, '*');

        // Also set a timeout to actually display it (simulating async handling)
        setTimeout(function() {
          addMessage(messages[idx], 'incoming');
          typingEl.textContent = '';
        }, 300 + Math.random() * 500);

        // Show typing indicator
        typingEl.textContent = 'Someone is typing...';
        idx++;
      }, 2000);
    }

    // Listen for postMessage from simulated sources
    window.addEventListener('message', function(event) {
      // Only handle messages from our simulator
      if (event.data && event.data.source === 'simulator' && event.data.type === 'incoming_message') {
        // The message data was received, we log it for test verification
        window.__lastPostMessageData = event.data;
      }
    });

    // Send message (user action)
    function sendMessage() {
      var text = msgInput.value.trim();
      if (!text) return;
      addMessage(text, 'outgoing');
      msgInput.value = '';

      // Simulate echo reply via postMessage
      setTimeout(function() {
        var echoData = {
          source: 'echo',
          type: 'reply',
          text: 'You said: "' + text + '"',
          original: text,
        };
        window.postMessage(echoData, '*');
        addMessage(echoData.text, 'incoming');
        typingEl.textContent = '';
      }, 1000 + Math.random() * 1000);

      typingEl.textContent = 'Echo is typing...';
    }

    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    msgInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') sendMessage();
    });

    // Add some initial messages
    addSystemMessage('Chat started at ' + new Date().toLocaleTimeString());
    addMessage('Hello! Welcome to the chat.', 'incoming');
    addMessage('Thanks, happy to be here!', 'outgoing');

    // Start simulated incoming messages after a short delay
    setTimeout(simulateIncoming, 1000);

    window.__fixtureReady = true;
  })();
</script>
</body>
</html>`;

const realisticFixtureFiles = {
  "/realistic-autocomplete.html": autocompleteHtml,
  "/realistic-dashboard.html": dashboardHtml,
  "/realistic-dynamic.html": dynamicDomHtml,
  "/realistic-messaging.html": messagingHtml,
};

module.exports = { realisticFixtureFiles };

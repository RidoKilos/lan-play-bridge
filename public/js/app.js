/**
 * app.js — lan-play-bridge client
 *
 * Handles:
 *  - Hash-based SPA navigation between page sections
 *  - Socket.io room coordination (join/leave, partner status)
 *  - Guided step progression in the matchmaking flow
 *  - Mobile nav toggle
 */

(function () {
  'use strict';

  // =====================================================================
  // Navigation
  // =====================================================================
  var pages = document.querySelectorAll('.page');
  var navLinks = document.querySelectorAll('.nav-links a');

  function navigateTo(hash) {
    var target = (hash || '#home').replace('#', '');
    pages.forEach(function (p) { p.classList.remove('active'); });
    navLinks.forEach(function (l) { l.classList.remove('active'); });

    var page = document.getElementById(target);
    if (page) {
      page.classList.add('active');
    } else {
      // Fallback to home
      var home = document.getElementById('home');
      if (home) home.classList.add('active');
      target = 'home';
    }

    var link = document.querySelector('.nav-links a[href="#' + target + '"]');
    if (link) link.classList.add('active');
  }

  window.addEventListener('hashchange', function () { navigateTo(location.hash); });
  navigateTo(location.hash || '#home');

  // Mobile nav toggle
  var navToggle = document.querySelector('.nav-toggle');
  var navLinksEl = document.querySelector('.nav-links');
  if (navToggle) {
    navToggle.addEventListener('click', function () {
      navLinksEl.classList.toggle('open');
    });
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () { navLinksEl.classList.remove('open'); });
    });
  }

  // =====================================================================
  // Socket.io — Room coordination
  // =====================================================================
  var socket = io();

  // DOM references
  var roomEntry       = document.getElementById('room-entry');
  var roomActive      = document.getElementById('room-active');
  var roomCodeInput   = document.getElementById('room-code-input');
  var joinRoomBtn     = document.getElementById('join-room-btn');
  var leaveRoomBtn    = document.getElementById('leave-room-btn');
  var roomCodeDisplay = document.getElementById('room-code-display');
  var statusBadge     = document.getElementById('room-status-badge');

  var step1 = document.getElementById('step-1');
  var step2 = document.getElementById('step-2');
  var step3 = document.getElementById('step-3');
  var step4 = document.getElementById('step-4');

  var step2Check = document.getElementById('step-2-check');
  var step3Check = document.getElementById('step-3-check');
  var assignedIPEl = document.getElementById('assigned-ip');

  var partnerConnected = false;
  var currentRoomCode  = null;
  var myAssignedIP     = null;

  // -- Join room --------------------------------------------------------
  joinRoomBtn.addEventListener('click', joinRoom);
  roomCodeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinRoom();
  });

  function joinRoom() {
    var code = roomCodeInput.value.trim();
    if (!code) {
      roomCodeInput.focus();
      return;
    }
    socket.emit('join-room', { code: code });
  }

  // -- Leave room -------------------------------------------------------
  leaveRoomBtn.addEventListener('click', function () {
    socket.emit('leave-room');
    showRoomEntry();
  });

  // =====================================================================
  // Socket events
  // =====================================================================
  socket.on('room-joined', function (data) {
    currentRoomCode = data.code;
    myAssignedIP = data.assignedIP || null;
    showRoomActive(data.code);
    if (myAssignedIP && assignedIPEl) {
      assignedIPEl.textContent = myAssignedIP;
    }
    if (data.playerCount === 2) {
      setPartnerConnected(true);
    }
  });

  socket.on('partner-joined', function (data) {
    // Server resends our IP on partner-joined in case of reconnect
    if (data && data.assignedIP) {
      myAssignedIP = data.assignedIP;
      if (assignedIPEl) assignedIPEl.textContent = myAssignedIP;
    }
    setPartnerConnected(true);
  });

  socket.on('partner-left', function (data) {
    if (data && data.assignedIP) {
      myAssignedIP = data.assignedIP;
      if (assignedIPEl) assignedIPEl.textContent = myAssignedIP;
    }
    setPartnerConnected(false);
  });

  socket.on('room-full', function (data) {
    showNotice(data.message);
  });

  socket.on('room-error', function (data) {
    showNotice(data.message);
  });

  socket.on('room-expired', function () {
    showNotice('Room expired due to inactivity.');
    showRoomEntry();
  });

  // Reconnection handling
  socket.on('disconnect', function () {
    statusBadge.textContent = 'Reconnecting\u2026';
    statusBadge.className = 'badge badge-warning';
  });

  socket.on('connect', function () {
    // Re-join room automatically after reconnect
    if (currentRoomCode && roomActive && !roomActive.classList.contains('hidden')) {
      socket.emit('join-room', { code: currentRoomCode });
    }
  });

  // =====================================================================
  // UI helpers
  // =====================================================================
  function showRoomEntry() {
    roomEntry.classList.remove('hidden');
    roomActive.classList.add('hidden');
    partnerConnected = false;
    currentRoomCode = null;
    myAssignedIP = null;
    resetSteps();
    roomCodeInput.value = '';
    if (assignedIPEl) assignedIPEl.textContent = 'joining\u2026';
  }

  function showRoomActive(code) {
    roomEntry.classList.add('hidden');
    roomActive.classList.remove('hidden');
    roomCodeDisplay.textContent = code;
    statusBadge.textContent = 'Waiting';
    statusBadge.className = 'badge badge-waiting';
    resetSteps();
    setStepStatus(step1, 'active');
  }

  function setPartnerConnected(connected) {
    partnerConnected = connected;
    if (connected) {
      setStepStatus(step1, 'complete');
      step1.querySelector('.step-content p').textContent = 'Partner connected!';
      setStepStatus(step2, 'active');
      statusBadge.textContent = 'Partner Connected';
      statusBadge.className = 'badge badge-success';
    } else {
      step1.querySelector('.step-content p').textContent =
        'Waiting for your trading partner to join this room\u2026';
      setStepStatus(step1, 'active');
      setStepStatus(step2, 'pending');
      setStepStatus(step3, 'pending');
      setStepStatus(step4, 'pending');
      step2Check.checked = false;
      step3Check.checked = false;
      statusBadge.textContent = 'Partner Disconnected';
      statusBadge.className = 'badge badge-warning';
    }
  }

  function setStepStatus(el, status) {
    if (el) el.setAttribute('data-status', status);
  }

  function resetSteps() {
    [step1, step2, step3, step4].forEach(function (s) {
      setStepStatus(s, 'pending');
    });
    if (step2Check) step2Check.checked = false;
    if (step3Check) step3Check.checked = false;
  }

  // Toast notifications
  var toastContainer = document.getElementById('toast-container');

  function showNotice(msg, type) {
    type = type || 'error';
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = msg;
    toastContainer.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', function () {
        toast.remove();
      });
    }, 4000);
  }

  // Copy room code
  var copyRoomCodeBtn = document.getElementById('copy-room-code');
  if (copyRoomCodeBtn) {
    copyRoomCodeBtn.addEventListener('click', function () {
      var code = roomCodeDisplay.textContent;
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () {
          showNotice('Room code copied!', 'success');
        }, function () {
          fallbackCopy(code);
        });
      } else {
        fallbackCopy(code);
      }
    });
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showNotice('Room code copied!', 'success');
    } catch (e) {
      showNotice('Could not copy. Select and copy manually.', 'warning');
    }
    document.body.removeChild(ta);
  }

  // =====================================================================
  // Step checkbox progression
  // =====================================================================
  if (step2Check) {
    step2Check.addEventListener('change', advanceSteps);
  }
  if (step3Check) {
    step3Check.addEventListener('change', advanceSteps);
  }

  function advanceSteps() {
    if (!partnerConnected) return;

    if (step2Check.checked) {
      setStepStatus(step2, 'complete');
      setStepStatus(step3, 'active');
    } else {
      setStepStatus(step2, 'active');
      setStepStatus(step3, 'pending');
      setStepStatus(step4, 'pending');
      step3Check.checked = false;
      return;
    }

    // Step 3 now auto-completes when launcher is detected, or manual checkbox
    if (step3Check.checked || launcherConnected) {
      setStepStatus(step3, 'complete');
      setStepStatus(step4, 'active');
    } else {
      setStepStatus(step3, 'active');
      setStepStatus(step4, 'pending');
    }
  }

  // =====================================================================
  // Local launcher detection (ws://localhost:25190)
  // =====================================================================
  var LAUNCHER_PORT = 25190;
  var LAUNCHER_URL = 'ws://localhost:' + LAUNCHER_PORT;
  var HEARTBEAT_INTERVAL_MS = 10 * 1000; // 10 seconds

  var launcherWs = null;
  var launcherConnected = false;
  var heartbeatTimer = null;
  var reconnectTimer = null;

  // DOM refs for client status in step 3
  var clientStatusEl = document.getElementById('client-status');
  var clientStatusText = document.getElementById('client-status-text');

  /**
   * Start attempting to connect to the local launcher.
   * Called when entering a room. Retries every 5s if not connected.
   */
  function connectToLauncher() {
    if (launcherWs) return; // already connected or connecting

    try {
      launcherWs = new WebSocket(LAUNCHER_URL);
    } catch (e) {
      // Browser blocked the connection (e.g. Safari)
      setLauncherStatus(false, 'not-supported');
      return;
    }

    launcherWs.onopen = function () {
      launcherConnected = true;
      setLauncherStatus(true, 'connected');

      // Start heartbeats
      heartbeatTimer = setInterval(function () {
        if (launcherWs && launcherWs.readyState === 1) {
          launcherWs.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Auto-advance step 3 if step 2 is complete
      advanceSteps();
    };

    launcherWs.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'status' && msg.data) {
          setLauncherStatus(msg.data.running, msg.data.running ? 'connected' : 'not-running');
        }
        if (msg.type === 'shutdown') {
          setLauncherStatus(false, 'shutdown');
        }
      } catch (e) { /* ignore */ }
    };

    launcherWs.onclose = function () {
      cleanupLauncher();
      setLauncherStatus(false, 'disconnected');
      // Retry connection every 5 seconds while in a room
      if (currentRoomCode) {
        reconnectTimer = setTimeout(connectToLauncher, 5000);
      }
    };

    launcherWs.onerror = function () {
      // onclose will fire after this, handles cleanup + retry
    };
  }

  function disconnectFromLauncher() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (launcherWs) {
      launcherWs.onclose = null; // prevent retry
      launcherWs.close();
    }
    launcherWs = null;
    launcherConnected = false;
  }

  function cleanupLauncher() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    launcherWs = null;
    launcherConnected = false;
  }

  function setLauncherStatus(connected, reason) {
    launcherConnected = connected;
    if (!clientStatusEl || !clientStatusText) return;

    if (connected) {
      clientStatusEl.className = 'client-status client-status-connected';
      clientStatusText.textContent = 'Launcher detected \u2014 lan-play is running';
      // Auto-check step 3
      if (step3Check) step3Check.checked = true;
      advanceSteps();
    } else if (reason === 'not-supported') {
      clientStatusEl.className = 'client-status client-status-warning';
      clientStatusText.textContent = 'Auto-detection not available in this browser. Use the manual checkbox below.';
    } else {
      clientStatusEl.className = 'client-status client-status-waiting';
      clientStatusText.textContent = 'Launcher not detected \u2014 download and run it from the Downloads page';
    }
  }

  // Hook into room entry/exit to start/stop launcher detection
  var _origShowRoomActive = showRoomActive;
  showRoomActive = function (code) {
    _origShowRoomActive(code);
    connectToLauncher();
  };

  var _origShowRoomEntry = showRoomEntry;
  showRoomEntry = function () {
    disconnectFromLauncher();
    _origShowRoomEntry();
  };

})();

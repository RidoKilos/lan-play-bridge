/**
 * lan-play-bridge-launcher — Local companion for the lan-play-bridge web app
 *
 * What this does:
 *   1. Downloads the lan-play binary if not present
 *   2. Starts lan-play as a background subprocess (connects to your relay)
 *   3. Runs a local WebSocket server on port 25190
 *   4. The web app connects to ws://localhost:25190 for status + heartbeats
 *   5. Auto-shuts down when:
 *      - No heartbeat from the browser for 30 seconds (tab closed)
 *      - No activity at all for 10 minutes (user forgot)
 *
 * Configuration:
 *   Relay server is required. Specify it one of two ways:
 *     - CLI arg:      node launcher.js --relay yourserver.example.com:11451
 *     - Baked config: create a config.js in this directory (see README)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { WebSocketServer } = require('ws');

// ===========================================================================
// Configuration
// ===========================================================================

// Optional baked config — create config.js alongside this file to pre-set
// relay and other values (useful for packaging a pre-configured binary).
// See README for details.
var bakedConfig = {};
try {
  bakedConfig = require('./config');
} catch (e) {
  // No baked config present — relay must be provided via --relay CLI arg
}

// Parse --relay from CLI args
function parseArg(flag) {
  var idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

var relay = bakedConfig.relay || parseArg('--relay');
if (!relay) {
  console.error('Error: relay server not specified.');
  console.error('Usage: node launcher.js --relay yourserver.example.com:11451');
  process.exit(1);
}

const CONFIG = {
  relay: relay,
  wsPort: 25190,
  heartbeatTimeoutMs: 30 * 1000,      // 30s without heartbeat → shutdown
  inactivityTimeoutMs: 10 * 60 * 1000, // 10min without any activity → shutdown
  checkIntervalMs: 5 * 1000,           // check every 5s
  lanPlayVersion: '0.2.3',
};

// Platform-specific binary info
const PLATFORM = process.platform;
const BINARY_NAME = PLATFORM === 'win32' ? 'lan-play-win64.exe'
                  : PLATFORM === 'darwin' ? 'lan-play-macos'
                  : 'lan-play-linux';

const BINARY_URL = 'https://github.com/spacemeowx2/switch-lan-play/releases/download/v'
                 + CONFIG.lanPlayVersion + '/' + BINARY_NAME;

// Resolve binary path relative to the launcher executable (works with pkg too)
const BASE_DIR = path.dirname(process.execPath && process.pkg ? process.execPath : __filename);
const BINARY_PATH = path.join(BASE_DIR, BINARY_NAME);

// ===========================================================================
// State
// ===========================================================================
var lanPlayProc = null;
var lanPlayRunning = false;

var lastHeartbeat = 0;
var hasReceivedHeartbeat = false;
var lastActivity = Date.now();
var shuttingDown = false;

var connectedClients = new Set();

// ===========================================================================
// Logging
// ===========================================================================
function log(msg) {
  var ts = new Date().toLocaleTimeString();
  console.log('[' + ts + '] ' + msg);
}

// ===========================================================================
// Binary download
// ===========================================================================
function ensureBinary() {
  return new Promise(function (resolve, reject) {
    if (fs.existsSync(BINARY_PATH)) {
      log('lan-play binary found: ' + BINARY_PATH);
      return resolve();
    }

    log('Downloading lan-play from ' + BINARY_URL + ' ...');

    var file = fs.createWriteStream(BINARY_PATH);
    followRedirects(BINARY_URL, function (response) {
      response.pipe(file);
      file.on('finish', function () {
        file.close();
        // Make executable on unix
        if (PLATFORM !== 'win32') {
          fs.chmodSync(BINARY_PATH, 0o755);
        }
        log('Download complete.');
        resolve();
      });
    }, function (err) {
      fs.unlink(BINARY_PATH, function () {});
      reject(new Error('Failed to download lan-play: ' + err.message));
    });
  });
}

// Follow GitHub's 302 redirects
function followRedirects(url, onResponse, onError, depth) {
  depth = depth || 0;
  if (depth > 5) return onError(new Error('Too many redirects'));

  var getter = url.startsWith('https') ? https : http;
  getter.get(url, { headers: { 'User-Agent': 'lan-play-bridge-launcher' } }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return followRedirects(res.headers.location, onResponse, onError, depth + 1);
    }
    if (res.statusCode !== 200) {
      return onError(new Error('HTTP ' + res.statusCode));
    }
    onResponse(res);
  }).on('error', onError);
}

// ===========================================================================
// lan-play subprocess
// ===========================================================================
function startLanPlay() {
  log('Starting lan-play → ' + CONFIG.relay);

  var args = ['--relay-server-addr', CONFIG.relay];
  lanPlayProc = spawn(BINARY_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  lanPlayRunning = true;
  lastActivity = Date.now();

  lanPlayProc.stdout.on('data', function (data) {
    var line = data.toString().trim();
    if (line) log('[lan-play] ' + line);
    lastActivity = Date.now();
    broadcastStatus();
  });

  lanPlayProc.stderr.on('data', function (data) {
    var line = data.toString().trim();
    if (line) log('[lan-play] ' + line);
    lastActivity = Date.now();
  });

  lanPlayProc.on('close', function (code) {
    log('lan-play exited with code ' + code);
    lanPlayRunning = false;
    broadcastStatus();

    if (!shuttingDown) {
      log('lan-play crashed. Restarting in 3 seconds...');
      setTimeout(startLanPlay, 3000);
    }
  });

  lanPlayProc.on('error', function (err) {
    log('Failed to start lan-play: ' + err.message);
    lanPlayRunning = false;
  });

  broadcastStatus();
}

// ===========================================================================
// WebSocket server — the web app connects here for status + heartbeats
// ===========================================================================
function startWebSocketServer() {
  var server = http.createServer(function (req, res) {
    // Simple HTTP health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  var wss = new WebSocketServer({ server: server });

  wss.on('connection', function (ws, req) {
    // Only accept connections from localhost (the WS server already binds to
    // 127.0.0.1, but this is an extra safeguard against forwarded requests)
    var forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      log('Rejected connection with X-Forwarded-For header (possible proxy)');
      ws.close(4003, 'Forbidden');
      return;
    }

    log('Browser connected');
    connectedClients.add(ws);
    lastActivity = Date.now();

    // Send initial status
    wsSend(ws, { type: 'status', data: getStatus() });

    ws.on('message', function (raw) {
      lastActivity = Date.now();
      try {
        var msg = JSON.parse(raw.toString());
        if (msg.type === 'heartbeat') {
          lastHeartbeat = Date.now();
          hasReceivedHeartbeat = true;
          wsSend(ws, { type: 'heartbeat-ack' });
        } else if (msg.type === 'status') {
          wsSend(ws, { type: 'status', data: getStatus() });
        }
      } catch (e) {
        // ignore malformed messages
      }
    });

    ws.on('close', function () {
      log('Browser disconnected');
      connectedClients.delete(ws);
    });
  });

  server.listen(CONFIG.wsPort, '127.0.0.1', function () {
    log('Listening on ws://localhost:' + CONFIG.wsPort);
    log('Waiting for browser to connect...');
  });

  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      log('ERROR: Port ' + CONFIG.wsPort + ' already in use. Is another launcher running?');
      process.exit(1);
    }
    throw err;
  });
}

function wsSend(ws, obj) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(obj));
  }
}

function broadcastStatus() {
  var status = { type: 'status', data: getStatus() };
  var payload = JSON.stringify(status);
  for (var ws of connectedClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function getStatus() {
  return {
    running: lanPlayRunning,
    relay: CONFIG.relay,
    platform: PLATFORM,
    version: CONFIG.lanPlayVersion,
  };
}

// ===========================================================================
// Auto-shutdown monitor
// ===========================================================================
function startShutdownMonitor() {
  setInterval(function () {
    if (shuttingDown) return;
    var now = Date.now();

    // Check heartbeat timeout (only if we've ever received a heartbeat)
    if (hasReceivedHeartbeat && (now - lastHeartbeat > CONFIG.heartbeatTimeoutMs)) {
      log('No heartbeat for ' + (CONFIG.heartbeatTimeoutMs / 1000) + 's. Browser tab likely closed.');
      shutdown();
      return;
    }

    // Check inactivity timeout
    if (now - lastActivity > CONFIG.inactivityTimeoutMs) {
      log('No activity for ' + (CONFIG.inactivityTimeoutMs / 60000) + ' minutes.');
      shutdown();
      return;
    }
  }, CONFIG.checkIntervalMs);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log('Shutting down...');

  // Notify connected clients
  for (var ws of connectedClients) {
    wsSend(ws, { type: 'shutdown', reason: 'timeout' });
    ws.close();
  }

  // Kill lan-play
  if (lanPlayProc && !lanPlayProc.killed) {
    lanPlayProc.kill();
  }

  // Exit after a brief delay to let cleanup happen
  setTimeout(function () {
    log('Goodbye.');
    process.exit(0);
  }, 1000);
}

// Graceful shutdown on Ctrl+C
process.on('SIGINT', function () {
  log('Received SIGINT.');
  shutdown();
});

process.on('SIGTERM', function () {
  log('Received SIGTERM.');
  shutdown();
});

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  log('=== lan-play-bridge-launcher v' + CONFIG.lanPlayVersion + ' ===');
  log('Platform: ' + PLATFORM);
  log('Relay:    ' + CONFIG.relay);

  // Step 1: Ensure binary exists
  try {
    await ensureBinary();
  } catch (err) {
    log('FATAL: ' + err.message);
    log('Please download lan-play manually from:');
    log('  https://github.com/spacemeowx2/switch-lan-play/releases');
    log('Place it in: ' + BASE_DIR);
    process.exit(1);
  }

  // Step 2: Check for Npcap on Windows
  if (PLATFORM === 'win32') {
    var npcapPaths = [
      'C:\\Windows\\System32\\Npcap\\wpcap.dll',
      'C:\\Windows\\System32\\wpcap.dll',
    ];
    var hasNpcap = npcapPaths.some(function (p) { return fs.existsSync(p); });
    if (!hasNpcap) {
      log('WARNING: Npcap does not appear to be installed.');
      log('lan-play requires Npcap to capture network packets.');
      log('Download from: https://npcap.com/#download');
      log('Install with "WinPcap API-compatible Mode" checked.');
      log('');
      log('Continuing anyway — lan-play will fail if Npcap is truly missing.');
    }
  }

  // Step 3: Start WebSocket server (so the web app can connect)
  startWebSocketServer();

  // Step 4: Start lan-play
  startLanPlay();

  // Step 5: Start auto-shutdown monitor
  startShutdownMonitor();
}

main();

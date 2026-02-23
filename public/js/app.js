/**
 * lan-play-bridge — minimal demo frontend
 *
 * Demonstrates the Socket.io room API. Replace this with your own UI.
 *
 * Server events (incoming):
 *   room-joined    { code, assignedIP, playerCount, position }
 *   room-full      { message }
 *   room-error     { message }
 *   partner-joined { assignedIP, playerCount }
 *   partner-left   { assignedIP, playerCount }
 *   room-expired
 *
 * Client events (outgoing):
 *   join-room  { code }
 *   leave-room
 */

const socket = io();

// --- DOM ---
const viewEntry  = document.getElementById('view-entry');
const viewRoom   = document.getElementById('view-room');
const roomInput  = document.getElementById('room-input');
const joinBtn    = document.getElementById('join-btn');
const leaveBtn   = document.getElementById('leave-btn');
const errorMsg   = document.getElementById('error-msg');
const roomCode   = document.getElementById('room-code');
const roomStatus = document.getElementById('room-status');
const assignedIp = document.getElementById('assigned-ip');

// --- Actions ---
joinBtn.addEventListener('click', () => {
  const code = roomInput.value.trim();
  if (code) socket.emit('join-room', { code });
});

roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

leaveBtn.addEventListener('click', () => {
  socket.emit('leave-room');
  showEntry();
});

// --- Socket events ---
socket.on('room-joined', (data) => {
  roomCode.textContent = data.code;
  assignedIp.textContent = data.assignedIP;
  roomStatus.textContent = 'Waiting for partner\u2026';
  showRoom();
});

socket.on('room-full',  (data) => showError(data.message));
socket.on('room-error', (data) => showError(data.message));

socket.on('partner-joined', (data) => {
  assignedIp.textContent = data.assignedIP;
  roomStatus.textContent = 'Partner connected \u2014 ready to play!';
});

socket.on('partner-left', () => {
  roomStatus.textContent = 'Partner disconnected. Waiting\u2026';
});

socket.on('room-expired', () => {
  showEntry();
  showError('Room expired due to inactivity.');
});

// --- Helpers ---
function showEntry() {
  viewEntry.classList.remove('hidden');
  viewRoom.classList.add('hidden');
  errorMsg.classList.add('hidden');
  roomInput.value = '';
}

function showRoom() {
  viewEntry.classList.add('hidden');
  viewRoom.classList.remove('hidden');
  errorMsg.classList.add('hidden');
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

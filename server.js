// ============================================================
// 릴레이 그림 그리기 게임 (스파이 모드) - 서버
// ------------------------------------------------------------
// 이 파일은 직접 수정할 일이 거의 없어요.
// 딱 하나, 아래 WORD_LIST(제시어 목록)만 선생님이 원하는 대로
// 바꾸면 됩니다. 나중에 엑셀 업로드 방식으로 바꿀 수도 있어요.
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ------------------------------------------------------------
// ★ 여기만 수정하면 제시어를 바꿀 수 있어요 ★
// real: 진짜 제시어 / spy: 스파이가 받는(헷갈리는) 제시어
// 라운드가 6개니까 6줄이 필요해요.
// ------------------------------------------------------------
const WORD_LIST = [
  { real: '농사 짓는 고양이', spy: '농사 짓는 호랑이' },
  { real: '공부하는 학생들', spy: '게임하는 학생들' },
  { real: '복싱하는 강아지', spy: '태권도하는 강아지' },
  { real: '녹고 있는 얼음', spy: '프라이팬 위의 버터' },
  { real: '학교 가는 학생', spy: '도망 가는 학생' },
  { real: '비가 오는 운동장', spy: '비가 오는 호수' },
];

const TOTAL_STUDENTS = 24;
const ROUND_SIZE = 4;
const TOTAL_ROUNDS = WORD_LIST.length; // 6
const DRAW_SECONDS = 20;
const PEEK_SECONDS = 5;
const FINAL_CAPTURE_GRACE_MS = 1500; // 시간 초과 시 마지막 그림을 받기 위해 잠깐 기다리는 시간

// ------------------------------------------------------------
// 전체 게임 상태 (서버 메모리에만 있음 - 서버 끄면 초기화됨)
// ------------------------------------------------------------
const state = {
  phase: 'lobby', // lobby | countdown | drawing | peek | guessing | finished
  round: 0, // 1~6
  drawerOrder: [], // 이번 라운드에 그릴 학생 번호 목록 (보통 4명, 복귀학생 있으면 5명+)
  drawerIndex: 0, // drawerOrder 안에서 지금 몇 번째 차례인지
  spyNumber: null, // 이번 라운드 스파이로 뽑힌 학생 번호
  scores: {}, // { 학생번호: 점수 }
  students: {}, // { 학생번호: { socketId, connected } }
  needsRedo: {}, // { 학생번호: true } - 대타를 썼던 학생, 나중에 한 번 더 그려야 함
  currentGuesses: [], // [{ studentNumber, guess, graded, correct }]
  timer: null,
  secondsLeft: 0,
  currentSnapshot: null, // 지금까지 이어 그려진 그림(dataURL). 라운드 시작 시 null로 초기화
  pendingCapture: null, // 시간 초과로 마지막 그림을 기다리는 중일 때 { drawer, resolve }
};

for (let i = 1; i <= TOTAL_STUDENTS; i++) state.scores[i] = 0;

function roundMembers(round) {
  // round 1 -> 1~4, round 2 -> 5~8 ...
  const start = (round - 1) * ROUND_SIZE + 1;
  const members = [];
  for (let n = start; n < start + ROUND_SIZE; n++) members.push(n);
  return members;
}

function publicState() {
  // 학생 화면에 보내도 되는 정보만 골라서 보냄 (제시어 등 민감정보 제외)
  return {
    phase: state.phase,
    round: state.round,
    totalRounds: TOTAL_ROUNDS,
    drawerOrder: state.drawerOrder,
    drawerIndex: state.drawerIndex,
    currentDrawer: state.drawerOrder[state.drawerIndex] || null,
    secondsLeft: state.secondsLeft,
    scores: state.scores,
    connectedStudents: Object.keys(state.students)
      .filter((n) => state.students[n].connected)
      .map(Number),
  };
}

function teacherState() {
  return {
    ...publicState(),
    spyNumber: state.spyNumber,
    currentGuesses: state.currentGuesses,
    needsRedo: Object.keys(state.needsRedo).map(Number),
  };
}

function broadcastState() {
  io.to('students').emit('state', publicState());
  io.to('teacher').emit('state', teacherState());
}

function clearTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ------------------------------------------------------------
// 라운드/턴 진행 로직
// ------------------------------------------------------------
function startRound(round) {
  state.round = round;
  state.phase = 'drawing';
  const members = roundMembers(round);
  state.drawerOrder = members;
  state.drawerIndex = 0;
  state.spyNumber = members[Math.floor(Math.random() * members.length)];
  state.currentGuesses = [];
  state.currentSnapshot = null; // 새 라운드는 빈 도화지에서 시작
  startTurn();
}

function startTurn() {
  clearTimer();
  const drawer = state.drawerOrder[state.drawerIndex];
  const isSpy = drawer === state.spyNumber;
  const wordSet = WORD_LIST[state.round - 1];
  const word = isSpy ? wordSet.spy : wordSet.real;

  state.phase = 'drawing';
  state.secondsLeft = DRAW_SECONDS;

  const drawerSocketId = state.students[drawer] && state.students[drawer].socketId;
  // baseImage: 이전 학생까지 이어 그려진 그림. 이번 라운드 첫 번째 화가면 null(빈 도화지)
  if (drawerSocketId) {
    io.to(drawerSocketId).emit('your-turn', {
      word,
      seconds: DRAW_SECONDS,
      baseImage: state.currentSnapshot,
    });
  }
  io.to('teacher').emit('drawer-info', { drawer, isSpy, word, baseImage: state.currentSnapshot });

  broadcastState();

  state.timer = setInterval(() => {
    state.secondsLeft -= 1;
    io.to('students').emit('tick', state.secondsLeft);
    io.to('teacher').emit('tick', state.secondsLeft);
    if (state.secondsLeft <= 0) {
      clearTimer();
      requestFinalSnapshot();
    }
  }, 1000);
}

// 시간이 다 됐을 때, 화가의 화면에 "지금까지 그린 그림을 보내줘" 라고 요청하고 잠깐 기다림.
// 응답이 없으면(연결이 끊긴 경우 등) 이전 그림 그대로 다음 사람에게 넘어감.
function requestFinalSnapshot() {
  const drawer = state.drawerOrder[state.drawerIndex];
  const drawerSocketId = state.students[drawer] && state.students[drawer].socketId;
  let resolved = false;
  state.pendingCapture = {
    drawer,
    resolve: (snapshot) => {
      if (resolved) return;
      resolved = true;
      state.pendingCapture = null;
      endTurn(snapshot);
    },
  };
  if (drawerSocketId) io.to(drawerSocketId).emit('time-up');
  setTimeout(() => {
    if (!resolved && state.pendingCapture && state.pendingCapture.drawer === drawer) {
      resolved = true;
      state.pendingCapture = null;
      endTurn(null);
    }
  }, FINAL_CAPTURE_GRACE_MS);
}

// snapshot: 이번 턴까지 이어 그려진 최종 이미지(dataURL). 못 받으면 null.
function endTurn(snapshot) {
  clearTimer();
  const drawer = state.drawerOrder[state.drawerIndex];
  // 그린 학생은 무조건 10점
  state.scores[drawer] = (state.scores[drawer] || 0) + 10;
  // 그림을 받았으면 그걸 다음 사람에게 넘길 "지금까지의 그림"으로 저장. 못 받았으면 이전 그림 유지
  if (snapshot) state.currentSnapshot = snapshot;

  state.phase = 'peek';
  io.to('students').emit('peek', { snapshot: state.currentSnapshot, seconds: PEEK_SECONDS });
  io.to('teacher').emit('peek', { snapshot: state.currentSnapshot, seconds: PEEK_SECONDS });
  broadcastState();

  setTimeout(() => {
    if (state.drawerIndex < state.drawerOrder.length - 1) {
      state.drawerIndex += 1;
      startTurn();
    } else {
      startGuessing();
    }
  }, PEEK_SECONDS * 1000);
}

function startGuessing() {
  state.phase = 'guessing';
  // 완성된 최종 그림을 모든 학생 화면에 계속 띄워둠 (정답 제출용)
  io.to('students').emit('final-image', state.currentSnapshot);
  broadcastState();
}

function nextRound() {
  if (state.round >= TOTAL_ROUNDS) {
    state.phase = 'finished';
    broadcastState();
    return;
  }
  startRound(state.round + 1);
}

// 대타 투입: 지금 차례인 학생이 접속이 끊겼을 때, 교사가 랜덤으로 다른 학생을 그 자리에 넣음
function insertSubstitute() {
  const originalDrawer = state.drawerOrder[state.drawerIndex];
  const busy = new Set(state.drawerOrder);
  const candidates = Object.keys(state.students)
    .map(Number)
    .filter((n) => state.students[n].connected && !busy.has(n));
  if (candidates.length === 0) return { ok: false, reason: '대타로 넣을 수 있는 접속 학생이 없어요.' };

  const sub = candidates[Math.floor(Math.random() * candidates.length)];
  state.needsRedo[originalDrawer] = true;
  state.drawerOrder[state.drawerIndex] = sub;
  // 스파이 지정이 원래 학생이었다면 대타에게 스파이 역할도 그대로 넘어감
  if (state.spyNumber === originalDrawer) state.spyNumber = sub;
  startTurn();
  return { ok: true, sub, originalDrawer };
}

// 복귀 학생 추가 참여: 대타를 썼던 학생이 돌아오면, 지금 진행 중인 라운드에 5번째 그림 순서로 끼워줌
function addReturningStudent(studentNumber) {
  if (!state.needsRedo[studentNumber]) return { ok: false, reason: '대타 기록이 없는 학생이에요.' };
  if (state.phase !== 'drawing' && state.phase !== 'guessing') {
    return { ok: false, reason: '지금은 추가할 수 없는 진행 단계예요.' };
  }
  delete state.needsRedo[studentNumber];
  state.drawerOrder.push(studentNumber);
  if (state.phase === 'guessing') {
    // 이미 그리기 순서가 다 끝났다면 이 학생만을 위한 턴을 하나 더 진행
    state.drawerIndex = state.drawerOrder.length - 1;
    startTurn();
  }
  broadcastState();
  return { ok: true };
}

// ------------------------------------------------------------
// Socket.io 연결 처리
// ------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('join-student', (studentNumber) => {
    studentNumber = Number(studentNumber);
    if (!studentNumber || studentNumber < 1 || studentNumber > TOTAL_STUDENTS) {
      socket.emit('join-error', '1~24 사이의 번호를 골라주세요.');
      return;
    }
    if (state.students[studentNumber] && state.students[studentNumber].connected) {
      socket.emit('join-error', '이미 다른 기기에서 접속 중인 번호예요.');
      return;
    }
    state.students[studentNumber] = { socketId: socket.id, connected: true };
    socket.data.studentNumber = studentNumber;
    socket.join('students');
    socket.emit('joined', studentNumber);
    broadcastState();
  });

  socket.on('join-teacher', () => {
    socket.join('teacher');
    socket.emit('joined-teacher');
    socket.emit('state', teacherState());
  });

  socket.on('start-game', () => {
    if (state.phase !== 'lobby') return;
    nextRound(); // round가 0이므로 1라운드부터 시작
  });

  // 그리는 학생의 실시간 선(stroke)을 교사 화면에만 중계
  socket.on('draw-stroke', (stroke) => {
    const drawer = state.drawerOrder[state.drawerIndex];
    if (socket.data.studentNumber !== drawer) return;
    io.to('teacher').emit('draw-stroke', stroke);
  });

  socket.on('clear-canvas', () => {
    const drawer = state.drawerOrder[state.drawerIndex];
    if (socket.data.studentNumber !== drawer) return;
    io.to('teacher').emit('clear-canvas');
  });

  // 학생이 "다 그렸어요" 버튼을 눌렀거나, 시간 초과로 서버가 마지막 그림을 요청해서 받은 경우
  socket.on('finish-early', (snapshot) => {
    const drawer = state.drawerOrder[state.drawerIndex];
    if (socket.data.studentNumber !== drawer) return;
    if (state.pendingCapture && state.pendingCapture.drawer === drawer) {
      state.pendingCapture.resolve(snapshot);
    } else {
      endTurn(snapshot);
    }
  });

  // 정답 제출 (그 라운드에 그리지 않은 학생만)
  socket.on('submit-guess', (guess) => {
    const num = socket.data.studentNumber;
    if (!num) return;
    if (state.drawerOrder.includes(num)) return; // 이번 라운드 화가는 추리 불가
    if (state.phase !== 'guessing') return; // 4명이 다 그리기 전에는 제출 불가
    const already = state.currentGuesses.find((g) => g.studentNumber === num);
    if (already) {
      already.guess = guess;
    } else {
      state.currentGuesses.push({ studentNumber: num, guess, graded: false, correct: false });
    }
    io.to('teacher').emit('guesses', state.currentGuesses);
  });

  // 교사가 O/X 채점
  socket.on('grade-guess', ({ studentNumber, correct }) => {
    const g = state.currentGuesses.find((x) => x.studentNumber === Number(studentNumber));
    if (!g) return;
    if (g.graded) {
      // 이미 채점된 걸 다시 바꾸는 경우, 이전 점수 되돌리기
      if (g.correct) state.scores[g.studentNumber] -= 30;
    }
    g.graded = true;
    g.correct = correct;
    if (correct) state.scores[g.studentNumber] = (state.scores[g.studentNumber] || 0) + 30;
    broadcastState();
    io.to('teacher').emit('guesses', state.currentGuesses);
  });

  socket.on('next-round', () => {
    if (state.phase !== 'guessing') return;
    nextRound();
  });

  socket.on('insert-substitute', () => {
    const result = insertSubstitute();
    socket.emit('substitute-result', result);
  });

  socket.on('add-returning-student', (studentNumber) => {
    const result = addReturningStudent(Number(studentNumber));
    socket.emit('add-returning-result', result);
  });

  socket.on('disconnect', () => {
    const num = socket.data.studentNumber;
    if (num && state.students[num] && state.students[num].socketId === socket.id) {
      state.students[num].connected = false;
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000; // 호스팅 서비스(Render 등)가 포트를 지정해주면 그걸 쓰고, 없으면 로컬용 3000번
server.listen(PORT, () => {
  console.log('');
  console.log('===================================================');
  console.log(' 릴레이 그림 그리기 게임 서버가 켜졌어요!');
  console.log(' 아래 주소로 접속하세요 (같은 와이파이에서만 접속 가능)');
  console.log('');
  console.log(`  선생님 화면: http://<이 PC의 IP 주소>:${PORT}/teacher.html`);
  console.log(`  학생 화면:   http://<이 PC의 IP 주소>:${PORT}/student.html`);
  console.log('');
  console.log(' PC의 IP 주소를 모르면 터미널에 ipconfig(윈도우) 또는');
  console.log(' ifconfig(맥)를 입력해서 확인하세요.');
  console.log('===================================================');
});

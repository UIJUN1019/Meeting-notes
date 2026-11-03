/* =========================================================
   회의 후속조치 관리 도구 (Meeting Follow-up Tracker)
   - 서버 없이 브라우저 localStorage만 사용하는 SPA
   - 흐름: 사용자 입력 → Store 변경 → save() → 현재 화면 재렌더링
   ========================================================= */
'use strict';

/* =========================================================
   Constants : 저장 키, 임박 기준일, 상태 라벨
   ========================================================= */
const STORAGE_KEY = 'mft_data_v1';
const SCHEMA_VERSION = 1;
const DUE_SOON_DAYS = 3; // 오늘 ~ 오늘+3일 이내 기한 = 임박
const APP_NAME = '회의 후속조치 관리 도구';

const STATUS_LABELS = {
  TODO: '미착수',
  IN_PROGRESS: '진행중',
  DONE: '완료',
};
const STATUS_CODES = Object.keys(STATUS_LABELS);

// 조치 현황 정렬 순서: 지연 → 임박 → 정상
const DUE_GROUP_ORDER = { overdue: 0, soon: 1, normal: 2, done: 3 };

/* =========================================================
   Utils : ID, 날짜, D-day, 기한 판정, 이스케이프, 토스트
   ========================================================= */

// 접두어 + UUID(가능 시) 또는 타임스탬프 + 난수
function generateId(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return prefix + '_' + window.crypto.randomUUID();
  }
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Date → 'YYYY-MM-DD' (로컬 기준)
function toDateString(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

// 현재 시각 → 'YYYY-MM-DDTHH:mm:ss' (로컬 기준 ISO 형식)
function nowIso() {
  const d = new Date();
  return toDateString(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// 'YYYY-MM-DD' → 로컬 자정 Date (시간대 오차 방지)
function parseLocalDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function getToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// 오늘 기준 n일 뒤 날짜 문자열 (샘플 데이터용)
function addDaysFromToday(days) {
  const d = getToday();
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

// 기한까지 남은 일수 (음수 = 지난 일수)
function diffDaysFromToday(dateStr) {
  const due = parseLocalDate(dateStr);
  if (!due) return null;
  return Math.round((due - getToday()) / 86400000);
}

// 기한 상태 판정 → { group, label, badgeClass, rowClass }
function getDueInfo(action) {
  if (action.status === 'DONE') {
    return { group: 'done', label: '완료', badgeClass: 'badge-done', rowClass: 'row-done' };
  }
  const diff = diffDaysFromToday(action.dueDate);
  if (diff === null) {
    return { group: 'normal', label: '기한 없음', badgeClass: 'badge-normal', rowClass: '' };
  }
  if (diff < 0) {
    return { group: 'overdue', label: '지연 D+' + Math.abs(diff), badgeClass: 'badge-overdue', rowClass: 'row-overdue' };
  }
  if (diff <= DUE_SOON_DAYS) {
    return {
      group: 'soon',
      label: diff === 0 ? '임박 D-Day' : '임박 D-' + diff,
      badgeClass: 'badge-soon',
      rowClass: 'row-soon',
    };
  }
  return { group: 'normal', label: 'D-' + diff, badgeClass: 'badge-normal', rowClass: '' };
}

// '2026-11-03T10:00' → '2026-11-03 10:00'
function formatDateTime(str) {
  if (!str) return '-';
  return String(str).replace('T', ' ').slice(0, 16);
}

// '2026-11-07' → '11-07'
function formatShortDate(str) {
  if (!str) return '-';
  return String(str).slice(5, 10);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 쉼표 구분 문자열 → 중복·빈 값 제거 배열
function parseAttendees(text) {
  const list = String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

// 여러 줄 문자열 → 빈 줄 제거 배열
function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let toastTimer = null;
function showToast(message, type) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 2500);
}

/* =========================================================
   Store : load / save, CRUD, 샘플 데이터
   ========================================================= */
let state = { version: SCHEMA_VERSION, meetings: [] };

// 첫 실행용 샘플 데이터 (기한 판정 색상을 모두 볼 수 있도록 오늘 기준 날짜 사용)
function createSampleData() {
  const today = toDateString(getToday());
  const created = today + 'T11:00:00';
  return {
    version: SCHEMA_VERSION,
    meetings: [
      {
        id: generateId('m'),
        title: '주간 업무회의',
        datetime: today + 'T10:00',
        location: '3층 회의실',
        attendees: ['김민수', '이지은', '박준호'],
        agendas: ['프로젝트 일정 점검', '예산 집행 현황', '신규 협력사 선정'],
        decisions: [
          { id: generateId('d'), content: '1차 개발 일정을 이번 달 말로 확정' },
          { id: generateId('d'), content: '예산 잔액은 다음 분기로 이월' },
          { id: generateId('d'), content: '협력사 후보 2곳에 제안 요청서 발송' },
        ],
        actions: [
          {
            id: generateId('a'),
            content: '예산 집행 내역 정리 및 공유',
            owner: '이지은',
            dueDate: addDaysFromToday(-2),
            status: 'TODO',
            completedAt: null,
            createdAt: created,
          },
          {
            id: generateId('a'),
            content: '요건 정의서 초안 작성',
            owner: '김민수',
            dueDate: addDaysFromToday(2),
            status: 'IN_PROGRESS',
            completedAt: null,
            createdAt: created,
          },
          {
            id: generateId('a'),
            content: '협력사 제안 요청서 작성 및 발송',
            owner: '박준호',
            dueDate: addDaysFromToday(7),
            status: 'TODO',
            completedAt: null,
            createdAt: created,
          },
          {
            id: generateId('a'),
            content: '다음 회의실 예약',
            owner: '이지은',
            dueDate: addDaysFromToday(1),
            status: 'DONE',
            completedAt: created,
            createdAt: created,
          },
        ],
        createdAt: created,
        updatedAt: created,
      },
    ],
  };
}

// 외부(저장소·가져오기 파일) 데이터 검증 및 정규화. 형식이 틀리면 예외 발생
function normalizeData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.meetings)) {
    throw new Error('올바른 데이터 형식이 아닙니다.');
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

  const meetings = raw.meetings
    .filter((m) => m && typeof m === 'object' && str(m.id) && str(m.title))
    .map((m) => ({
      id: m.id,
      title: m.title,
      datetime: str(m.datetime),
      location: str(m.location),
      attendees: strList(m.attendees),
      agendas: strList(m.agendas),
      decisions: (Array.isArray(m.decisions) ? m.decisions : [])
        .filter((d) => d && str(d.id) && str(d.content))
        .map((d) => ({ id: d.id, content: d.content })),
      actions: (Array.isArray(m.actions) ? m.actions : [])
        .filter((a) => a && str(a.id) && str(a.content))
        .map((a) => {
          const status = STATUS_CODES.includes(a.status) ? a.status : 'TODO';
          return {
            id: a.id,
            content: a.content,
            owner: str(a.owner),
            dueDate: str(a.dueDate),
            status,
            completedAt: status === 'DONE' ? str(a.completedAt) || null : null,
            createdAt: str(a.createdAt),
          };
        }),
      createdAt: str(m.createdAt),
      updatedAt: str(m.updatedAt),
    }));

  // 향후 스키마 변경 시 이 지점에서 version별 마이그레이션 수행
  return { version: SCHEMA_VERSION, meetings };
}

// 앱 시작 시 로드. 반환값: 사용자에게 알릴 메시지(없으면 null)
function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    state = createSampleData();
    return '브라우저 저장소를 사용할 수 없어 데이터가 저장되지 않습니다.';
  }

  if (!raw) {
    state = createSampleData();
    save();
    return null;
  }

  try {
    state = normalizeData(JSON.parse(raw));
    return null;
  } catch (e) {
    // 손상 데이터는 별도 키로 보관 후 샘플 데이터로 시작
    console.warn('저장 데이터 파싱 실패:', e);
    try {
      localStorage.setItem(STORAGE_KEY + '_corrupted_' + Date.now(), raw);
    } catch (ignore) {
      /* 보관 실패는 무시 */
    }
    state = createSampleData();
    save();
    return '저장된 데이터가 손상되어 샘플 데이터로 초기화했습니다.';
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    console.error('저장 실패:', e);
    showToast('저장에 실패했습니다. 저장 공간이 부족할 수 있습니다. 백업 후 불필요한 데이터를 정리해 주세요.', 'error');
    return false;
  }
}

function touch(meeting) {
  meeting.updatedAt = nowIso();
}

// --- 회의 ---
function getMeeting(id) {
  return state.meetings.find((m) => m.id === id) || null;
}

function createMeeting(fields) {
  const now = nowIso();
  const meeting = {
    id: generateId('m'),
    title: fields.title,
    datetime: fields.datetime,
    location: fields.location,
    attendees: fields.attendees,
    agendas: fields.agendas,
    decisions: [],
    actions: [],
    createdAt: now,
    updatedAt: now,
  };
  state.meetings.push(meeting);
  save();
  return meeting;
}

function updateMeeting(id, fields) {
  const meeting = getMeeting(id);
  if (!meeting) return null;
  Object.assign(meeting, fields);
  touch(meeting);
  save();
  return meeting;
}

// 하위 결정사항·조치 과제는 회의 객체에 중첩되어 함께 삭제됨
function deleteMeeting(id) {
  state.meetings = state.meetings.filter((m) => m.id !== id);
  save();
}

// --- 결정사항 ---
function addDecision(meetingId, content) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  meeting.decisions.push({ id: generateId('d'), content });
  touch(meeting);
  save();
}

function updateDecision(meetingId, decisionId, content) {
  const meeting = getMeeting(meetingId);
  const decision = meeting && meeting.decisions.find((d) => d.id === decisionId);
  if (!decision) return;
  decision.content = content;
  touch(meeting);
  save();
}

function deleteDecision(meetingId, decisionId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  meeting.decisions = meeting.decisions.filter((d) => d.id !== decisionId);
  touch(meeting);
  save();
}

// --- 조치 과제 ---
function getAction(meetingId, actionId) {
  const meeting = getMeeting(meetingId);
  return (meeting && meeting.actions.find((a) => a.id === actionId)) || null;
}

// 상태 변경 규칙: 완료 시 완료일 기록, 완료 해제 시 초기화
function applyStatus(action, status) {
  if (!STATUS_CODES.includes(status)) return;
  if (status === 'DONE' && action.status !== 'DONE') {
    action.completedAt = nowIso();
  } else if (status !== 'DONE') {
    action.completedAt = null;
  }
  action.status = status;
}

function addAction(meetingId, fields) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  const action = {
    id: generateId('a'),
    content: fields.content,
    owner: fields.owner,
    dueDate: fields.dueDate,
    status: 'TODO',
    completedAt: null,
    createdAt: nowIso(),
  };
  applyStatus(action, fields.status || 'TODO');
  meeting.actions.push(action);
  touch(meeting);
  save();
}

function updateAction(meetingId, actionId, fields) {
  const meeting = getMeeting(meetingId);
  const action = getAction(meetingId, actionId);
  if (!action) return;
  action.content = fields.content;
  action.owner = fields.owner;
  action.dueDate = fields.dueDate;
  applyStatus(action, fields.status);
  touch(meeting);
  save();
}

function setActionStatus(meetingId, actionId, status) {
  const meeting = getMeeting(meetingId);
  const action = getAction(meetingId, actionId);
  if (!action) return;
  applyStatus(action, status);
  touch(meeting);
  save();
}

function deleteAction(meetingId, actionId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  meeting.actions = meeting.actions.filter((a) => a.id !== actionId);
  touch(meeting);
  save();
}

// --- 조회용 계산 ---
function countOpenActions(meeting) {
  return meeting.actions.filter((a) => a.status !== 'DONE').length;
}

// 모든 회의의 미완료 과제를 평탄화
function getOpenActions() {
  const list = [];
  state.meetings.forEach((meeting) => {
    meeting.actions.forEach((action) => {
      if (action.status !== 'DONE') {
        list.push({ meeting, action, due: getDueInfo(action) });
      }
    });
  });
  return list;
}

/* =========================================================
   UI 상태 : 검색어, 필터, 편집 중인 항목 (저장하지 않음)
   ========================================================= */
const ui = {
  routeKey: '',
  route: null,
  search: '',
  ownerFilter: 'ALL',
  addingDecision: false,
  editingDecisionId: null,
  actionForm: null, // null | 'new' | 편집 중인 과제 ID
  focusId: null, // 렌더링 후 포커스를 줄 요소 ID
};

function resetEditState() {
  ui.addingDecision = false;
  ui.editingDecisionId = null;
  ui.actionForm = null;
}

/* =========================================================
   Router : 해시 해석 후 화면 렌더링
   ========================================================= */
function parseRoute(hash) {
  if (hash === '#/meetings') return { view: 'list' };
  if (hash === '#/actions') return { view: 'actions' };
  if (hash === '#/meeting/new') return { view: 'form' };
  const m = /^#\/meeting\/([^/]+)(?:\/(edit|report))?$/.exec(hash);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const view = m[2] === 'edit' ? 'form' : m[2] === 'report' ? 'report' : 'detail';
    return { view, id };
  }
  return null;
}

function router() {
  const hash = window.location.hash;
  const route = parseRoute(hash);

  // 정의되지 않은 경로 또는 존재하지 않는 회의 → 회의 목록
  if (!route || (route.id && !getMeeting(route.id))) {
    if (hash !== '#/meetings') {
      window.location.replace('#/meetings');
      return;
    }
  }

  if (ui.routeKey !== hash) {
    ui.routeKey = hash;
    resetEditState();
    window.scrollTo(0, 0);
  }
  ui.route = route;
  render();
}

function navigate(hash) {
  if (window.location.hash === hash) {
    router();
  } else {
    window.location.hash = hash;
  }
}

function setActiveNav(view) {
  const navKey = view === 'actions' ? 'actions' : view === 'form' && !ui.route.id ? '' : 'meetings';
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const active = el.dataset.nav === navKey;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

// 현재 라우트 기준으로 화면 다시 그리기
function render() {
  const route = ui.route;
  const app = document.getElementById('app');
  if (!route) return;
  const meeting = route.id ? getMeeting(route.id) : null;

  let html = '';
  let pageTitle = '';
  switch (route.view) {
    case 'list':
      html = renderMeetingList();
      pageTitle = '회의 목록';
      break;
    case 'actions':
      html = renderActions();
      pageTitle = '조치 현황';
      break;
    case 'form':
      html = renderMeetingForm(meeting);
      pageTitle = meeting ? '회의 수정' : '새 회의';
      break;
    case 'detail':
      html = renderMeetingDetail(meeting);
      pageTitle = meeting.title;
      break;
    case 'report':
      html = renderReport(meeting);
      pageTitle = meeting.title + ' 보고서';
      break;
    default:
      return;
  }
  app.innerHTML = html;
  document.title = pageTitle + ' - ' + APP_NAME;
  setActiveNav(route.view);

  if (ui.focusId) {
    const el = document.getElementById(ui.focusId);
    if (el) el.focus();
    ui.focusId = null;
  }
}

/* =========================================================
   Views : 화면별 HTML 생성
   ========================================================= */

// --- S1. 회의 목록 ---
function renderMeetingList() {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">회의 목록</h1>
        <p class="page-sub">총 ${state.meetings.length}건의 회의가 등록되어 있습니다.</p>
      </div>
      <a href="#/meeting/new" class="btn btn-primary">+ 새 회의</a>
    </div>
    <div class="search-bar">
      <label for="search" class="sr-only">회의명 검색</label>
      <input type="search" id="search" data-action="search" placeholder="🔍 회의명으로 검색" value="${escapeHtml(ui.search)}" autocomplete="off">
    </div>
    <div id="meeting-cards">${renderMeetingCards()}</div>
  `;
}

function renderMeetingCards() {
  const keyword = ui.search.trim().toLowerCase();
  const meetings = state.meetings
    .filter((m) => !keyword || m.title.toLowerCase().includes(keyword))
    .sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));

  if (state.meetings.length === 0) {
    return `<div class="card"><p class="empty">등록된 회의가 없습니다. [+ 새 회의]로 첫 회의를 등록해 보세요.</p></div>`;
  }
  if (meetings.length === 0) {
    return `<div class="card"><p class="empty">'${escapeHtml(ui.search.trim())}'에 해당하는 회의가 없습니다.</p></div>`;
  }

  const cards = meetings
    .map((m) => {
      const open = countOpenActions(m);
      let badge;
      if (m.actions.length === 0) badge = '<span class="badge">과제 없음</span>';
      else if (open > 0) badge = `<span class="badge badge-open">미완료 ${open}건</span>`;
      else badge = '<span class="badge badge-clear">모두 완료</span>';

      const meta = [
        '📅 ' + escapeHtml(formatDateTime(m.datetime)),
        m.location ? '📍 ' + escapeHtml(m.location) : '',
        m.attendees.length ? '👥 ' + m.attendees.length + '명' : '',
        `결정 ${m.decisions.length} · 과제 ${m.actions.length}`,
      ]
        .filter(Boolean)
        .join(' · ');

      return `
        <a class="meeting-card" href="#/meeting/${encodeURIComponent(m.id)}">
          <div>
            <h2 class="meeting-card-title">${escapeHtml(m.title)}</h2>
            <p class="meeting-card-meta">${meta}</p>
          </div>
          ${badge}
        </a>`;
    })
    .join('');

  const summary = keyword ? `<p class="muted">검색 결과 ${meetings.length}건</p>` : '';
  return `${summary}<div class="meeting-list">${cards}</div>`;
}

// --- S2. 회의 작성·수정 ---
function renderMeetingForm(meeting) {
  const isEdit = Boolean(meeting);
  const m = meeting || { title: '', datetime: '', location: '', attendees: [], agendas: [] };
  const cancelHref = isEdit ? '#/meeting/' + encodeURIComponent(m.id) : '#/meetings';

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">${isEdit ? '회의 수정' : '새 회의 등록'}</h1>
        <p class="page-sub"><span class="required">*</span> 표시는 필수 입력 항목입니다.</p>
      </div>
    </div>
    <form class="card" data-form="meeting" novalidate>
      <div class="form-grid">
        <div class="field field-full">
          <label for="f-title">회의명 <span class="required">*</span></label>
          <input type="text" id="f-title" name="title" maxlength="100" value="${escapeHtml(m.title)}" aria-describedby="err-title" required>
          <div class="error-msg" id="err-title" data-error-for="title"></div>
        </div>
        <div class="field">
          <label for="f-datetime">일시 <span class="required">*</span></label>
          <input type="datetime-local" id="f-datetime" name="datetime" value="${escapeHtml(m.datetime)}" aria-describedby="err-datetime" required>
          <div class="error-msg" id="err-datetime" data-error-for="datetime"></div>
        </div>
        <div class="field">
          <label for="f-location">장소</label>
          <input type="text" id="f-location" name="location" maxlength="100" value="${escapeHtml(m.location)}">
        </div>
        <div class="field field-full">
          <label for="f-attendees">참석자</label>
          <input type="text" id="f-attendees" name="attendees" value="${escapeHtml(m.attendees.join(', '))}" placeholder="예: 김민수, 이지은, 박준호" aria-describedby="hint-attendees">
          <span class="hint" id="hint-attendees">쉼표(,)로 구분해 입력하세요. 조치 과제 담당자 후보로 사용됩니다.</span>
        </div>
        <div class="field field-full">
          <label for="f-agendas">안건</label>
          <textarea id="f-agendas" name="agendas" rows="5" placeholder="한 줄에 안건 하나씩 입력하세요." aria-describedby="hint-agendas">${escapeHtml(m.agendas.join('\n'))}</textarea>
          <span class="hint" id="hint-agendas">한 줄 = 안건 1개 (빈 줄은 자동으로 제외됩니다)</span>
        </div>
      </div>
      <div class="form-actions">
        <a href="${cancelHref}" class="btn">취소</a>
        <button type="submit" class="btn btn-primary">${isEdit ? '수정 저장' : '회의 등록'}</button>
      </div>
    </form>
  `;
}

// --- S3. 회의 상세 ---
function renderMeetingDetail(m) {
  const idEnc = encodeURIComponent(m.id);
  const meta = [formatDateTime(m.datetime), m.location].filter(Boolean).map(escapeHtml).join(' | ');
  const attendees = m.attendees.length ? m.attendees.map(escapeHtml).join(', ') : '<span class="muted">-</span>';
  const agendas = m.agendas.length
    ? `<ol class="plain-ol">${m.agendas.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ol>`
    : '<span class="muted">-</span>';

  return `
    <div class="page-head">
      <div>
        <p class="muted" style="margin:0"><a href="#/meetings">← 회의 목록</a></p>
        <h1 class="page-title">${escapeHtml(m.title)}</h1>
        <p class="detail-meta">${meta}</p>
      </div>
      <div class="btn-group">
        <a href="#/meeting/${idEnc}/edit" class="btn">수정</a>
        <button type="button" class="btn btn-danger" data-action="delete-meeting">삭제</button>
      </div>
    </div>

    <section class="card" aria-label="회의 기본 정보">
      <dl class="info-list">
        <dt>참석자</dt><dd>${attendees}</dd>
        <dt>안건</dt><dd>${agendas}</dd>
      </dl>
    </section>

    ${renderDecisionSection(m)}
    ${renderActionSection(m)}

    <div class="detail-footer">
      <a href="#/meeting/${idEnc}/report" class="btn btn-primary">📄 보고서 보기</a>
    </div>
  `;
}

function renderDecisionSection(m) {
  const items = m.decisions
    .map((d, i) => {
      if (ui.editingDecisionId === d.id) {
        return `
          <li class="decision-item">
            <span class="decision-no">${i + 1}.</span>
            <form class="decision-edit" data-form="decision-edit" data-did="${escapeHtml(d.id)}" novalidate>
              <label for="decision-edit-input" class="sr-only">결정사항 수정</label>
              <input type="text" id="decision-edit-input" name="content" value="${escapeHtml(d.content)}" maxlength="300" aria-describedby="err-decision-edit">
              <button type="submit" class="btn btn-sm btn-primary">저장</button>
              <button type="button" class="btn btn-sm" data-action="cancel-decision-edit">취소</button>
            </form>
          </li>
          <li class="error-msg" id="err-decision-edit" data-error-for="content"></li>`;
      }
      return `
        <li class="decision-item">
          <span class="decision-no">${i + 1}.</span>
          <span class="decision-content">${escapeHtml(d.content)}</span>
          <span class="btn-group">
            <button type="button" class="btn btn-sm" data-action="edit-decision" data-did="${escapeHtml(d.id)}">수정</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete-decision" data-did="${escapeHtml(d.id)}">삭제</button>
          </span>
        </li>`;
    })
    .join('');

  const list = m.decisions.length
    ? `<ol class="decision-list">${items}</ol>`
    : '<p class="empty">등록된 결정사항이 없습니다.</p>';

  const addForm = ui.addingDecision
    ? `
      <form class="inline-form" data-form="decision-add" novalidate>
        <div class="field">
          <label for="decision-input">새 결정사항</label>
          <input type="text" id="decision-input" name="content" maxlength="300" placeholder="결정된 내용을 한 줄로 입력하고 Enter" aria-describedby="err-decision-add">
          <div class="error-msg" id="err-decision-add" data-error-for="content"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn" data-action="cancel-decision-form">닫기</button>
          <button type="submit" class="btn btn-primary">추가</button>
        </div>
      </form>`
    : '';

  return `
    <section class="card" aria-labelledby="decision-title">
      <div class="section-head">
        <h2 class="section-title" id="decision-title">■ 결정사항 <span class="muted">(${m.decisions.length})</span></h2>
        ${ui.addingDecision ? '' : '<button type="button" class="btn btn-sm" data-action="show-decision-form">+ 추가</button>'}
      </div>
      ${list}
      ${addForm}
    </section>`;
}

function renderStatusSelect(meetingId, action, label) {
  const options = STATUS_CODES.map(
    (code) => `<option value="${code}"${action.status === code ? ' selected' : ''}>${STATUS_LABELS[code]}</option>`
  ).join('');
  return `<select data-action="change-status" data-mid="${escapeHtml(meetingId)}" data-aid="${escapeHtml(action.id)}" aria-label="${escapeHtml(label)}">${options}</select>`;
}

function renderDueCell(action) {
  const due = getDueInfo(action);
  const badge =
    action.status === 'DONE'
      ? `<span class="badge badge-done">완료 ${escapeHtml(formatShortDate(action.completedAt))}</span>`
      : `<span class="badge ${due.badgeClass}">${escapeHtml(due.label)}</span>`;
  return `<span class="due">${escapeHtml(formatShortDate(action.dueDate))}<span class="due-label">${badge}</span></span>`;
}

function renderActionSection(m) {
  const rows = m.actions
    .map((a, i) => {
      const due = getDueInfo(a);
      return `
        <tr class="${due.rowClass}">
          <td data-label="No">${i + 1}</td>
          <td data-label="내용" class="cell-content">${escapeHtml(a.content)}</td>
          <td data-label="담당자">${escapeHtml(a.owner)}</td>
          <td data-label="기한">${renderDueCell(a)}</td>
          <td data-label="상태">${renderStatusSelect(m.id, a, a.content + ' 진행상태')}</td>
          <td data-label="관리">
            <span class="btn-group">
              <button type="button" class="btn btn-sm" data-action="edit-action" data-aid="${escapeHtml(a.id)}">수정</button>
              <button type="button" class="btn btn-sm btn-danger" data-action="delete-action" data-aid="${escapeHtml(a.id)}">삭제</button>
            </span>
          </td>
        </tr>`;
    })
    .join('');

  const table = m.actions.length
    ? `
      <div class="table-wrap">
        <table class="table table-responsive">
          <thead>
            <tr><th scope="col">No</th><th scope="col">내용</th><th scope="col">담당자</th><th scope="col">기한</th><th scope="col">상태</th><th scope="col">관리</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    : '<p class="empty">등록된 조치 과제가 없습니다.</p>';

  return `
    <section class="card" aria-labelledby="action-title">
      <div class="section-head">
        <h2 class="section-title" id="action-title">■ 조치 과제 <span class="muted">(미완료 ${countOpenActions(m)} / 전체 ${m.actions.length})</span></h2>
        ${ui.actionForm ? '' : '<button type="button" class="btn btn-sm" data-action="show-action-form">+ 추가</button>'}
      </div>
      ${table}
      ${ui.actionForm ? renderActionForm(m) : ''}
    </section>`;
}

function renderActionForm(m) {
  const editing = ui.actionForm !== 'new' ? m.actions.find((a) => a.id === ui.actionForm) : null;
  const a = editing || { content: '', owner: '', dueDate: '', status: 'TODO' };
  const statusOptions = STATUS_CODES.map(
    (code) => `<option value="${code}"${a.status === code ? ' selected' : ''}>${STATUS_LABELS[code]}</option>`
  ).join('');
  const attendeeOptions = m.attendees.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');

  return `
    <form class="inline-form" data-form="action" novalidate>
      <h3 class="section-title" style="margin-bottom:12px">${editing ? '조치 과제 수정' : '새 조치 과제'}</h3>
      <div class="action-form-grid">
        <div class="field">
          <label for="action-content">과제 내용 <span class="required">*</span></label>
          <input type="text" id="action-content" name="content" maxlength="200" value="${escapeHtml(a.content)}" aria-describedby="err-action-content">
          <div class="error-msg" id="err-action-content" data-error-for="content"></div>
        </div>
        <div class="field">
          <label for="action-owner">담당자 <span class="required">*</span></label>
          <input type="text" id="action-owner" name="owner" list="attendee-list" maxlength="30" value="${escapeHtml(a.owner)}" placeholder="선택 또는 입력" autocomplete="off" aria-describedby="err-action-owner">
          <datalist id="attendee-list">${attendeeOptions}</datalist>
          <div class="error-msg" id="err-action-owner" data-error-for="owner"></div>
        </div>
        <div class="field">
          <label for="action-due">기한 <span class="required">*</span></label>
          <input type="date" id="action-due" name="dueDate" value="${escapeHtml(a.dueDate)}" aria-describedby="err-action-due">
          <div class="error-msg" id="err-action-due" data-error-for="dueDate"></div>
        </div>
        <div class="field">
          <label for="action-status">진행상태</label>
          <select id="action-status" name="status">${statusOptions}</select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-action="cancel-action-form">취소</button>
        <button type="submit" class="btn btn-primary">${editing ? '수정 저장' : '과제 추가'}</button>
      </div>
    </form>`;
}

// --- S4. 보고서 ---
function renderReport(m) {
  return `
    <div class="report-toolbar no-print">
      <a href="#/meeting/${encodeURIComponent(m.id)}" class="btn">← 돌아가기</a>
      <div class="btn-group">
        <button type="button" class="btn" data-action="copy-report">📋 텍스트 복사</button>
        <button type="button" class="btn btn-primary" data-action="print">🖨️ 인쇄</button>
      </div>
    </div>
    ${buildReportHtml(m)}
  `;
}

// --- S5. 조치 현황 ---
function renderActions() {
  const all = getOpenActions();
  const owners = Array.from(new Set(all.map((x) => x.action.owner).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'ko')
  );
  if (ui.ownerFilter !== 'ALL' && !owners.includes(ui.ownerFilter)) {
    ui.ownerFilter = 'ALL';
  }

  const items = all
    .filter((x) => ui.ownerFilter === 'ALL' || x.action.owner === ui.ownerFilter)
    .sort((x, y) => {
      const g = DUE_GROUP_ORDER[x.due.group] - DUE_GROUP_ORDER[y.due.group];
      if (g !== 0) return g;
      return (x.action.dueDate || '9999').localeCompare(y.action.dueDate || '9999');
    });

  const soonCount = items.filter((x) => x.due.group === 'soon').length;
  const overdueCount = items.filter((x) => x.due.group === 'overdue').length;

  const ownerOptions = ['<option value="ALL">전체</option>']
    .concat(
      owners.map(
        (o) => `<option value="${escapeHtml(o)}"${ui.ownerFilter === o ? ' selected' : ''}>${escapeHtml(o)}</option>`
      )
    )
    .join('');

  const rows = items
    .map(
      ({ meeting, action, due }) => `
        <tr class="${due.rowClass}">
          <td data-label="상태표시"><span class="badge ${due.badgeClass}">${escapeHtml(due.label)}</span></td>
          <td data-label="조치 내용" class="cell-content">${escapeHtml(action.content)}</td>
          <td data-label="담당자">${escapeHtml(action.owner)}</td>
          <td data-label="기한" class="due">${escapeHtml(action.dueDate)}</td>
          <td data-label="회의명"><a class="meeting-link" href="#/meeting/${encodeURIComponent(meeting.id)}">${escapeHtml(meeting.title)}</a></td>
          <td data-label="진행상태">${renderStatusSelect(meeting.id, action, action.content + ' 진행상태')}</td>
        </tr>`
    )
    .join('');

  const table = items.length
    ? `
      <div class="table-wrap">
        <table class="table table-responsive">
          <thead>
            <tr><th scope="col">상태표시</th><th scope="col">조치 내용</th><th scope="col">담당자</th><th scope="col">기한</th><th scope="col">회의명</th><th scope="col">진행상태</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    : `<p class="empty">${all.length ? '선택한 담당자의 미완료 과제가 없습니다.' : '미완료 조치 과제가 없습니다. 🎉'}</p>`;

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">조치 현황</h1>
        <p class="page-sub">전체 회의의 미완료 과제입니다. 임박 기준: 오늘부터 ${DUE_SOON_DAYS}일 이내</p>
      </div>
    </div>
    <div class="summary-cards">
      <div class="summary-card is-total"><div class="summary-label">전체 미완료</div><div class="summary-value">${items.length}</div></div>
      <div class="summary-card is-soon"><div class="summary-label">임박</div><div class="summary-value">${soonCount}</div></div>
      <div class="summary-card is-overdue"><div class="summary-label">지연</div><div class="summary-value">${overdueCount}</div></div>
    </div>
    <section class="card">
      <div class="filter-bar">
        <label for="owner-filter">담당자</label>
        <select id="owner-filter" data-action="filter-owner">${ownerOptions}</select>
      </div>
      ${table}
    </section>
  `;
}

/* =========================================================
   Report : 보고서 HTML / 복사용 텍스트 생성
   ========================================================= */
function buildReportHtml(m) {
  const overview = [
    ['회의명', m.title],
    ['일시', formatDateTime(m.datetime)],
    ['장소', m.location || '-'],
    ['참석자', m.attendees.length ? m.attendees.join(', ') : '-'],
  ]
    .map(([label, value]) => `<li><span class="label">${label}</span><span>: ${escapeHtml(value)}</span></li>`)
    .join('');

  const numbered = (list) =>
    list.length ? `<ol>${list.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>` : '<p class="report-none">- 없음</p>';

  const actionRows = m.actions
    .map(
      (a, i) => `
        <tr>
          <td class="center">${i + 1}</td>
          <td>${escapeHtml(a.content)}</td>
          <td class="center">${escapeHtml(a.owner)}</td>
          <td class="center">${escapeHtml(a.dueDate)}</td>
          <td class="center">${escapeHtml(STATUS_LABELS[a.status])}</td>
        </tr>`
    )
    .join('');

  const actionTable = m.actions.length
    ? `
      <table class="report-table">
        <thead><tr><th style="width:44px">No</th><th>조치 내용</th><th style="width:80px">담당자</th><th style="width:100px">기한</th><th style="width:64px">상태</th></tr></thead>
        <tbody>${actionRows}</tbody>
      </table>`
    : '<p class="report-none">- 없음</p>';

  return `
    <article class="report">
      <h1>회의 결과 보고</h1>
      <h2>1. 회의 개요</h2>
      <ul class="report-overview">${overview}</ul>
      <h2>2. 안건</h2>
      ${numbered(m.agendas)}
      <h2>3. 결정사항</h2>
      ${numbered(m.decisions.map((d) => d.content))}
      <h2>4. 후속 조치 계획</h2>
      ${actionTable}
      <p class="report-date">작성일: ${toDateString(getToday())}</p>
    </article>`;
}

function buildReportText(m) {
  const indent = '   ';
  const numbered = (list) => (list.length ? list.map((x, i) => `${indent}${i + 1}) ${x}`) : [indent + '- 없음']);

  const actionLines = m.actions.length
    ? [indent + '| No | 조치 내용 | 담당자 | 기한 | 상태 |'].concat(
        m.actions.map(
          (a, i) => `${indent}| ${i + 1} | ${a.content} | ${a.owner} | ${a.dueDate} | ${STATUS_LABELS[a.status]} |`
        )
      )
    : [indent + '- 없음'];

  return [
    '[회의 결과 보고]',
    '',
    '1. 회의 개요',
    `${indent}- 회의명 : ${m.title}`,
    `${indent}- 일  시 : ${formatDateTime(m.datetime)}`,
    `${indent}- 장  소 : ${m.location || '-'}`,
    `${indent}- 참석자 : ${m.attendees.length ? m.attendees.join(', ') : '-'}`,
    '',
    '2. 안건',
    ...numbered(m.agendas),
    '',
    '3. 결정사항',
    ...numbered(m.decisions.map((d) => d.content)),
    '',
    '4. 후속 조치 계획',
    ...actionLines,
    '',
    `작성일: ${toDateString(getToday())}`,
  ].join('\n');
}

// 클립보드 복사: Clipboard API 우선, 실패 시 execCommand 대체
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      /* 대체 방식으로 진행 */
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/* =========================================================
   폼 검증 도우미
   ========================================================= */
function clearErrors(form) {
  form.querySelectorAll('.invalid').forEach((el) => {
    el.classList.remove('invalid');
    el.removeAttribute('aria-invalid');
  });
  // 결정사항 수정 폼은 오류 영역이 폼 바깥 형제 요소에 있음
  const scope = form.closest('section') || form;
  scope.querySelectorAll('[data-error-for]').forEach((el) => {
    el.textContent = '';
  });
}

// errors: { 필드명: 메시지 }. 오류가 있으면 표시 후 false 반환
function showErrors(form, errors) {
  const names = Object.keys(errors);
  if (names.length === 0) return true;
  const scope = form.closest('section') || form;
  names.forEach((name) => {
    const input = form.querySelector(`[name="${name}"]`);
    if (input) {
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      const errEl = document.getElementById(input.getAttribute('aria-describedby'));
      if (errEl) errEl.textContent = errors[name];
    } else {
      const errEl = scope.querySelector(`[data-error-for="${name}"]`);
      if (errEl) errEl.textContent = errors[name];
    }
  });
  const first = form.querySelector(`[name="${names[0]}"]`);
  if (first) first.focus();
  return false;
}

function readForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = typeof value === 'string' ? value.trim() : value;
  });
  return data;
}

/* =========================================================
   Events : 이벤트 위임 (data-action / data-form 기준 분기)
   ========================================================= */
function currentMeeting() {
  return ui.route && ui.route.id ? getMeeting(ui.route.id) : null;
}

// --- 클릭 ---
function handleClick(e) {
  const target = e.target.closest('[data-action]');
  if (!target || target.tagName === 'SELECT' || target.tagName === 'INPUT') return;
  const action = target.dataset.action;
  const meeting = currentMeeting();

  switch (action) {
    case 'delete-meeting': {
      if (!meeting) return;
      const msg = `'${meeting.title}' 회의를 삭제할까요?\n결정사항 ${meeting.decisions.length}건과 조치 과제 ${meeting.actions.length}건도 함께 삭제됩니다.`;
      if (!window.confirm(msg)) return;
      deleteMeeting(meeting.id);
      showToast('회의를 삭제했습니다.');
      navigate('#/meetings');
      break;
    }
    case 'show-decision-form':
      ui.addingDecision = true;
      ui.editingDecisionId = null;
      ui.focusId = 'decision-input';
      render();
      break;
    case 'cancel-decision-form':
      ui.addingDecision = false;
      render();
      break;
    case 'edit-decision':
      ui.editingDecisionId = target.dataset.did;
      ui.addingDecision = false;
      ui.focusId = 'decision-edit-input';
      render();
      break;
    case 'cancel-decision-edit':
      ui.editingDecisionId = null;
      render();
      break;
    case 'delete-decision': {
      if (!meeting || !window.confirm('이 결정사항을 삭제할까요?')) return;
      deleteDecision(meeting.id, target.dataset.did);
      if (ui.editingDecisionId === target.dataset.did) ui.editingDecisionId = null;
      showToast('결정사항을 삭제했습니다.');
      render();
      break;
    }
    case 'show-action-form':
      ui.actionForm = 'new';
      ui.focusId = 'action-content';
      render();
      break;
    case 'edit-action':
      ui.actionForm = target.dataset.aid;
      ui.focusId = 'action-content';
      render();
      document.getElementById('action-content')?.scrollIntoView({ block: 'center' });
      break;
    case 'cancel-action-form':
      ui.actionForm = null;
      render();
      break;
    case 'delete-action': {
      if (!meeting) return;
      const item = getAction(meeting.id, target.dataset.aid);
      if (!item || !window.confirm(`'${item.content}' 과제를 삭제할까요?`)) return;
      deleteAction(meeting.id, item.id);
      if (ui.actionForm === item.id) ui.actionForm = null;
      showToast('조치 과제를 삭제했습니다.');
      render();
      break;
    }
    case 'print':
      window.print();
      break;
    case 'copy-report': {
      if (!meeting) return;
      copyText(buildReportText(meeting)).then((ok) => {
        if (ok) showToast('보고서 텍스트를 클립보드에 복사했습니다.', 'success');
        else showToast('복사에 실패했습니다. 브라우저 권한을 확인해 주세요.', 'error');
      });
      break;
    }
    case 'export-json':
      exportJson();
      break;
    case 'import-json':
      document.getElementById('import-file').click();
      break;
    default:
      break;
  }
}

// --- 값 변경 (select, 파일) ---
function handleChange(e) {
  const target = e.target;
  if (target.id === 'import-file') {
    const file = target.files && target.files[0];
    target.value = '';
    if (file) importJson(file);
    return;
  }

  const action = target.dataset.action;
  if (action === 'change-status') {
    const status = target.value;
    setActionStatus(target.dataset.mid, target.dataset.aid, status);
    if (ui.route.view === 'actions' && status === 'DONE') {
      showToast('완료 처리되어 목록에서 제외했습니다.', 'success');
    } else {
      showToast(`상태를 '${STATUS_LABELS[status]}'(으)로 변경했습니다.`);
    }
    render();
  } else if (action === 'filter-owner') {
    ui.ownerFilter = target.value;
    render();
  }
}

// --- 입력 (검색, 오류 해제) ---
function handleInput(e) {
  const target = e.target;
  if (target.dataset.action === 'search') {
    ui.search = target.value;
    const box = document.getElementById('meeting-cards');
    if (box) box.innerHTML = renderMeetingCards();
    return;
  }
  // 오류 표시된 필드는 입력 시작 시 오류 해제
  if (target.classList && target.classList.contains('invalid')) {
    target.classList.remove('invalid');
    target.removeAttribute('aria-invalid');
    const errEl = document.getElementById(target.getAttribute('aria-describedby'));
    if (errEl) errEl.textContent = '';
  }
}

// --- 키보드 (Esc로 인라인 폼 닫기) ---
function handleKeydown(e) {
  if (e.key !== 'Escape') return;
  const form = e.target.closest && e.target.closest('form[data-form]');
  if (!form) return;
  const type = form.dataset.form;
  if (type === 'decision-add') ui.addingDecision = false;
  else if (type === 'decision-edit') ui.editingDecisionId = null;
  else if (type === 'action') ui.actionForm = null;
  else return;
  render();
}

// --- 폼 제출 ---
function handleSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  clearErrors(form);
  const data = readForm(form);
  const meeting = currentMeeting();

  switch (form.dataset.form) {
    case 'meeting': {
      const errors = {};
      if (!data.title) errors.title = '회의명을 입력해 주세요.';
      if (!data.datetime) errors.datetime = '회의 일시를 입력해 주세요.';
      if (!showErrors(form, errors)) return;

      const fields = {
        title: data.title,
        datetime: data.datetime,
        location: data.location,
        attendees: parseAttendees(data.attendees),
        agendas: parseLines(data.agendas),
      };
      if (meeting) {
        updateMeeting(meeting.id, fields);
        showToast('회의 정보를 수정했습니다.', 'success');
        navigate('#/meeting/' + encodeURIComponent(meeting.id));
      } else {
        const created = createMeeting(fields);
        showToast('회의를 등록했습니다. 결정사항과 조치 과제를 추가해 보세요.', 'success');
        navigate('#/meeting/' + encodeURIComponent(created.id));
      }
      break;
    }
    case 'decision-add': {
      if (!meeting) return;
      if (!showErrors(form, data.content ? {} : { content: '결정사항 내용을 입력해 주세요.' })) return;
      addDecision(meeting.id, data.content);
      ui.focusId = 'decision-input'; // 연속 입력을 위해 폼 유지
      render();
      break;
    }
    case 'decision-edit': {
      if (!meeting) return;
      if (!showErrors(form, data.content ? {} : { content: '결정사항 내용을 입력해 주세요.' })) return;
      updateDecision(meeting.id, form.dataset.did, data.content);
      ui.editingDecisionId = null;
      showToast('결정사항을 수정했습니다.');
      render();
      break;
    }
    case 'action': {
      if (!meeting) return;
      const errors = {};
      if (!data.content) errors.content = '과제 내용을 입력해 주세요.';
      if (!data.owner) errors.owner = '담당자를 입력해 주세요.';
      if (!data.dueDate) errors.dueDate = '기한을 입력해 주세요.';
      else if (!parseLocalDate(data.dueDate)) errors.dueDate = '올바른 날짜를 입력해 주세요.';
      if (!showErrors(form, errors)) return;

      const fields = { content: data.content, owner: data.owner, dueDate: data.dueDate, status: data.status };
      if (ui.actionForm && ui.actionForm !== 'new') {
        updateAction(meeting.id, ui.actionForm, fields);
        showToast('조치 과제를 수정했습니다.');
      } else {
        addAction(meeting.id, fields);
        showToast('조치 과제를 추가했습니다.', 'success');
      }
      ui.actionForm = null;
      render();
      break;
    }
    default:
      break;
  }
}

/* =========================================================
   백업 : JSON 내보내기 / 가져오기
   ========================================================= */
function exportJson() {
  try {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `meeting-followup-backup-${toDateString(getToday())}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('백업 파일을 내보냈습니다.', 'success');
  } catch (e) {
    console.error(e);
    showToast('내보내기에 실패했습니다.', 'error');
  }
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = normalizeData(JSON.parse(String(reader.result)));
    } catch (e) {
      showToast('가져오기 실패: 올바른 백업 파일이 아닙니다.', 'error');
      return;
    }
    const msg = `회의 ${data.meetings.length}건을 가져옵니다.\n현재 브라우저의 데이터(회의 ${state.meetings.length}건)는 모두 대체됩니다. 계속할까요?`;
    if (!window.confirm(msg)) return;
    state = data;
    save();
    showToast('백업 데이터를 가져왔습니다.', 'success');
    ui.routeKey = '';
    navigate('#/meetings');
  };
  reader.onerror = () => showToast('파일을 읽지 못했습니다.', 'error');
  reader.readAsText(file);
}

/* =========================================================
   앱 시작
   ========================================================= */
function init() {
  const notice = load();
  document.addEventListener('click', handleClick);
  document.addEventListener('change', handleChange);
  document.addEventListener('input', handleInput);
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('submit', handleSubmit);
  window.addEventListener('hashchange', router);
  router();
  if (notice) showToast(notice, 'error');
}

document.addEventListener('DOMContentLoaded', init);

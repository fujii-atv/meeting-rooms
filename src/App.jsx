// =====================================================================
// 社内会議室予約アプリ — 本番版
// Google Calendar API 連携、認証、リアルタイム空き状況取得を含む
// =====================================================================

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Users, X, ArrowUpRight, Plus, Minus, RefreshCw, LogIn, LogOut,
  AlertCircle, ChevronRight, Sparkles, Loader2
} from 'lucide-react';

// =====================================================================
// 設定値（.env または下記を直接編集）
// =====================================================================

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const COMPANY_DOMAIN   = import.meta.env.VITE_COMPANY_DOMAIN || ''; // 例: 'yourcompany.com'

// 会議室マスタ。calendarId は Google Workspace でリソース登録した会議室のメールアドレス
const ROOMS = [
  { id: 1, name: '4F会議室', reading: 'atv-4f-meeting room', capacity: 8,  floor: '4F', equipment: ['プロジェクター', 'ホワイトボード'], calendarId: import.meta.env.VITE_ROOM_1_CAL_ID },
  { id: 2, name: '会議室側Phone Booth', reading: 'atv-4f-phone booth',  capacity: 6,  floor: '4F', equipment: ['web会議用'],          calendarId: import.meta.env.VITE_ROOM_2_CAL_ID },
  { id: 3, name: '窓側Phone Booth', reading: 'atv-4f-phone booth_window',   capacity: 4,  floor: '4F', equipment: ['web会議用'],          calendarId: import.meta.env.VITE_ROOM_3_CAL_ID },
  { id: 4, name: '4Fソファ席', reading: 'atv-4f-sofa',  capacity: 14, floor: '4F', equipment: ['プロジェクター'], calendarId: import.meta.env.VITE_ROOM_4_CAL_ID },
  { id: 5, name: '3F会議室', reading: 'atv-3f-third floor',   capacity: 2,  floor: '3F', equipment: ['プロジェクター', 'ホワイトボード'],               calendarId: import.meta.env.VITE_ROOM_5_CAL_ID },
].filter(r => r.calendarId); // calendarId が未設定の会議室は表示しない

// ROOMSから階数を自動抽出（重複除去・ソート済み）。会議室を増減すると自動的にフィルターも追従する
const FLOORS = [...new Set(ROOMS.map(r => r.floor))].sort();

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly openid profile email';
const REFRESH_INTERVAL_MS = 60 * 1000; // 1分ごとに予約状況を再取得

const DURATIONS = [
  { min: 15, label: '15分' },
  { min: 30, label: '30分' },
  { min: 60, label: '1時間' },
  { min: 90, label: '1時間半' },
  { min: 120, label: '2時間' },
];

// =====================================================================
// ヘルパー
// =====================================================================

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDateJP = (d) => {
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getFullYear()}.${pad2(d.getMonth()+1)}.${pad2(d.getDate())} ${days[d.getDay()]}`;
};
const diffMin = (a, b) => Math.max(0, Math.round((b - a) / 60000));
const fmtRel = (min) => {
  if (min < 1) return 'まもなく';
  if (min < 60) return `${min}分`;
  const h = Math.floor(min/60), mm = min % 60;
  return mm === 0 ? `${h}時間` : `${h}時間${mm}分`;
};

const currentBooking = (roomId, bs, now) =>
  bs.find(b => b.roomId === roomId && b.start <= now && b.end > now) || null;

const nextBooking = (roomId, bs, now) =>
  bs.filter(b => b.roomId === roomId && b.start > now).sort((a,b) => a.start - b.start)[0] || null;

const todayBookings = (roomId, bs) => {
  const t0 = new Date(); t0.setHours(0,0,0,0);
  const t1 = new Date(); t1.setHours(23,59,59,999);
  return bs.filter(b => b.roomId === roomId && b.start >= t0 && b.start <= t1).sort((a,b) => a.start - b.start);
};

function makeGcalUrl({ title, start, end, location, details, attendeeEmail }) {
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${fmt(start)}/${fmt(end)}`,
    location,
    details: details || '',
  });
  // 会議室を招待者として追加 → リソースカレンダーへの予約が成立
  if (attendeeEmail) params.append('add', attendeeEmail);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function roundToNext15(d) {
  const out = new Date(d);
  const mod = out.getMinutes() % 15;
  if (mod !== 0) out.setMinutes(out.getMinutes() + (15 - mod));
  out.setSeconds(0, 0);
  return out;
}

// =====================================================================
// Google Identity Services（OAuth）
// =====================================================================

function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google Identity Services の読み込みに失敗しました'));
    document.head.appendChild(s);
  });
}

function useGoogleAuth() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  // ref で同期的に最新のトークンを参照可能にする（setState だと反映に時間差がある）
  const tokenRef = useRef(null);
  const tokenExpiresAtRef = useRef(0);
  const tokenClientRef = useRef(null);
  const pendingRequestRef = useRef(null);
  const userFetchedRef = useRef(false);

  // 新しいトークンを ref と state の両方に反映
  const applyNewToken = useCallback((accessToken, expiresIn) => {
    tokenRef.current = accessToken;
    tokenExpiresAtRef.current = Date.now() + (expiresIn - 60) * 1000;
    setToken(accessToken);
    if (!userFetchedRef.current) {
      userFetchedRef.current = true;
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      })
        .then(r => r.json())
        .then(u => setUser({ name: u.name, email: u.email, picture: u.picture }))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setAuthError('VITE_GOOGLE_CLIENT_ID が設定されていません（.env を確認）');
      return;
    }
    loadGisScript()
      .then(() => {
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          hd: COMPANY_DOMAIN || undefined,
          callback: (resp) => {
            if (resp.error) {
              const errMsg = resp.error_description || resp.error;
              if (pendingRequestRef.current) {
                pendingRequestRef.current.reject(new Error(errMsg));
                pendingRequestRef.current = null;
              } else {
                setAuthError(errMsg);
              }
              return;
            }
            applyNewToken(resp.access_token, resp.expires_in);
            if (pendingRequestRef.current) {
              pendingRequestRef.current.resolve(resp.access_token);
              pendingRequestRef.current = null;
            }
          },
          error_callback: (err) => {
            const errMsg = err.message || err.type || 'ログインに失敗しました';
            if (pendingRequestRef.current) {
              pendingRequestRef.current.reject(new Error(errMsg));
              pendingRequestRef.current = null;
            } else {
              setAuthError(errMsg);
            }
          },
        });
        setReady(true);
      })
      .catch(err => setAuthError(err.message));
  }, [applyNewToken]);

  const signIn = useCallback(() => {
    if (!tokenClientRef.current) return;
    setAuthError(null);
    userFetchedRef.current = false; // 明示ログイン時はユーザー情報も取り直し
    tokenClientRef.current.requestAccessToken({ prompt: 'consent' });
  }, []);

  // 静かにトークンを更新する。新しいトークンで解決する Promise を返す
  const refreshToken = useCallback(() => {
    if (!tokenClientRef.current) return Promise.reject(new Error('認証が初期化されていません'));
    if (pendingRequestRef.current) return pendingRequestRef.current.promise;

    let resolveFn, rejectFn;
    const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    pendingRequestRef.current = { promise, resolve: resolveFn, reject: rejectFn };

    try {
      tokenClientRef.current.requestAccessToken({ prompt: '' });
    } catch (e) {
      pendingRequestRef.current = null;
      return Promise.reject(e);
    }

    // 15秒で応答が無ければタイムアウト
    setTimeout(() => {
      if (pendingRequestRef.current?.promise === promise) {
        pendingRequestRef.current.reject(new Error('トークン更新がタイムアウトしました'));
        pendingRequestRef.current = null;
      }
    }, 15000);

    return promise;
  }, []);

  // 有効なトークンを取得する。期限切れ間近 or forceRefresh なら更新を挟む
  const getValidToken = useCallback(async ({ forceRefresh = false } = {}) => {
    if (!forceRefresh && tokenRef.current && tokenExpiresAtRef.current > Date.now() + 60000) {
      return tokenRef.current;
    }
    return refreshToken();
  }, [refreshToken]);

  const signOut = useCallback(() => {
    if (tokenRef.current) {
      try { window.google.accounts.oauth2.revoke(tokenRef.current, () => {}); } catch (e) {}
    }
    tokenRef.current = null;
    tokenExpiresAtRef.current = 0;
    userFetchedRef.current = false;
    setToken(null);
    setUser(null);
    setAuthError(null);
  }, []);

  return { ready, token, user, authError, signIn, signOut, getValidToken };
}

// =====================================================================
// 会議室の予約状況を取得するフック
// =====================================================================

function useRoomBookings(getValidToken, isAuthed, rooms) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchAll = useCallback(async () => {
    if (!isAuthed) return;

    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const t1 = new Date(); t1.setHours(23, 59, 59, 999);
    const timeMin = encodeURIComponent(t0.toISOString());
    const timeMax = encodeURIComponent(t1.toISOString());

    const fetchOne = (room, accessToken) => {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(room.calendarId)}/events`
        + `?timeMin=${timeMin}&timeMax=${timeMax}`
        + `&singleEvents=true&orderBy=startTime&maxResults=50`;
      return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    };

    // ステップ1: 有効なトークンを取得する
    // ここで失敗する典型ケース: サードパーティCookieが無効でサイレント更新ができない（Safari等）
    // → 「セッションが切れました」バナーを出して再ログインボタンを表示
    let accessToken;
    try {
      accessToken = await getValidToken();
    } catch (refreshErr) {
      setSessionExpired(true);
      setError('セッションの更新が必要です。');
      setLoading(false);
      return;
    }

    // ステップ2: 実際にAPIから予約情報を取得
    setError(null);
    setSessionExpired(false);
    try {
      let responses = await Promise.all(rooms.map(r => fetchOne(r, accessToken)));

      // 401 が混ざっていたらトークンを強制更新して1回だけ再試行
      if (responses.some(res => res.status === 401)) {
        try {
          accessToken = await getValidToken({ forceRefresh: true });
        } catch (refreshErr) {
          setSessionExpired(true);
          throw new Error('セッションの更新が必要です。');
        }
        responses = await Promise.all(rooms.map(r => fetchOne(r, accessToken)));
      }

      const results = await Promise.all(responses.map(async (res, idx) => {
        const room = rooms[idx];
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`${room.name}（${room.calendarId}）の取得に失敗: ${res.status} ${body}`);
        }
        const data = await res.json();
        return (data.items || [])
          .filter(ev => ev.start?.dateTime && ev.end?.dateTime)
          .filter(ev => ev.status !== 'cancelled')
          .map(ev => ({
            id: ev.id,
            roomId: room.id,
            title: ev.summary || '(タイトルなし)',
            organizer: ev.organizer?.displayName || ev.creator?.displayName || ev.organizer?.email || ev.creator?.email || '不明',
            start: new Date(ev.start.dateTime),
            end: new Date(ev.end.dateTime),
          }));
      }));

      setBookings(results.flat());
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [getValidToken, isAuthed, rooms]);

  // 定期ポーリング
  useEffect(() => {
    if (!isAuthed) return;
    setLoading(true);
    fetchAll();
    const t = setInterval(fetchAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [isAuthed, fetchAll]);

  // タブが再表示されたらすぐに再取得（バックグラウンド時はsetIntervalが間引かれるため）
  useEffect(() => {
    if (!isAuthed) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchAll();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isAuthed, fetchAll]);

  return { bookings, loading, error, sessionExpired, lastUpdated, refresh: fetchAll };
}

// =====================================================================
// メインアプリ
// =====================================================================

export default function App() {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@400;500;700;800&family=Zen+Kaku+Gothic+Antique:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch(e) {} };
  }, []);

  const auth = useGoogleAuth();

  if (auth.authError && !auth.token) {
    return <ErrorScreen message={auth.authError} onRetry={auth.signIn} />;
  }
  if (!auth.ready) {
    return <LoadingScreen message="準備中…" />;
  }
  if (!auth.token) {
    return <LoginScreen onSignIn={auth.signIn} />;
  }
  if (ROOMS.length === 0) {
    return <ErrorScreen message="会議室のカレンダーIDが設定されていません。.env を確認してください。" />;
  }

  return <Dashboard auth={auth} />;
}

// =====================================================================
// ダッシュボード（ログイン後の画面）
// =====================================================================

function Dashboard({ auth }) {
  const [now, setNow] = useState(new Date());
  const [bookingRoom, setBookingRoom] = useState(null);
  const [filter, setFilter] = useState('all');
  const { bookings, loading, error, sessionExpired, lastUpdated, refresh } = useRoomBookings(auth.getValidToken, !!auth.token, ROOMS);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const filteredRooms = useMemo(() => {
    if (filter === 'all') return ROOMS;
    if (filter === 'free') return ROOMS.filter(r => !currentBooking(r.id, bookings, now));
    return ROOMS.filter(r => r.floor === filter);
  }, [filter, bookings, now]);

  const availableCount = ROOMS.filter(r => !currentBooking(r.id, bookings, now)).length;

  return (
    <div className="kr-app">
      <GlobalStyles />

      <header className="kr-header">
        <div className="kr-header-inner">
          <div className="kr-brand">
            <span className="kr-brand-mark">会</span>
            <div className="kr-brand-text">
              <div className="kr-brand-title">会議室</div>
              <div className="kr-brand-sub">Meeting Rooms</div>
            </div>
          </div>
          <div className="kr-header-right">
            <div className="kr-header-time">
              <div className="kr-clock">{fmtTime(now)}</div>
              <div className="kr-date">{fmtDateJP(now)}</div>
            </div>
            <button className="kr-icon-btn" onClick={refresh} title="再読み込み" aria-label="再読み込み">
              <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'kr-spin' : ''} />
            </button>
            <button className="kr-icon-btn" onClick={auth.signOut} title="ログアウト" aria-label="ログアウト">
              <LogOut size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </header>

      <main className="kr-main">
        <section className="kr-hero">
          <div className="kr-hero-eyebrow">— 予約状況</div>
          <h1 className="kr-hero-title">
            本日、<em>{availableCount}</em>室<span className="kr-hero-total">／全{ROOMS.length}室</span>が
            <br />
            ただいま空いています。
          </h1>
          <div className="kr-hero-meta">
            {lastUpdated && <span>更新 {fmtTime(lastUpdated)}</span>}
            <span className="kr-dot-sep">·</span>
            <span>ログイン: {auth.user?.name || auth.user?.email || '取得中'}</span>
          </div>
        </section>

        {error && (
          <div className="kr-error-banner">
            <AlertCircle size={14} strokeWidth={1.8} />
            <div>
              <strong>{sessionExpired ? 'セッションが切れました:' : '取得エラー:'}</strong> {error}
              {!sessionExpired && (
                <div className="kr-error-hint">
                  権限不足の場合は、Google Workspace 管理者に「リソース（会議室）への閲覧権限」を確認してください。
                </div>
              )}
            </div>
            {sessionExpired ? (
              <button className="kr-error-relogin" onClick={auth.signIn}>再ログイン</button>
            ) : (
              <button className="kr-icon-btn" onClick={refresh}><RefreshCw size={12} /></button>
            )}
          </div>
        )}

        {loading && bookings.length === 0 ? (
          <LoadingScreen inline message="予約状況を取得中…" />
        ) : (
          <>
            <FilterBar filter={filter} setFilter={setFilter} availableCount={availableCount} />
            <div className="kr-room-list">
              {filteredRooms.map((room, idx) => (
                <RoomCard
                  key={room.id}
                  room={room}
                  bookings={bookings}
                  now={now}
                  index={idx}
                  onBook={() => setBookingRoom(room)}
                />
              ))}
              {filteredRooms.length === 0 && (
                <div className="kr-empty">該当する会議室がありません</div>
              )}
            </div>
          </>
        )}

        <footer className="kr-foot">
          <div className="kr-foot-line" />
          <div className="kr-foot-text">
            予約はGoogleカレンダーに登録されます · 表示は約1分ごとに自動更新
          </div>
        </footer>
      </main>

      <BookingSheet
        room={bookingRoom}
        bookings={bookings}
        now={now}
        userEmail={auth.user?.email}
        onClose={() => setBookingRoom(null)}
      />
    </div>
  );
}

// =====================================================================
// ログイン画面
// =====================================================================

function LoginScreen({ onSignIn }) {
  return (
    <div className="kr-app kr-fullscreen">
      <GlobalStyles />
      <div className="kr-login">
        <div className="kr-login-mark">会</div>
        <div className="kr-login-sub">Meeting Rooms</div>
        <h1 className="kr-login-title">社内会議室<br />予約システム</h1>
        <p className="kr-login-desc">
          Google Workspace アカウントでログインして<br />
          会議室の空き状況を確認・予約します。
        </p>
        <button className="kr-login-btn" onClick={onSignIn}>
          <LogIn size={16} strokeWidth={1.8} />
          Googleアカウントでログイン
        </button>
        {COMPANY_DOMAIN && (
          <div className="kr-login-note">@{COMPANY_DOMAIN} のアカウントのみ利用可能</div>
        )}
      </div>
    </div>
  );
}

function LoadingScreen({ message, inline = false }) {
  return (
    <div className={inline ? 'kr-loading-inline' : 'kr-app kr-fullscreen'}>
      {!inline && <GlobalStyles />}
      <div className="kr-loading">
        <Loader2 size={20} strokeWidth={1.5} className="kr-spin" />
        <div>{message}</div>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }) {
  return (
    <div className="kr-app kr-fullscreen">
      <GlobalStyles />
      <div className="kr-error-screen">
        <AlertCircle size={28} strokeWidth={1.5} />
        <h2>エラー</h2>
        <p>{message}</p>
        {onRetry && <button className="kr-login-btn" onClick={onRetry}>再試行</button>}
      </div>
    </div>
  );
}

// =====================================================================
// フィルター
// =====================================================================

function FilterBar({ filter, setFilter, availableCount }) {
  const opts = [
    { id: 'all',  label: 'すべて' },
    { id: 'free', label: `空き ${availableCount}` },
    ...FLOORS.map(f => ({ id: f, label: f })),
  ];
  return (
    <div className="kr-filter">
      {opts.map(o => (
        <button key={o.id} className={`kr-chip ${filter === o.id ? 'kr-chip-on' : ''}`} onClick={() => setFilter(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// =====================================================================
// 会議室カード
// =====================================================================

function RoomCard({ room, bookings, now, index, onBook }) {
  const cur = currentBooking(room.id, bookings, now);
  const nxt = nextBooking(room.id, bookings, now);
  const isFree = !cur;

  let status, statusColorClass;
  if (cur) {
    const minLeft = diffMin(now, cur.end);
    statusColorClass = minLeft <= 10 ? 'kr-status-soon' : 'kr-status-busy';
    status = minLeft <= 10 ? 'まもなく空き' : '使用中';
  } else {
    statusColorClass = 'kr-status-free';
    status = '空き';
  }
  const today = todayBookings(room.id, bookings);

  return (
    <article
      className={`kr-card ${isFree ? 'kr-card-free' : 'kr-card-busy'}`}
      style={{ animationDelay: `${index * 60}ms` }}
      onClick={isFree ? onBook : undefined}
      role={isFree ? 'button' : undefined}
      tabIndex={isFree ? 0 : undefined}
      onKeyDown={isFree ? (e) => { if (e.key === 'Enter' || e.key === ' ') onBook(); } : undefined}
    >
      <div className="kr-card-top">
        <div className={`kr-status ${statusColorClass}`}>
          <span className="kr-status-dot" />
          {status}
        </div>
        <div className="kr-card-floor">{room.floor}</div>
      </div>

      <div className="kr-card-name">
        <div className="kr-card-kanji">{room.name}</div>
        <div className="kr-card-romaji">{room.reading}</div>
      </div>

      <div className="kr-card-body">
        {cur ? (
          <div className="kr-current">
            <div className="kr-current-title">{cur.title}</div>
            <div className="kr-current-meta">
              <span className="kr-mono">{fmtTime(cur.start)}—{fmtTime(cur.end)}</span>
              <span className="kr-dot-sep">·</span>
              <span>{cur.organizer}</span>
            </div>
            <div className="kr-current-remain">
              あと <em>{fmtRel(diffMin(now, cur.end))}</em> で空きます
            </div>
          </div>
        ) : (
          <div className="kr-free">
            <div className="kr-free-line">
              {nxt
                ? <>次の予約 <span className="kr-mono">{fmtTime(nxt.start)}</span> まで利用可能</>
                : <>本日いっぱい利用可能</>}
            </div>
            {nxt && (
              <div className="kr-free-next">
                次：{nxt.title} <span className="kr-tiny">／ {nxt.organizer}</span>
              </div>
            )}
          </div>
        )}

        {today.length > 0 && (
          <div className="kr-timeline">
            <TimelineStrip bookings={today} now={now} />
          </div>
        )}

        <div className="kr-card-bottom">
          <div className="kr-card-equip">
            <Users size={13} strokeWidth={1.6} />
            <span>{room.capacity}名</span>
            {room.equipment.map(e => <span key={e} className="kr-equip-pill">{e}</span>)}
          </div>
          {isFree ? (
            <div className="kr-card-cta">
              予約する
              <ArrowUpRight size={16} strokeWidth={2} />
            </div>
          ) : (
            <button className="kr-card-cta-soft" onClick={(e) => { e.stopPropagation(); onBook(); }}>
              次の空きから予約
              <ChevronRight size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// =====================================================================
// タイムライン
// =====================================================================

function TimelineStrip({ bookings, now }) {
  const dayStart = new Date(now); dayStart.setHours(9, 0, 0, 0);
  const dayEnd = new Date(now);   dayEnd.setHours(19, 0, 0, 0);
  const total = dayEnd - dayStart;
  const nowPct = Math.max(0, Math.min(100, ((now - dayStart) / total) * 100));

  return (
    <div className="kr-timeline-wrap">
      <div className="kr-timeline-bar">
        {[9,11,13,15,17,19].map(h => (
          <div key={h} className="kr-timeline-tick" style={{ left: `${((h-9)/10) * 100}%` }}>
            <span>{h}</span>
          </div>
        ))}
        <div className="kr-timeline-now" style={{ left: `${nowPct}%` }} />
        {bookings.map(b => {
          const startPct = Math.max(0, ((b.start - dayStart) / total) * 100);
          const endPct = Math.min(100, ((b.end - dayStart) / total) * 100);
          if (endPct <= 0 || startPct >= 100) return null;
          const ended = b.end <= now;
          return (
            <div
              key={b.id}
              className={`kr-timeline-block ${ended ? 'kr-tb-ended' : ''}`}
              style={{ left: `${startPct}%`, width: `${Math.max(2, endPct - startPct)}%` }}
              title={`${b.title} ${fmtTime(b.start)}-${fmtTime(b.end)}`}
            />
          );
        })}
      </div>
    </div>
  );
}

// =====================================================================
// 予約ボトムシート
// =====================================================================

function BookingSheet({ room, bookings, now, userEmail, onClose }) {
  const [duration, setDuration] = useState(60);
  const [title, setTitle] = useState('');

  const computedStart = useMemo(() => {
    if (!room) return null;
    const cur = currentBooking(room.id, bookings, now);
    if (cur) return new Date(cur.end);
    return roundToNext15(now);
  }, [room, bookings, now]);

  const computedEnd = useMemo(() => {
    if (!computedStart) return null;
    return new Date(computedStart.getTime() + duration * 60000);
  }, [computedStart, duration]);

  const conflict = useMemo(() => {
    if (!room || !computedStart || !computedEnd) return null;
    return bookings.find(b => b.roomId === room.id && b.start < computedEnd && b.end > computedStart) || null;
  }, [room, bookings, computedStart, computedEnd]);

  useEffect(() => {
    if (!room) return;
    setTitle('');
    setDuration(60);
  }, [room]);

  if (!room) return null;

  const userLabel = userEmail ? userEmail.split('@')[0] : 'あなた';
  const effectiveTitle = title.trim() || `${userLabel}のミーティング`;
  const location = `${room.floor} 会議室「${room.name}」`;
  const details = [
    `会議室: ${room.name}（${room.reading}）／ 定員${room.capacity}名 ／ ${room.floor}`,
    room.equipment.length ? `設備: ${room.equipment.join('、')}` : null,
    '',
    'このイベントは社内会議室予約システムから登録されました。',
  ].filter(Boolean).join('\n');

  const gcalUrl = makeGcalUrl({
    title: effectiveTitle,
    start: computedStart,
    end: computedEnd,
    location,
    details,
    attendeeEmail: room.calendarId, // ← 会議室を招待者として追加（自動的にリソース予約になる）
  });

  return (
    <div className="kr-sheet-backdrop" onClick={onClose}>
      <div className="kr-sheet" onClick={e => e.stopPropagation()}>
        <button className="kr-sheet-close" onClick={onClose} aria-label="閉じる">
          <X size={20} strokeWidth={1.6} />
        </button>
        <div className="kr-sheet-handle" />

        <div className="kr-sheet-head">
          <div className="kr-sheet-eyebrow">予約 — {room.floor}</div>
          <div className="kr-sheet-room">
            <span className="kr-sheet-room-name">{room.name}</span>
            <span className="kr-sheet-room-romaji">{room.reading}</span>
          </div>
          <div className="kr-sheet-meta">
            <Users size={12} strokeWidth={1.6} /> {room.capacity}名
            {room.equipment.map(e => <span key={e} className="kr-equip-pill">{e}</span>)}
          </div>
        </div>

        <div className="kr-sheet-body">
          <div className="kr-field">
            <div className="kr-field-label">開始時刻</div>
            <div className="kr-time-display">
              <span className="kr-mono kr-time-big">{fmtTime(computedStart)}</span>
              <span className="kr-arrow">→</span>
              <span className="kr-mono kr-time-big">{fmtTime(computedEnd)}</span>
            </div>
            <div className="kr-field-hint">
              {currentBooking(room.id, bookings, now) ? '現在の予約終了直後から' : '次の15分から自動セット'}
            </div>
          </div>

          <div className="kr-field">
            <div className="kr-field-label">利用時間</div>
            <div className="kr-duration-grid">
              {DURATIONS.map(d => (
                <button key={d.min} className={`kr-dur ${duration === d.min ? 'kr-dur-on' : ''}`} onClick={() => setDuration(d.min)}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="kr-stepper">
              <button onClick={() => setDuration(Math.max(15, duration - 15))} aria-label="−15分"><Minus size={14} strokeWidth={2} /></button>
              <span className="kr-mono">{duration}分</span>
              <button onClick={() => setDuration(Math.min(480, duration + 15))} aria-label="+15分"><Plus size={14} strokeWidth={2} /></button>
            </div>
          </div>

          <div className="kr-field">
            <div className="kr-field-label">タイトル <span className="kr-field-optional">（省略可）</span></div>
            <input className="kr-input" type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder={`${userLabel}のミーティング`} />
          </div>

          {conflict && (
            <div className="kr-warn">
              <strong>時間が重複しています</strong>
              <div>「{conflict.title}」（{fmtTime(conflict.start)}〜{fmtTime(conflict.end)} / {conflict.organizer}）と被ります。利用時間を調整してください。</div>
            </div>
          )}

          <div className="kr-preview">
            <div className="kr-preview-label">Googleカレンダーに登録される内容</div>
            <div className="kr-preview-row"><span className="kr-preview-k">タイトル</span><span className="kr-preview-v">{effectiveTitle}</span></div>
            <div className="kr-preview-row"><span className="kr-preview-k">日時</span><span className="kr-preview-v kr-mono">{fmtDateJP(computedStart)} {fmtTime(computedStart)} — {fmtTime(computedEnd)}</span></div>
            <div className="kr-preview-row"><span className="kr-preview-k">場所</span><span className="kr-preview-v">{location}</span></div>
            <div className="kr-preview-row"><span className="kr-preview-k">参加者</span><span className="kr-preview-v kr-mono kr-tiny">{room.calendarId}</span></div>
          </div>
        </div>

        <div className="kr-sheet-foot">
          <a
            href={conflict ? undefined : gcalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`kr-cta-primary ${conflict ? 'kr-cta-disabled' : ''}`}
            onClick={(e) => {
              if (conflict) { e.preventDefault(); return; }
              setTimeout(onClose, 200);
            }}
          >
            <Sparkles size={16} strokeWidth={1.8} />
            Googleカレンダーで予約する
            <ArrowUpRight size={16} strokeWidth={2} />
          </a>
          <div className="kr-cta-hint">
            別タブで開きます。「保存」ボタンを押せば完了です。
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// グローバルスタイル
// =====================================================================

function GlobalStyles() {
  return (
    <style>{`
      :root {
        --bg: #f4eedd; --bg-deep: #ebe2c7; --surface: #fdfaf2; --surface-2: #f8f2e2;
        --ink: #1e1a14; --ink-soft: #5b5346; --ink-mute: #97907f; --ink-faint: #c5beac;
        --border: #e4d9bd; --border-soft: #efe6cf;
        --matcha: #5d7a3a; --matcha-bg: #dde5cb; --matcha-ink: #3d5524;
        --beni: #b35041; --beni-bg: #f1d4cc; --beni-ink: #82382c;
        --kogane: #ad8332; --kogane-bg: #ecd9af; --kogane-ink: #6f521b;
        --serif: 'Shippori Mincho B1', 'Yu Mincho', serif;
        --sans: 'Zen Kaku Gothic Antique', 'Hiragino Sans', system-ui, sans-serif;
        --mono: 'JetBrains Mono', ui-monospace, monospace;
      }
      * { box-sizing: border-box; }
      body { margin: 0; }
      .kr-app {
        min-height: 100vh; background: var(--bg); color: var(--ink);
        font-family: var(--sans); font-weight: 400; -webkit-font-smoothing: antialiased;
        background-image:
          radial-gradient(circle at 20% 10%, rgba(174, 138, 60, 0.05) 0%, transparent 50%),
          radial-gradient(circle at 80% 90%, rgba(93, 122, 58, 0.04) 0%, transparent 50%);
      }
      .kr-fullscreen { display: flex; align-items: center; justify-content: center; padding: 24px; }
      .kr-spin { animation: krSpin 1s linear infinite; }
      @keyframes krSpin { to { transform: rotate(360deg); } }

      /* Header */
      .kr-header { position: sticky; top: 0; z-index: 20; background: rgba(244, 238, 221, 0.92); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-soft); }
      .kr-header-inner { max-width: 720px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .kr-brand { display: flex; align-items: center; gap: 12px; }
      .kr-brand-mark { width: 36px; height: 36px; background: var(--ink); color: var(--bg); font-family: var(--serif); font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center; border-radius: 2px; }
      .kr-brand-title { font-family: var(--serif); font-weight: 700; font-size: 16px; letter-spacing: 0.04em; line-height: 1.1; }
      .kr-brand-sub { font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em; color: var(--ink-mute); text-transform: uppercase; margin-top: 2px; }
      .kr-header-right { display: flex; align-items: center; gap: 8px; }
      .kr-header-time { text-align: right; }
      .kr-clock { font-family: var(--mono); font-size: 18px; font-weight: 500; line-height: 1; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; }
      .kr-date { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; color: var(--ink-mute); margin-top: 4px; }
      .kr-icon-btn { width: 32px; height: 32px; background: transparent; border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ink-soft); }
      .kr-icon-btn:hover { color: var(--ink); border-color: var(--ink); }

      /* Main */
      .kr-main { max-width: 720px; margin: 0 auto; padding: 28px 20px 100px; }

      /* Hero */
      .kr-hero { margin-bottom: 28px; }
      .kr-hero-eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em; color: var(--matcha); text-transform: uppercase; margin-bottom: 14px; }
      .kr-hero-title { font-family: var(--serif); font-weight: 500; font-size: 28px; line-height: 1.45; letter-spacing: 0.01em; margin: 0; color: var(--ink); }
      .kr-hero-title em { font-style: normal; font-weight: 800; font-size: 1.45em; color: var(--matcha-ink); font-feature-settings: "tnum"; padding: 0 2px; }
      .kr-hero-total { font-family: var(--mono); font-size: 12px; color: var(--ink-mute); margin-left: 4px; letter-spacing: 0.05em; }
      .kr-hero-meta { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; color: var(--ink-mute); margin-top: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .kr-dot-sep { color: var(--ink-faint); }

      /* Filter */
      .kr-filter { display: flex; gap: 8px; margin-bottom: 18px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
      .kr-filter::-webkit-scrollbar { display: none; }
      .kr-chip { flex: 0 0 auto; padding: 7px 14px; background: transparent; border: 1px solid var(--border); border-radius: 999px; font-family: var(--sans); font-size: 12px; font-weight: 500; color: var(--ink-soft); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
      .kr-chip:hover { border-color: var(--ink-soft); color: var(--ink); }
      .kr-chip-on { background: var(--ink); border-color: var(--ink); color: var(--bg); }

      /* Card */
      .kr-room-list { display: flex; flex-direction: column; gap: 12px; }
      .kr-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 4px; padding: 18px 20px 16px; position: relative; opacity: 0; animation: krFadeIn 0.5s ease-out forwards; transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s; }
      .kr-card-free { cursor: pointer; }
      .kr-card-free:hover { transform: translateY(-1px); box-shadow: 0 6px 24px -10px rgba(30, 26, 20, 0.18); border-color: var(--matcha); }
      .kr-card-free:hover .kr-card-cta { background: var(--matcha-ink); }
      .kr-card-busy { background: var(--surface-2); border-color: var(--border); }
      @keyframes krFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .kr-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
      .kr-status { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; padding: 4px 10px 4px 8px; border-radius: 999px; }
      .kr-status-dot { width: 7px; height: 7px; border-radius: 50%; }
      .kr-status-free { background: var(--matcha-bg); color: var(--matcha-ink); }
      .kr-status-free .kr-status-dot { background: var(--matcha); animation: krPulse 2.2s infinite; }
      .kr-status-busy { background: var(--beni-bg); color: var(--beni-ink); }
      .kr-status-busy .kr-status-dot { background: var(--beni); }
      .kr-status-soon { background: var(--kogane-bg); color: var(--kogane-ink); }
      .kr-status-soon .kr-status-dot { background: var(--kogane); }
      @keyframes krPulse { 0% { box-shadow: 0 0 0 0 rgba(93, 122, 58, 0.55); } 70% { box-shadow: 0 0 0 8px rgba(93, 122, 58, 0); } 100% { box-shadow: 0 0 0 0 rgba(93, 122, 58, 0); } }
      .kr-card-floor { font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; color: var(--ink-mute); }
      .kr-card-name { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
      .kr-card-kanji { font-family: var(--serif); font-weight: 700; font-size: 38px; line-height: 1; letter-spacing: 0.02em; color: var(--ink); }
      .kr-card-romaji { font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em; color: var(--ink-mute); text-transform: lowercase; }
      .kr-card-body { font-size: 13px; }
      .kr-current-title { font-weight: 600; font-size: 14px; color: var(--ink); line-height: 1.4; margin-bottom: 4px; }
      .kr-current-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--ink-soft); margin-bottom: 8px; }
      .kr-current-remain { font-size: 11px; color: var(--beni-ink); font-weight: 500; letter-spacing: 0.04em; }
      .kr-current-remain em { font-style: normal; font-family: var(--mono); font-weight: 600; font-size: 13px; }
      .kr-free-line { font-size: 13px; color: var(--ink); font-weight: 500; }
      .kr-free-next { font-size: 11px; color: var(--ink-mute); margin-top: 4px; }
      .kr-tiny { font-size: 10px; }

      /* Timeline */
      .kr-timeline { margin: 14px 0 12px; }
      .kr-timeline-wrap { padding-top: 14px; }
      .kr-timeline-bar { position: relative; height: 6px; background: var(--bg-deep); border-radius: 2px; }
      .kr-timeline-tick { position: absolute; top: -14px; transform: translateX(-50%); font-family: var(--mono); font-size: 8px; color: var(--ink-faint); letter-spacing: 0.05em; }
      .kr-timeline-tick::after { content: ''; display: block; width: 1px; height: 4px; background: var(--ink-faint); margin: 2px auto 0; }
      .kr-timeline-block { position: absolute; top: 0; height: 6px; background: var(--beni); border-radius: 2px; opacity: 0.85; }
      .kr-tb-ended { background: var(--ink-faint); opacity: 0.6; }
      .kr-timeline-now { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink); z-index: 2; border-radius: 1px; }
      .kr-timeline-now::before { content: ''; position: absolute; top: -3px; left: 50%; transform: translateX(-50%); width: 7px; height: 7px; background: var(--ink); border-radius: 50%; border: 2px solid var(--surface); }

      .kr-card-bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border); }
      .kr-card-equip { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--ink-soft); font-family: var(--mono); letter-spacing: 0.05em; }
      .kr-equip-pill { background: var(--bg); border: 1px solid var(--border); padding: 2px 7px; border-radius: 3px; font-size: 10px; color: var(--ink-soft); letter-spacing: 0.03em; font-family: var(--sans); font-weight: 500; }
      .kr-card-cta { display: inline-flex; align-items: center; gap: 6px; background: var(--ink); color: var(--bg); padding: 9px 14px; border-radius: 3px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; transition: background 0.15s; white-space: nowrap; }
      .kr-card-cta-soft { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 1px solid var(--border); color: var(--ink-soft); padding: 8px 12px; border-radius: 3px; font-size: 11px; font-weight: 500; cursor: pointer; font-family: inherit; white-space: nowrap; transition: all 0.15s; }
      .kr-card-cta-soft:hover { border-color: var(--ink); color: var(--ink); }
      .kr-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
      .kr-empty { text-align: center; padding: 60px 20px; color: var(--ink-mute); font-size: 13px; }

      .kr-foot { margin-top: 40px; text-align: center; }
      .kr-foot-line { width: 24px; height: 1px; background: var(--ink-faint); margin: 0 auto 12px; }
      .kr-foot-text { font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em; color: var(--ink-faint); text-transform: uppercase; }

      /* Sheet */
      .kr-sheet-backdrop { position: fixed; inset: 0; background: rgba(20, 17, 12, 0.45); backdrop-filter: blur(4px); z-index: 100; display: flex; align-items: flex-end; justify-content: center; animation: krFadeBg 0.2s ease-out; }
      @keyframes krFadeBg { from { opacity: 0; } to { opacity: 1; } }
      .kr-sheet { background: var(--bg); width: 100%; max-width: 560px; max-height: 92vh; border-radius: 16px 16px 0 0; overflow-y: auto; position: relative; animation: krSheetUp 0.32s cubic-bezier(0.2, 0.9, 0.3, 1); box-shadow: 0 -12px 40px -10px rgba(0,0,0,0.25); }
      @media (min-width: 640px) { .kr-sheet-backdrop { align-items: center; } .kr-sheet { border-radius: 8px; max-height: 88vh; } }
      @keyframes krSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      .kr-sheet-handle { width: 36px; height: 4px; background: var(--ink-faint); border-radius: 2px; margin: 10px auto 0; }
      .kr-sheet-close { position: absolute; top: 16px; right: 16px; width: 32px; height: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ink-soft); z-index: 2; }
      .kr-sheet-close:hover { color: var(--ink); border-color: var(--ink); }
      .kr-sheet-head { padding: 24px 24px 20px; border-bottom: 1px solid var(--border-soft); }
      .kr-sheet-eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; color: var(--matcha); text-transform: uppercase; margin-bottom: 10px; }
      .kr-sheet-room { display: flex; flex-direction: column; gap: 6px; }
      .kr-sheet-room-name { font-family: var(--serif); font-weight: 700; font-size: 42px; line-height: 1; color: var(--ink); }
      .kr-sheet-room-romaji { font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em; color: var(--ink-mute); }
      .kr-sheet-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--ink-soft); margin-top: 12px; }
      .kr-sheet-body { padding: 24px; }
      .kr-field { margin-bottom: 22px; }
      .kr-field-label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; color: var(--ink-mute); text-transform: uppercase; margin-bottom: 10px; }
      .kr-field-optional { font-family: var(--sans); text-transform: none; font-weight: 400; letter-spacing: 0; font-size: 10px; }
      .kr-field-hint { font-size: 10px; color: var(--ink-mute); margin-top: 8px; letter-spacing: 0.04em; }
      .kr-time-display { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; }
      .kr-time-big { font-size: 26px; font-weight: 500; letter-spacing: 0.02em; }
      .kr-arrow { color: var(--ink-faint); font-size: 18px; }
      .kr-duration-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-bottom: 10px; }
      @media (max-width: 420px) { .kr-duration-grid { grid-template-columns: repeat(3, 1fr); } }
      .kr-dur { padding: 10px 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 3px; font-family: inherit; font-size: 12px; font-weight: 500; color: var(--ink-soft); cursor: pointer; transition: all 0.12s; }
      .kr-dur:hover { border-color: var(--ink-soft); color: var(--ink); }
      .kr-dur-on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
      .kr-stepper { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 3px; }
      .kr-stepper button { width: 28px; height: 28px; background: transparent; border: 1px solid var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--ink-soft); }
      .kr-stepper button:hover { border-color: var(--ink); color: var(--ink); }
      .kr-stepper span { font-size: 14px; font-weight: 500; min-width: 60px; text-align: center; }
      .kr-input { width: 100%; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 3px; font-family: var(--sans); font-size: 14px; color: var(--ink); outline: none; transition: border-color 0.12s; }
      .kr-input:focus { border-color: var(--ink); }
      .kr-input::placeholder { color: var(--ink-faint); }
      .kr-warn { background: var(--beni-bg); border-left: 3px solid var(--beni); padding: 12px 14px; border-radius: 3px; font-size: 12px; color: var(--beni-ink); margin-bottom: 16px; line-height: 1.5; }
      .kr-warn strong { display: block; margin-bottom: 4px; font-weight: 700; }
      .kr-preview { background: var(--bg-deep); border-radius: 4px; padding: 14px 16px; margin-top: 4px; }
      .kr-preview-label { font-family: var(--mono); font-size: 9px; letter-spacing: 0.18em; color: var(--ink-mute); text-transform: uppercase; margin-bottom: 10px; }
      .kr-preview-row { display: flex; gap: 14px; padding: 6px 0; font-size: 12px; border-top: 1px dashed var(--border); }
      .kr-preview-row:first-of-type { border-top: none; padding-top: 0; }
      .kr-preview-k { flex: 0 0 60px; color: var(--ink-mute); font-size: 11px; }
      .kr-preview-v { flex: 1; color: var(--ink); word-break: break-word; }
      .kr-sheet-foot { padding: 16px 24px 24px; border-top: 1px solid var(--border-soft); background: var(--bg); position: sticky; bottom: 0; }
      .kr-cta-primary { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; background: var(--ink); color: var(--bg); padding: 16px 20px; border-radius: 4px; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; text-decoration: none; transition: transform 0.12s, background 0.15s; }
      .kr-cta-primary:hover { background: var(--matcha-ink); }
      .kr-cta-primary:active { transform: scale(0.99); }
      .kr-cta-disabled { background: var(--ink-faint); cursor: not-allowed; pointer-events: auto; }
      .kr-cta-disabled:hover { background: var(--ink-faint); }
      .kr-cta-hint { text-align: center; font-size: 10px; color: var(--ink-mute); margin-top: 10px; letter-spacing: 0.08em; }

      /* Login */
      .kr-login { max-width: 380px; text-align: center; padding: 40px 24px; }
      .kr-login-mark { font-family: var(--serif); font-size: 48px; font-weight: 700; background: var(--ink); color: var(--bg); width: 80px; height: 80px; display: flex; align-items: center; justify-content: center; border-radius: 4px; margin: 0 auto 16px; }
      .kr-login-sub { font-family: var(--mono); font-size: 10px; letter-spacing: 0.24em; color: var(--ink-mute); text-transform: uppercase; margin-bottom: 28px; }
      .kr-login-title { font-family: var(--serif); font-weight: 500; font-size: 28px; line-height: 1.5; margin: 0 0 16px; color: var(--ink); }
      .kr-login-desc { font-size: 13px; color: var(--ink-soft); line-height: 1.7; margin: 0 0 28px; }
      .kr-login-btn { display: inline-flex; align-items: center; gap: 10px; background: var(--ink); color: var(--bg); padding: 14px 28px; border-radius: 4px; font-size: 14px; font-weight: 600; letter-spacing: 0.04em; border: none; cursor: pointer; font-family: inherit; transition: background 0.15s; }
      .kr-login-btn:hover { background: var(--matcha-ink); }
      .kr-login-note { font-family: var(--mono); font-size: 9px; letter-spacing: 0.16em; color: var(--ink-mute); margin-top: 16px; text-transform: uppercase; }

      /* Loading & Error */
      .kr-loading-inline { padding: 60px 20px; text-align: center; }
      .kr-loading { display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--ink-mute); font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; }
      .kr-error-banner { display: flex; align-items: flex-start; gap: 10px; background: var(--beni-bg); border-left: 3px solid var(--beni); color: var(--beni-ink); padding: 12px 14px; border-radius: 3px; font-size: 12px; margin-bottom: 18px; line-height: 1.5; }
      .kr-error-banner > div { flex: 1; }
      .kr-error-hint { font-size: 10px; margin-top: 4px; opacity: 0.85; }
      .kr-error-relogin { background: var(--beni-ink); color: var(--bg); border: none; padding: 6px 14px; border-radius: 3px; font-family: inherit; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; cursor: pointer; white-space: nowrap; transition: background 0.15s; }
      .kr-error-relogin:hover { background: var(--ink); }
      .kr-error-screen { max-width: 420px; text-align: center; color: var(--beni-ink); }
      .kr-error-screen h2 { font-family: var(--serif); font-weight: 600; margin: 12px 0 6px; }
      .kr-error-screen p { color: var(--ink-soft); font-size: 13px; margin: 0 0 24px; line-height: 1.6; }

      @media (min-width: 640px) {
        .kr-hero-title { font-size: 36px; }
        .kr-card-kanji { font-size: 44px; }
      }
    `}</style>
  );
}

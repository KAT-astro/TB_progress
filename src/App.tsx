"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type PageRange = { start: number; end: number; name?: string };

type Book = {
  id: string;
  title: string;
  pageRanges: PageRange[];
  goalDate: string;
  link: string;
};

type LegacyBook = Partial<Book> & {
  totalPages?: number;
  startPage?: number;
  endPage?: number;
};

type RangeDraft = { start: string; end: string; name: string };

type StudyEntry = {
  id: string;
  bookId: string;
  date: string;
  fromPage: number;
  toPage: number;
  label?: string;
  note: string;
};

type StoredState = {
  books: LegacyBook[];
  entries: StudyEntry[];
  activeBookId: string;
};

type GitHubUser = { login: string; avatar_url?: string };
type SyncStatus = "idle" | "checking" | "working" | "connected" | "error";

type RemoteDataFile = {
  app: "TB_progress";
  schemaVersion: 1;
  updatedAt: string;
  state: StoredState;
};

const STORAGE_KEY = "study-progress-v1";
const SYNC_CONFIG_KEY = "study-progress-github-sync-v1";
const SYNC_SESSION_KEY = "study-progress-github-session-v1";
const BOOK_COLORS = ["#ed6b51", "#3d3a56", "#d79745", "#62ad7c", "#8a70c4", "#4f8ea6"];
const emptyDraft = (): RangeDraft[] => [{ start: "", end: "", name: "" }];

const todayString = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function normalizeRanges(ranges: PageRange[]) {
  const sorted = ranges
    .map((range) => ({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), name: range.name?.trim() || undefined }))
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 1)
    .sort((a, b) => a.start - b.start);
  const merged: PageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else {
      last.end = Math.max(last.end, range.end);
      if (!last.name && range.name) last.name = range.name;
    }
  }
  return merged;
}

function rangesPageCount(ranges: PageRange[]) {
  return normalizeRanges(ranges).reduce((sum, range) => sum + range.end - range.start + 1, 0);
}

function rangeLabel(ranges: PageRange[]) {
  return normalizeRanges(ranges).map((range) => range.name || `p.${range.start}–${range.end}`).join("・");
}

function pageRangeCaption(range: PageRange) {
  const totalPages = range.end - range.start + 1;
  return `${range.name ? `${range.name}　` : ""}p.${range.start}–${range.end}（全${totalPages}ページ）`;
}

function parseDrafts(drafts: RangeDraft[]) {
  if (!drafts.length) return null;
  const ranges: PageRange[] = [];
  for (const draft of drafts) {
    const start = Number(draft.start);
    const end = Number(draft.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
    ranges.push({ start, end, name: draft.name.trim() || undefined });
  }
  return normalizeRanges(ranges);
}

function mergeStudyRanges(entries: StudyEntry[], allowedRanges: PageRange[]) {
  const clipped: PageRange[] = [];
  for (const entry of entries) {
    const entryStart = Math.min(entry.fromPage, entry.toPage);
    const entryEnd = Math.max(entry.fromPage, entry.toPage);
    for (const allowed of allowedRanges) {
      const start = Math.max(entryStart, allowed.start);
      const end = Math.min(entryEnd, allowed.end);
      if (start <= end) clipped.push({ start, end });
    }
  }
  const sorted = clipped.sort((a, b) => a.start - b.start);
  const merged: PageRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return { ranges: merged, coveredPages: rangesPageCount(merged) };
}

function getBookStats(book: Book, entries: StudyEntry[]) {
  const allowedRanges = normalizeRanges(book.pageRanges);
  const progress = mergeStudyRanges(entries.filter((entry) => entry.bookId === book.id), allowedRanges);
  const totalPages = rangesPageCount(allowedRanges);
  return { ...progress, totalPages, percentage: totalPages ? Math.min(100, Math.round((progress.coveredPages / totalPages) * 100)) : 0 };
}

function formatDate(date: string) {
  if (!date) return "日付不明";
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", weekday: "short" }).format(new Date(`${date}T00:00:00`));
}

function daysUntil(date: string) {
  const today = new Date(`${todayString()}T00:00:00`);
  const target = new Date(`${date}T00:00:00`);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(new Date(`${month}-01T00:00:00`));
}

function getMonthDays(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1).getDay();
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const cellCount = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  return Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstDay + 1;
    return day >= 1 && day <= daysInMonth ? `${month}-${String(day).padStart(2, "0")}` : "";
  });
}

function getBookColor(bookId: string, books: Book[]) {
  const index = books.findIndex((book) => book.id === bookId);
  return BOOK_COLORS[(index < 0 ? 0 : index) % BOOK_COLORS.length];
}

function normalizeSyncApiUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function migrateState(parsed: Partial<StoredState> | null | undefined) {
  const legacyBooks = Array.isArray(parsed?.books) ? parsed.books : [];
  const migratedBooks: Book[] = legacyBooks.map((book) => {
    const legacy = book as LegacyBook;
    const fallbackStart = Number.isInteger(legacy.startPage) ? Number(legacy.startPage) : 1;
    const fallbackEnd = Number.isInteger(legacy.endPage) ? Number(legacy.endPage) : Number.isInteger(legacy.totalPages) ? Number(legacy.totalPages) : fallbackStart;
    const pageRanges = Array.isArray(legacy.pageRanges) && legacy.pageRanges.length
      ? normalizeRanges(legacy.pageRanges)
      : [{ start: fallbackStart, end: Math.max(fallbackStart, fallbackEnd) }];
    return {
      id: String(legacy.id ?? makeId()),
      title: String(legacy.title ?? "参考書"),
      pageRanges,
      goalDate: String(legacy.goalDate ?? ""),
      link: String(legacy.link ?? ""),
    };
  });
  return {
    books: migratedBooks,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
    activeBookId: migratedBooks.some((book) => book.id === parsed?.activeBookId) ? String(parsed?.activeBookId) : migratedBooks[0]?.id ?? "",
  };
}

function unwrapRemoteState(value: unknown): Partial<StoredState> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { state?: unknown };
  const state = candidate.state && typeof candidate.state === "object" ? candidate.state : value;
  return state as Partial<StoredState>;
}

function makeRemoteData(books: Book[], entries: StudyEntry[], activeBookId: string): RemoteDataFile {
  return {
    app: "TB_progress",
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    state: { books, entries, activeBookId },
  };
}

type GitHubSyncPanelProps = {
  apiUrl: string;
  onApiUrlChange: (value: string) => void;
  connected: boolean;
  user: GitHubUser | null;
  autoSync: boolean;
  onAutoSyncChange: (value: boolean) => void;
  busy: boolean;
  status: SyncStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onLoad: () => void;
  onSave: () => void;
};

function GitHubSyncPanel({ apiUrl, onApiUrlChange, connected, user, autoSync, onAutoSyncChange, busy, status, onConnect, onDisconnect, onLoad, onSave }: GitHubSyncPanelProps) {
  const statusText = status === "checking" ? "接続を確認中…" : status === "working" ? "同期中…" : status === "error" ? "同期エラー" : connected ? "接続済み" : "未接続";
  return (
    <section className="sync-card card" aria-label="GitHub同期">
      <div className="sync-heading">
        <div><p className="eyebrow">PRIVATE BACKUP</p><h2>GitHubに自動同期</h2></div>
        <span className={`sync-pill ${connected ? "connected" : ""}`}><span className="status-dot" />{statusText}</span>
      </div>
      <p className="sync-copy">学習記録は端末にも保存し、接続するとprivateリポジトリ <strong>KAT-astro/TB_progress_data</strong> にバックアップできます。</p>
      <label className="sync-url-field">同期APIのURL（初回のみ）<input type="url" value={apiUrl} onChange={(event) => onApiUrlChange(event.target.value)} placeholder="https://あなたのworker.workers.dev" /></label>
      {!connected ? (
        <div className="sync-actions"><button className="outline-button" type="button" onClick={onConnect} disabled={busy || !apiUrl.trim()}>GitHubで接続</button><span className="sync-helper">Worker URLを入力してから接続してください。</span></div>
      ) : (
        <>
          <div className="sync-user"><span>GitHub: <strong>@{user?.login ?? "接続中"}</strong></span><button className="link-cancel-button" type="button" onClick={onDisconnect}>接続を解除</button></div>
          <div className="sync-actions sync-actions-connected"><button className="outline-button" type="button" onClick={onLoad} disabled={busy}>GitHubから読み込む</button><button className="primary-button" type="button" onClick={onSave} disabled={busy}>GitHubへ保存</button><label className="sync-checkbox"><input type="checkbox" checked={autoSync} onChange={(event) => onAutoSyncChange(event.target.checked)} />変更時に自動同期</label></div>
        </>
      )}
      <p className="sync-note">保存先: <code>TB_progress_data/study-data.json</code> · {connected ? "この端末から安全に読み書きします" : "同期しない間も端末内では使えます"}</p>
    </section>
  );
}

export default function Home() {
  const [books, setBooks] = useState<Book[]>([]);
  const [entries, setEntries] = useState<StudyEntry[]>([]);
  const [activeBookId, setActiveBookId] = useState("");
  const [isReady, setIsReady] = useState(false);
  const [showBookForm, setShowBookForm] = useState(false);
  const [showBookSettings, setShowBookSettings] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [rangeDrafts, setRangeDrafts] = useState<RangeDraft[]>(emptyDraft);
  const [bookLink, setBookLink] = useState("");
  const [settingsTitle, setSettingsTitle] = useState("");
  const [settingsRanges, setSettingsRanges] = useState<RangeDraft[]>(emptyDraft);
  const [settingsLink, setSettingsLink] = useState("");
  const [studyDate, setStudyDate] = useState(todayString());
  const [studyDateUnknown, setStudyDateUnknown] = useState(false);
  const [fromPage, setFromPage] = useState("");
  const [toPage, setToPage] = useState("");
  const [studyLabel, setStudyLabel] = useState("");
  const [note, setNote] = useState("");
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editDateUnknown, setEditDateUnknown] = useState(false);
  const [editFromPage, setEditFromPage] = useState("");
  const [editToPage, setEditToPage] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [editNote, setEditNote] = useState("");
  const [message, setMessage] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(todayString().slice(0, 7));
  const [selectedCalendarDate, setSelectedCalendarDate] = useState(todayString());
  const [showCalendar, setShowCalendar] = useState(false);
  const [syncApiUrl, setSyncApiUrl] = useState("");
  const [syncSession, setSyncSession] = useState("");
  const [syncUser, setSyncUser] = useState<GitHubUser | null>(null);
  const [autoSync, setAutoSync] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const syncPopupRef = useRef<Window | null>(null);
  const syncBusyRef = useRef(false);
  const lastSyncedFingerprintRef = useRef("");
  const syncSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const migrated = migrateState(JSON.parse(saved) as StoredState);
        setBooks(migrated.books);
        setEntries(migrated.entries);
        setActiveBookId(migrated.activeBookId);
      }
      const savedSyncConfig = window.localStorage.getItem(SYNC_CONFIG_KEY);
      if (savedSyncConfig) {
        const config = JSON.parse(savedSyncConfig) as { apiUrl?: string; autoSync?: boolean };
        setSyncApiUrl(normalizeSyncApiUrl(String(config.apiUrl ?? "")));
        setAutoSync(Boolean(config.autoSync));
      }
      const savedSession = window.sessionStorage.getItem(SYNC_SESSION_KEY);
      if (savedSession) setSyncSession(savedSession);
    } catch {
      // If stored data is damaged, start with an empty local notebook.
    } finally {
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!isReady) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ books, entries, activeBookId } satisfies StoredState));
  }, [books, entries, activeBookId, isReady]);

  useEffect(() => {
    if (!isReady) return;
    window.localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify({ apiUrl: normalizeSyncApiUrl(syncApiUrl), autoSync }));
  }, [syncApiUrl, autoSync, isReady]);

  useEffect(() => {
    if (!syncSession) {
      window.sessionStorage.removeItem(SYNC_SESSION_KEY);
      return;
    }
    window.sessionStorage.setItem(SYNC_SESSION_KEY, syncSession);
  }, [syncSession]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== "tb-github-auth" && event.data?.type !== "tb-github-auth-error") return;
      let apiOrigin = "";
      try {
        apiOrigin = new URL(normalizeSyncApiUrl(syncApiUrl)).origin;
      } catch {
        return;
      }
      if (event.origin !== apiOrigin) return;
      if (event.data.type === "tb-github-auth-error") {
        setSyncBusy(false);
        syncBusyRef.current = false;
        setSyncStatus("error");
        flash(typeof event.data.message === "string" ? event.data.message : "GitHub接続に失敗しました");
        return;
      }
      if (typeof event.data.session !== "string") return;
      setSyncSession(event.data.session);
      setSyncStatus("checking");
      setSyncBusy(false);
      syncBusyRef.current = false;
      syncPopupRef.current = null;
      flash("GitHubに接続しました");
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [syncApiUrl]);

  const activeBook = books.find((book) => book.id === activeBookId) ?? books[0];
  const activeAllowedRanges = activeBook ? normalizeRanges(activeBook.pageRanges) : [];
  const activeEntries = useMemo(() => activeBook ? entries.filter((entry) => entry.bookId === activeBook.id) : [], [activeBook, entries]);
  const progress = useMemo(() => mergeStudyRanges(activeEntries, activeAllowedRanges), [activeEntries, activeAllowedRanges]);
  const activeTotalPages = rangesPageCount(activeAllowedRanges);
  const percentage = activeTotalPages ? Math.min(100, Math.round((progress.coveredPages / activeTotalPages) * 100)) : 0;
  const remainingPages = Math.max(0, activeTotalPages - progress.coveredPages);
  const remainingDays = activeBook?.goalDate ? daysUntil(activeBook.goalDate) : null;
  const pagesPerDay = remainingDays && remainingDays > 0 ? Math.ceil(remainingPages / remainingDays) : null;

  const allBookStats = useMemo(() => books.map((book) => ({ book, stats: getBookStats(book, entries) })), [books, entries]);
  const allPages = allBookStats.reduce((sum, item) => sum + item.stats.totalPages, 0);
  const allCoveredPages = allBookStats.reduce((sum, item) => sum + item.stats.coveredPages, 0);
  const allPercentage = allPages ? Math.min(100, Math.round((allCoveredPages / allPages) * 100)) : 0;

  const calendarDays = useMemo(() => getMonthDays(calendarMonth), [calendarMonth]);
  const calendarEntriesByDate = useMemo(() => {
    const grouped: Record<string, StudyEntry[]> = {};
    for (const entry of entries) {
      if (!entry.date) continue;
      (grouped[entry.date] ??= []).push(entry);
    }
    return grouped;
  }, [entries]);
  const selectedCalendarEntries = calendarEntriesByDate[selectedCalendarDate] ?? [];
  const selectedCalendarGoals = books.filter((book) => book.goalDate === selectedCalendarDate);

  const pageMapGroups = useMemo(() => activeAllowedRanges.map((range) => {
    const total = range.end - range.start + 1;
    const count = Math.min(300, total);
    const segments = Array.from({ length: count }, (_, index) => {
      const start = range.start + Math.floor((index * total) / count);
      const end = range.start + Math.floor(((index + 1) * total) / count) - 1;
      const studyCount = activeEntries.filter((entry) => entry.fromPage <= end && entry.toPage >= start).length;
      return { start, end, studyCount };
    });
    return { range, segments };
  }), [activeAllowedRanges, activeEntries]);

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 2600);
  };

  const stateFingerprint = useMemo(() => JSON.stringify({ books, entries, activeBookId }), [books, entries, activeBookId]);

  async function syncRequest(path: string, init: RequestInit = {}, apiUrlOverride = syncApiUrl, sessionOverride = syncSession) {
    const base = normalizeSyncApiUrl(apiUrlOverride);
    if (!base) throw new Error("同期APIのURLを入力してください");
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (sessionOverride) headers.set("Authorization", `Bearer ${sessionOverride}`);
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `同期APIが応答しません（${response.status}）`);
    return payload;
  }

  async function verifySyncSession(apiUrl = syncApiUrl, session = syncSession) {
    if (!apiUrl || !session) return;
    setSyncStatus("checking");
    try {
      const payload = await syncRequest("/api/me", {}, apiUrl, session) as { user?: GitHubUser };
      setSyncUser(payload.user ?? null);
      setSyncStatus("connected");
    } catch {
      setSyncSession("");
      setSyncUser(null);
      setAutoSync(false);
      setSyncStatus("error");
      flash("GitHub接続の期限が切れました。もう一度接続してください。");
    }
  }

  function connectGitHub() {
    const base = normalizeSyncApiUrl(syncApiUrl);
    if (!base) {
      setSyncStatus("error");
      flash("先に同期APIのURLを入力してください");
      return;
    }
    const popup = window.open(`${base}/auth/start`, "tb-progress-github-auth", "popup,width=520,height=720");
    if (!popup) {
      flash("ポップアップがブロックされました。ブラウザの設定で許可してください。");
      return;
    }
    syncPopupRef.current = popup;
    setSyncBusy(true);
    syncBusyRef.current = true;
    setSyncStatus("checking");
  }

  function disconnectGitHub() {
    setSyncSession("");
    setSyncUser(null);
    setAutoSync(false);
    setSyncStatus("idle");
    setSyncBusy(false);
    syncBusyRef.current = false;
    flash("GitHubとの接続を解除しました");
  }

  async function loadGitHubData() {
    if (!syncSession || !syncApiUrl || syncBusyRef.current) return;
    if (!window.confirm("GitHubのデータで、この端末の学習記録を置き換えますか？")) return;
    setSyncBusy(true);
    syncBusyRef.current = true;
    setSyncStatus("working");
    try {
      const payload = await syncRequest("/api/data") as { exists?: boolean; data?: unknown };
      if (!payload.exists || !payload.data) {
        flash("GitHubに保存データがまだありません");
        setSyncStatus("connected");
        return;
      }
      const migrated = migrateState(unwrapRemoteState(payload.data));
      setBooks(migrated.books);
      setEntries(migrated.entries);
      setActiveBookId(migrated.activeBookId);
      lastSyncedFingerprintRef.current = JSON.stringify({ books: migrated.books, entries: migrated.entries, activeBookId: migrated.activeBookId });
      setSyncStatus("connected");
      flash("GitHubから学習記録を読み込みました");
    } catch (error) {
      setSyncStatus("error");
      flash(error instanceof Error ? error.message : "GitHubからの読み込みに失敗しました");
    } finally {
      setSyncBusy(false);
      syncBusyRef.current = false;
    }
  }

  async function saveGitHubData(showToast = true) {
    if (!syncSession || !syncApiUrl || syncBusyRef.current) return;
    setSyncBusy(true);
    syncBusyRef.current = true;
    setSyncStatus("working");
    try {
      await syncRequest("/api/data", { method: "PUT", body: JSON.stringify({ data: makeRemoteData(books, entries, activeBookId) }) });
      lastSyncedFingerprintRef.current = stateFingerprint;
      setSyncStatus("connected");
      if (showToast) flash("GitHubに学習記録を保存しました");
    } catch (error) {
      setSyncStatus("error");
      flash(error instanceof Error ? error.message : "GitHubへの保存に失敗しました");
    } finally {
      setSyncBusy(false);
      syncBusyRef.current = false;
    }
  }

  useEffect(() => {
    if (!isReady || !syncSession || !syncApiUrl) return;
    void verifySyncSession();
  }, [isReady, syncSession, syncApiUrl]);

  useEffect(() => {
    if (!isReady || !autoSync || !syncSession || !syncApiUrl || stateFingerprint === lastSyncedFingerprintRef.current) return;
    if (syncSaveTimerRef.current) window.clearTimeout(syncSaveTimerRef.current);
    syncSaveTimerRef.current = window.setTimeout(() => {
      syncSaveTimerRef.current = null;
      void saveGitHubData(false);
    }, 1200);
    return () => {
      if (syncSaveTimerRef.current) window.clearTimeout(syncSaveTimerRef.current);
      syncSaveTimerRef.current = null;
    };
  }, [isReady, autoSync, syncSession, syncApiUrl, stateFingerprint]);

  function moveCalendarMonth(amount: number) {
    const [year, month] = calendarMonth.split("-").map(Number);
    const nextDate = new Date(year, month - 1 + amount, 1);
    const nextMonth = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;
    setCalendarMonth(nextMonth);
    setSelectedCalendarDate(`${nextMonth}-01`);
  }

  function showTodayOnCalendar() {
    const today = todayString();
    setCalendarMonth(today.slice(0, 7));
    setSelectedCalendarDate(today);
  }

  const updateDraft = (setter: (value: RangeDraft[]) => void, drafts: RangeDraft[], index: number, key: "start" | "end" | "name", value: string) => {
    setter(drafts.map((draft, draftIndex) => draftIndex === index ? { ...draft, [key]: value } : draft));
  };

  function addRangeDraft(setter: (value: RangeDraft[]) => void, drafts: RangeDraft[]) {
    setter([...drafts, { start: "", end: "", name: "" }]);
  }

  function removeRangeDraft(setter: (value: RangeDraft[]) => void, drafts: RangeDraft[], index: number) {
    setter(drafts.length > 1 ? drafts.filter((_, draftIndex) => draftIndex !== index) : emptyDraft());
  }

  function addBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pageRanges = parseDrafts(rangeDrafts);
    const link = bookLink.trim();
    if (!bookTitle.trim() || !pageRanges) {
      setMessage("本の名前と、ページ区間を正しく入力してください");
      return;
    }
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      setMessage("リンクはhttps://またはhttp://から入力してください");
      return;
    }
    const book: Book = { id: makeId(), title: bookTitle.trim(), pageRanges, goalDate: "", link };
    setBooks((current) => [...current, book]);
    setActiveBookId(book.id);
    setBookTitle("");
    setRangeDrafts(emptyDraft());
    setBookLink("");
    setShowBookForm(false);
    flash("参考書を追加しました");
  }

  function openBookSettings() {
    if (!activeBook) return;
    setSettingsTitle(activeBook.title);
    setSettingsRanges(activeBook.pageRanges.map((range) => ({ start: String(range.start), end: String(range.end), name: range.name ?? "" })));
    setSettingsLink(activeBook.link);
    setShowBookSettings(true);
  }

  function saveBookSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeBook) return;
    const pageRanges = parseDrafts(settingsRanges);
    const link = settingsLink.trim();
    if (!settingsTitle.trim() || !pageRanges) {
      setMessage("本の名前と、ページ区間を正しく入力してください");
      return;
    }
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      setMessage("リンクはhttps://またはhttp://から入力してください");
      return;
    }
    setBooks((current) => current.map((book) => book.id === activeBook.id ? { ...book, title: settingsTitle.trim(), pageRanges, link } : book));
    setShowBookSettings(false);
    flash("参考書の設定を更新しました");
  }

  function addStudyEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeBook) return;
    const start = Number(fromPage);
    const end = Number(toPage || fromPage);
    if (!studyDateUnknown && !studyDate) {
      setMessage("日付を入力するか、「日付不明」にチェックしてください");
      return;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      setMessage("ページ番号を入力してください");
      return;
    }
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const containingRange = activeAllowedRanges.some((range) => low >= range.start && high <= range.end);
    if (!containingRange) {
      setMessage("学習記録は、登録した1つのページ区間内に収めてください");
      return;
    }
    setEntries((current) => [...current, { id: makeId(), bookId: activeBook.id, date: studyDateUnknown ? "" : studyDate, fromPage: low, toPage: high, label: studyLabel.trim() || undefined, note: note.trim() }]);
    setFromPage("");
    setToPage("");
    setStudyLabel("");
    setNote("");
    setStudyDateUnknown(false);
    setStudyDate(todayString());
    flash(`${low}〜${high}ページを記録しました`);
  }

  function fillNextPages() {
    if (!activeBook || !activeAllowedRanges.length) return;
    const candidate = progress.ranges.length ? progress.ranges[progress.ranges.length - 1].end + 1 : activeAllowedRanges[0].start;
    const range = activeAllowedRanges.find((allowed) => allowed.end >= candidate) ?? activeAllowedRanges[activeAllowedRanges.length - 1];
    const start = Math.max(range.start, Math.min(candidate, range.end));
    setFromPage(String(start));
    setToPage(String(Math.min(start + 9, range.end)));
  }

  function startEditingEntry(entry: StudyEntry) {
    setEditingEntryId(entry.id);
    setEditDate(entry.date);
    setEditDateUnknown(!entry.date);
    setEditFromPage(String(entry.fromPage));
    setEditToPage(String(entry.toPage));
    setEditLabel(entry.label ?? "");
    setEditNote(entry.note ?? "");
  }

  function cancelEditingEntry() {
    setEditingEntryId(null);
    setEditDate("");
    setEditDateUnknown(false);
    setEditFromPage("");
    setEditToPage("");
    setEditLabel("");
    setEditNote("");
  }

  function saveEditedEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingEntryId || !activeBook) return;
    const start = Number(editFromPage);
    const end = Number(editToPage || editFromPage);
    if ((!editDateUnknown && !editDate) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
      setMessage("日付とページ番号を正しく入力してください");
      return;
    }
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const containingRange = activeAllowedRanges.some((range) => low >= range.start && high <= range.end);
    if (!containingRange) {
      setMessage("学習記録は、登録した1つのページ区間内に収めてください");
      return;
    }
    setEntries((current) => current.map((entry) => entry.id === editingEntryId ? { ...entry, date: editDateUnknown ? "" : editDate, fromPage: low, toPage: high, label: editLabel.trim() || undefined, note: editNote.trim() } : entry));
    cancelEditingEntry();
    flash(`${low}〜${high}ページの記録を変更しました`);
  }

  function updateGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeBook) return;
    const data = new FormData(event.currentTarget);
    const goalDate = String(data.get("goalDate") ?? "");
    setBooks((current) => current.map((book) => book.id === activeBook.id ? { ...book, goalDate } : book));
    flash(goalDate ? "読了目標を保存しました" : "目標をクリアしました");
  }

  function removeEntry(id: string) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    const pageText = entry.fromPage === entry.toPage ? `${entry.fromPage}ページ` : `${entry.fromPage}〜${entry.toPage}ページ`;
    if (!window.confirm(`${entry.date || "日付不明"}\n${entry.label ? `${entry.label}（${pageText}）` : pageText}\nこの学習記録を削除しますか？`)) return;
    setEntries((current) => current.filter((entry) => entry.id !== id));
    if (editingEntryId === id) cancelEditingEntry();
    flash("記録を削除しました");
  }

  function removeBook() {
    if (!activeBook) return;
    if (!window.confirm(`「${activeBook.title}」と学習記録を削除しますか？`)) return;
    const remaining = books.filter((book) => book.id !== activeBook.id);
    setBooks(remaining);
    setEntries((current) => current.filter((entry) => entry.bookId !== activeBook.id));
    setActiveBookId(remaining[0]?.id ?? "");
    setShowBookSettings(false);
    flash("参考書を削除しました");
  }

  if (!isReady) return <main className="loading-screen">読み込み中…</main>;

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">◒</div>
        <div><p className="brand-name">べんきょう帳</p><p className="brand-caption">Study progress, made simple.</p></div>
        <span className="local-badge"><span className="status-dot" />{syncSession ? "GitHubと同期中" : "端末内に保存"}</span>
      </header>

      <div className="content-wrap">
        {books.length === 0 ? (
          <section className="onboarding-card">
            <div className="onboarding-icon" aria-hidden="true">✦</div>
            <div><p className="eyebrow">START HERE</p><h2>まずは参考書を登録しましょう</h2><p>本の名前と、勉強するページ区間を入れると、あなた専用の進捗帳が始まります。</p></div>
            <form className="book-form first-book-form" onSubmit={addBook}>
              <label className="book-title-field">参考書の名前<input value={bookTitle} onChange={(event) => setBookTitle(event.target.value)} placeholder="例：宇宙物理学 入門" /></label>
              <div className="range-builder"><span className="field-label">勉強するページ区間</span>{rangeDrafts.map((draft, index) => <div className="range-input-row" key={index}><input type="number" min="1" inputMode="numeric" value={draft.start} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "start", event.target.value)} placeholder="開始" aria-label={`区間${index + 1}の開始ページ`} /><span>〜</span><input type="number" min="1" inputMode="numeric" value={draft.end} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "end", event.target.value)} placeholder="終了" aria-label={`区間${index + 1}の終了ページ`} /><input className="range-name-input" value={draft.name} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "name", event.target.value)} placeholder="区間名（任意）" aria-label={`区間${index + 1}の名前`} />{index > 0 && <button className="remove-range-button" type="button" onClick={() => removeRangeDraft(setRangeDrafts, rangeDrafts, index)} aria-label={`区間${index + 1}を削除`}>×</button>}</div>)}<button className="add-range-button" type="button" onClick={() => addRangeDraft(setRangeDrafts, rangeDrafts)}>＋ 区間を追加</button></div>
              <label className="book-link-field">リンク（任意）<input type="url" value={bookLink} onChange={(event) => setBookLink(event.target.value)} placeholder="https://…" /></label>
              <button className="primary-button" type="submit">参考書を登録する <span>→</span></button>
            </form>
          </section>
        ) : (
          <>
            <section className="book-switcher">
              <button className="quiet-button" type="button" onClick={() => setShowBookForm((value) => !value)}>＋ 参考書を追加</button>
            </section>

            {showBookForm && <form className="inline-book-form" onSubmit={addBook}><input value={bookTitle} onChange={(event) => setBookTitle(event.target.value)} placeholder="参考書の名前" aria-label="参考書の名前" /><div className="compact-range-builder">{rangeDrafts.map((draft, index) => <div className="range-input-row" key={index}><input type="number" min="1" inputMode="numeric" value={draft.start} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "start", event.target.value)} placeholder="開始" aria-label={`追加する区間${index + 1}の開始ページ`} /><span>〜</span><input type="number" min="1" inputMode="numeric" value={draft.end} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "end", event.target.value)} placeholder="終了" aria-label={`追加する区間${index + 1}の終了ページ`} /><input className="range-name-input" value={draft.name} onChange={(event) => updateDraft(setRangeDrafts, rangeDrafts, index, "name", event.target.value)} placeholder="区間名（任意）" aria-label={`追加する区間${index + 1}の名前`} />{index > 0 && <button className="remove-range-button" type="button" onClick={() => removeRangeDraft(setRangeDrafts, rangeDrafts, index)} aria-label={`追加する区間${index + 1}を削除`}>×</button>}</div>)}<button className="add-range-button" type="button" onClick={() => addRangeDraft(setRangeDrafts, rangeDrafts)}>＋ 区間を追加</button></div><input type="url" value={bookLink} onChange={(event) => setBookLink(event.target.value)} placeholder="リンク（任意）" aria-label="参考書リンク" /><button className="small-primary" type="submit">追加</button></form>}

            {showBookSettings && activeBook && <form className="book-settings-card card" onSubmit={saveBookSettings}><div className="section-heading"><div><p className="eyebrow">BOOK SETTINGS</p><h2>参考書を編集</h2></div><button className="link-cancel-button" type="button" onClick={() => setShowBookSettings(false)}>閉じる</button></div><label>参考書の名前<input value={settingsTitle} onChange={(event) => setSettingsTitle(event.target.value)} /></label><div className="range-builder settings-range-builder"><span className="field-label">勉強するページ区間</span>{settingsRanges.map((draft, index) => <div className="range-input-row" key={index}><input type="number" min="1" inputMode="numeric" value={draft.start} onChange={(event) => updateDraft(setSettingsRanges, settingsRanges, index, "start", event.target.value)} aria-label={`設定区間${index + 1}の開始ページ`} /><span>〜</span><input type="number" min="1" inputMode="numeric" value={draft.end} onChange={(event) => updateDraft(setSettingsRanges, settingsRanges, index, "end", event.target.value)} aria-label={`設定区間${index + 1}の終了ページ`} /><input className="range-name-input" value={draft.name} onChange={(event) => updateDraft(setSettingsRanges, settingsRanges, index, "name", event.target.value)} placeholder="区間名（任意）" aria-label={`設定区間${index + 1}の名前`} />{index > 0 && <button className="remove-range-button" type="button" onClick={() => removeRangeDraft(setSettingsRanges, settingsRanges, index)} aria-label={`設定区間${index + 1}を削除`}>×</button>}</div>)}<button className="add-range-button" type="button" onClick={() => addRangeDraft(setSettingsRanges, settingsRanges)}>＋ 区間を追加</button></div><label>リンク（任意）<input type="url" value={settingsLink} onChange={(event) => setSettingsLink(event.target.value)} placeholder="https://…" /></label><div className="settings-actions"><button className="primary-button" type="submit">変更を保存</button><button className="link-cancel-button" type="button" onClick={() => setShowBookSettings(false)}>キャンセル</button></div></form>}

            <section className="all-books-card card"><div className="section-heading overview-heading"><div><p className="eyebrow">ALL BOOKS</p><h2>すべての参考書</h2></div><div className="overall-summary"><strong>{allPercentage}%</strong><span>全体<br />{allCoveredPages}/{allPages}ページ</span></div></div><div className="book-progress-list">{allBookStats.map(({ book, stats }) => <div className={`book-progress-row ${book.id === activeBook?.id ? "selected" : ""}`} key={book.id}><button className="book-progress-main" type="button" onClick={() => { setActiveBookId(book.id); setShowBookSettings(false); }} aria-label={`${book.title}の進捗を表示`}><div className="book-progress-head"><strong>{book.title}</strong><span>{stats.percentage}%</span></div><div className="book-progress-meta"><span>{rangeLabel(book.pageRanges)}</span><span>{stats.coveredPages}/{stats.totalPages}ページ</span></div><div className="book-progress-bar"><span style={{ width: `${stats.percentage}%` }} /></div></button>{book.link && <a className="book-link" href={book.link} target="_blank" rel="noreferrer">↗ リンクを開く</a>}</div>)}</div></section>

            <div className="calendar-toggle-row"><button className="calendar-toggle-button" type="button" onClick={() => setShowCalendar((value) => !value)} aria-expanded={showCalendar}>{showCalendar ? "− カレンダーを閉じる" : "＋ カレンダーを表示"}</button></div>
            {showCalendar && <section className="calendar-card card"><div className="section-heading calendar-heading"><div><p className="eyebrow">STUDY CALENDAR</p><h2>学習カレンダー</h2><p className="calendar-subcopy">学習日・ページ区間・目標日をまとめて確認できます。</p></div><div className="calendar-actions"><button className="calendar-nav-button" type="button" onClick={() => moveCalendarMonth(-1)} aria-label="前の月">‹</button><strong>{monthLabel(calendarMonth)}</strong><button className="calendar-nav-button" type="button" onClick={() => moveCalendarMonth(1)} aria-label="次の月">›</button><button className="calendar-today-button" type="button" onClick={showTodayOnCalendar}>今日</button></div></div><div className="calendar-weekdays">{["日", "月", "火", "水", "木", "金", "土"].map((weekday) => <span key={weekday}>{weekday}</span>)}</div><div className="calendar-grid">{calendarDays.map((date, index) => { if (!date) return <div className="calendar-day calendar-day-empty" key={`empty-${index}`} />; const dayEntries = calendarEntriesByDate[date] ?? []; const dayGoals = books.filter((book) => book.goalDate === date); const bookIds = [...new Set(dayEntries.map((entry) => entry.bookId))]; return <button className={`calendar-day ${selectedCalendarDate === date ? "selected" : ""} ${date === todayString() ? "today" : ""}`} type="button" key={date} onClick={() => setSelectedCalendarDate(date)} aria-label={`${formatDate(date)}の学習記録を表示`} aria-pressed={selectedCalendarDate === date}><span className="calendar-day-number">{Number(date.slice(-2))}</span><span className="calendar-day-markers">{bookIds.slice(0, 3).map((bookId) => <i className="calendar-book-dot" style={{ background: getBookColor(bookId, books) }} key={bookId} />)}{bookIds.length > 3 && <span className="calendar-more-count">+{bookIds.length - 3}</span>}{dayEntries.length > 0 && <span className="calendar-entry-count">{dayEntries.length}件</span>}{dayGoals.length > 0 && <span className="calendar-goal-marker" title="読了目標">⌁</span>}</span></button> })}</div><div className="calendar-legend"><span><i className="calendar-legend-dot" />学習記録（参考書ごとに色分け）</span><span><i className="calendar-goal-marker">⌁</i>読了目標日</span></div><div className="calendar-detail"><div className="calendar-detail-heading"><div><span className="mini-label">SELECTED DATE</span><h3>{formatDate(selectedCalendarDate)}</h3></div><span className="activity-count">{selectedCalendarEntries.length}件</span></div>{selectedCalendarEntries.length === 0 && selectedCalendarGoals.length === 0 ? <p className="calendar-empty-detail">この日の学習記録はありません。</p> : <div className="calendar-event-list">{selectedCalendarEntries.map((entry) => { const book = books.find((item) => item.id === entry.bookId); const pageText = entry.fromPage === entry.toPage ? `${entry.fromPage}ページ` : `${entry.fromPage}–${entry.toPage}ページ`; return <div className="calendar-event" key={entry.id}><i className="calendar-event-dot" style={{ background: getBookColor(entry.bookId, books) }} /><div><strong>{book?.title ?? "参考書"}</strong><span>{entry.label || pageText}</span>{entry.label && <small>{pageText}</small>}{entry.note && <small>{entry.note}</small>}</div></div> })}{selectedCalendarGoals.map((book) => <div className="calendar-event calendar-goal-event" key={`goal-${book.id}`}><i className="calendar-event-dot calendar-goal-dot">⌁</i><div><strong>{book.title}</strong><span>読了目標日</span></div></div>)}</div>}</div></section>}

            <section className="dashboard-grid"><article className="progress-card card"><div className="card-heading"><div><p className="eyebrow">CURRENT PROGRESS</p><h2>{activeBook?.title}</h2><div className="active-link-actions">{activeBook?.link && <a className="active-book-link" href={activeBook.link} target="_blank" rel="noreferrer">↗ 登録したリンクを開く</a>}<button className="link-edit-button" type="button" onClick={openBookSettings}>{activeBook?.link ? "設定を編集" : "＋ リンク・区間を編集"}</button></div></div><span className="book-page-count">{rangeLabel(activeBook?.pageRanges ?? [])}</span></div><div className="progress-main"><div className="progress-ring" style={{ background: `conic-gradient(#ed6b51 ${percentage}%, #ebe5db ${percentage}% 100%)` }}><div className="ring-inner"><strong>{percentage}<small>%</small></strong><span>読了</span></div></div><div className="progress-stats"><div><strong>{progress.coveredPages}</strong><span>学習済みページ</span></div><div><strong>{remainingPages}</strong><span>残りページ</span></div></div></div><div className="page-map-box"><div className="map-header"><div><span className="mini-label">PAGE MAP</span><strong>学習したページ</strong></div><div className="map-legend"><span><i className="legend-swatch studied" />1回</span><span><i className="legend-swatch repeat-two" />2回</span><span><i className="legend-swatch repeat-three" />3回以上</span><span><i className="legend-swatch" />未学習</span></div></div>{pageMapGroups.map((group) => <div className="page-map-group" key={`${group.range.start}-${group.range.end}`}><div className="page-map-range-label">{pageRangeCaption(group.range)}</div><div className="page-map" style={{ gridTemplateColumns: `repeat(${group.segments.length}, minmax(0, 1fr))` }} aria-label={`${group.range.start}〜${group.range.end}ページのマップ`}>{group.segments.map((segment) => <span className={`page-segment ${segment.studyCount === 1 ? "studied" : ""} ${segment.studyCount === 2 ? "repeat-two" : ""} ${segment.studyCount >= 3 ? "repeat-three" : ""}`} key={`${segment.start}-${segment.end}`} title={`${segment.start}〜${segment.end}ページ（学習${segment.studyCount}回）`} />)}</div></div>)}</div><div className="range-summary"><span className="summary-icon">↗</span><div><span className="mini-label">学習した範囲</span><strong>{progress.ranges.length ? progress.ranges.map((range) => `${range.start}–${range.end}ページ`).join("・") : "まだ記録がありません"}</strong></div></div></article><article className="goal-card card"><div className="card-heading"><div><p className="eyebrow">READING GOAL</p><h2>読了目標</h2></div><span className="target-icon">⌁</span></div><form onSubmit={updateGoal} className="goal-form"><label>この本を読み終える日<input name="goalDate" type="date" value={activeBook?.goalDate ?? ""} onChange={(event) => setBooks((current) => current.map((book) => book.id === activeBook?.id ? { ...book, goalDate: event.target.value } : book))} /></label>{activeBook?.goalDate ? <div className="goal-result"><strong>{remainingDays !== null && remainingDays >= 0 ? `${remainingDays}日` : "期限超過"}</strong><span>あと{remainingPages}ページ<br />1日 約{pagesPerDay ?? 0}ページ</span></div> : <p className="goal-hint">目標日を決めると、1日の目安を計算します。</p>}<button className="outline-button" type="submit">目標を保存</button></form></article></section>

            <section className="lower-grid"><article className="log-card card"><div className="section-heading"><div><p className="eyebrow">ADD STUDY LOG</p><h2>勉強したページを記録</h2></div><span className="pencil-icon">✎</span></div><form className="study-form" onSubmit={addStudyEntry}><div className="date-input-row">
<label className="date-field">日付<input type="date" value={studyDate} disabled={studyDateUnknown} onChange={(event) => setStudyDate(event.target.value)} /></label>
<label className="unknown-date-toggle"><input type="checkbox" checked={studyDateUnknown} onChange={(event) => { const unknown = event.target.checked; setStudyDateUnknown(unknown); if (unknown) setStudyDate(""); else if (!studyDate) setStudyDate(todayString()); }} />日付不明</label>
</div><div className="page-fields"><label>開始ページ<input type="number" min={activeAllowedRanges[0]?.start} max={activeAllowedRanges.at(-1)?.end} inputMode="numeric" value={fromPage} onChange={(event) => setFromPage(event.target.value)} placeholder={String(activeAllowedRanges[0]?.start ?? 1)} /></label><span>〜</span><label>終了ページ<input type="number" min={activeAllowedRanges[0]?.start} max={activeAllowedRanges.at(-1)?.end} inputMode="numeric" value={toPage} onChange={(event) => setToPage(event.target.value)} placeholder={String(activeAllowedRanges[0]?.end ?? 1)} /></label></div><button className="next-button" type="button" onClick={fillNextPages}>次の10ページを入力</button><label>区間名（任意）<input value={studyLabel} onChange={(event) => setStudyLabel(event.target.value)} placeholder="例：第1章 基礎" /></label><label>メモ（任意）<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例：2章の途中まで" /></label><button className="primary-button wide-button" type="submit">この内容を記録する <span>→</span></button></form></article><article className="history-card card">
<div className="section-heading"><div><p className="eyebrow">RECENT ACTIVITY</p><h2>学習履歴</h2></div><span className="activity-count">{activeEntries.length}件</span></div>
{activeEntries.length === 0 ? <div className="empty-history"><span>○</span><p>ここに学習履歴が表示されます。<br />まずはページを記録してみましょう。</p></div> : <div className="history-list">
{[...activeEntries].sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id)).map((entry) => {
  const pageText = entry.fromPage === entry.toPage ? entry.fromPage + "ページ" : entry.fromPage + "–" + entry.toPage + "ページ";
  if (editingEntryId === entry.id) {
    return (
      <form className="history-edit-form" key={entry.id} onSubmit={saveEditedEntry}>
        <div className="history-edit-heading"><strong>学習履歴を編集</strong><span>{pageText}</span></div>
        <div className="date-input-row">
          <label className="date-field">日付<input type="date" value={editDate} disabled={editDateUnknown} onChange={(event) => setEditDate(event.target.value)} /></label>
          <label className="unknown-date-toggle"><input type="checkbox" checked={editDateUnknown} onChange={(event) => { const unknown = event.target.checked; setEditDateUnknown(unknown); if (unknown) setEditDate(""); else if (!editDate) setEditDate(todayString()); }} />日付不明</label>
        </div>
        <div className="page-fields"><label>開始ページ<input type="number" min={activeAllowedRanges[0]?.start} max={activeAllowedRanges.at(-1)?.end} inputMode="numeric" value={editFromPage} onChange={(event) => setEditFromPage(event.target.value)} /></label><span>〜</span><label>終了ページ<input type="number" min={activeAllowedRanges[0]?.start} max={activeAllowedRanges.at(-1)?.end} inputMode="numeric" value={editToPage} onChange={(event) => setEditToPage(event.target.value)} /></label></div>
        <label>区間名（任意）<input value={editLabel} onChange={(event) => setEditLabel(event.target.value)} placeholder="例：第1章 基礎" /></label>
        <label>メモ（任意）<input value={editNote} onChange={(event) => setEditNote(event.target.value)} placeholder="例：2章の途中まで" /></label>
        <div className="history-edit-actions"><button className="primary-button" type="submit">変更を保存</button><button className="link-cancel-button" type="button" onClick={cancelEditingEntry}>キャンセル</button></div>
      </form>
    );
  }
  return (
    <div className="history-item" key={entry.id}>
      <div className="history-date">{formatDate(entry.date)}</div>
      <div className="history-detail"><strong>{entry.label || pageText}</strong>{entry.label && <span>{pageText}</span>}{entry.note && <span>{entry.note}</span>}</div>
      <div className="history-actions"><button className="edit-button" type="button" onClick={() => startEditingEntry(entry)}>編集</button><button className="delete-button" type="button" aria-label="この記録を削除" onClick={() => removeEntry(entry.id)}>×</button></div>
    </div>
  );
})}
</div>}
</article>
</section>
            <section className="footer-actions"><p>記録はこの端末だけに保存されます。ブラウザのデータを消去すると記録も消えます。</p><button className="delete-book-button" type="button" onClick={removeBook}>この参考書を削除</button></section>
          </>
        )}
        <GitHubSyncPanel apiUrl={syncApiUrl} onApiUrlChange={setSyncApiUrl} connected={Boolean(syncSession)} user={syncUser} autoSync={autoSync} onAutoSyncChange={setAutoSync} busy={syncBusy} status={syncStatus} onConnect={connectGitHub} onDisconnect={disconnectGitHub} onLoad={loadGitHubData} onSave={() => { void saveGitHubData(); }} />
      </div>
      {message && <div className="toast" role="status">{message}</div>}
    </main>
  );
}

import {settingsError} from './settings-controls';
import {ApplicationMenubar,createWindowMenus,type WindowMenus} from './application-menu';
import {desktopPreferences,useInstancePreferences,preferenceStatus} from '../instance-preferences';
import { Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { appFromSearch, appSearch, closeGuards, applicationClosers, resourceKey, windowTitle, type OpenApp } from '../apps/app-services';
import { Rnd } from 'react-rnd';
import { noCompactor, type Layout } from 'react-grid-layout';
import { CardGrid } from './card-grid';
import { ArrowLeft, ArrowRight, Check, Columns2, LayoutGrid, Maximize2, Minus, Monitor, Move, Plus, X } from 'lucide-react';
import { apps, widgets, useApplications, appDefinition, refreshApplications, widgetDefinition, applicationsReady, applicationShortcuts } from './registry';
import {BackgroundApps} from './background-apps';
import {windowApplicationIds} from './background-apps-model';
import {ApplicationShortcut} from './application-shortcut';
import {ApplicationLauncher} from './application-launcher';
import { DockApp } from './dock-app';
import {ApplicationIcon} from '../apps/application-icon';
import {PairingNotifications} from './pairing-notifications';
import { SystemMenu } from './system-menu';
import { DesktopSidebar } from './sidebar';
import { GroupManager } from './group-manager';
import { SettingsWindow, type SettingsTab } from './settings-window';
import { ExternalApplication } from '../apps/external-application';
import { randomId } from '../random-id';
import { DESKTOP_KEY, appendWidget, reconcileApplicationShortcuts, fitWidgetLayout, squareGridMetrics, adjustWidgetLayout, currentGroup, defaultDesktop, fitBounds, isDeepLink, patchSearch, readDesktop, sameLayout, moveWidgetPositions, saveDesktop, tiledBounds, withGroupLayout, type Bounds, type WidgetLayout } from '../desktop-model';
import { WindowContext, type WindowObject, cloneWindowSession, releaseWindowSession, readingPositions } from '../window-context';
import { useRemote } from '../api';
import type { TaskTargets } from '../types';
import { Diagnostics } from '../diagnostics';
import { GlassSurface } from '../components/glass-surface';
import { useMaterialStyle } from '../components/material-provider';
import { Sheet } from '../components/ui/sheet';
import {CLIDocumentDialog} from '../apps/cli-document-dialog';
import { requestSync, setGlassResizing, setGlassInteracting } from '../vendor/liquid-surface';
import { useMaterial } from '../components/material-provider';
export interface AppWindow { id: string; appId: string; releaseDigest?: string; search: string; bounds: Bounds; normal: Bounds; mode: 'normal' | 'max' | 'left' | 'right'; minimized: boolean; z: number; object?:WindowObject|null }
const bootSearch = location.search;
type WindowArea = Pick<Bounds, 'width' | 'height'>;
function normalPrefs() { try { return readDesktop(localStorage, widgets.map(w => ({ i: w.id, x: 0, y: 0, ...w.defaultSize, minW: w.minSize.w, minH: w.minSize.h }))); } catch { return defaultDesktop(); } }
const AppFrame = memo(function AppFrame({ menus, model, active, hidden, area, activate, change, close, action, navigate, diagnostics, openApp }: { menus:WindowMenus; openApp: OpenApp; model: AppWindow; active: boolean; hidden: boolean; area: WindowArea; activate: (id: string) => void; change: (id: string, changes: Partial<AppWindow>) => void; close: (id: string) => void; action: (id: string, action: string) => void; navigate: (id: string, values: Record<string, string | null>, replace?: boolean) => void; diagnostics: () => void }) {
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [contentHost, setContentHost] = useState<HTMLDivElement | null>(null), [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const [about,setAbout]=useState(false);
  const [cliDocs,setCLIDocs]=useState(false);
  useEffect(()=>menus.registerAbout(()=>setAbout(true)),[menus]);
  useEffect(()=>menus.registerCLIDocs(()=>setCLIDocs(true)),[menus]);
  const titlebar = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null), rnd = useRef<Rnd>(null);
  const definition = appDefinition(model.appId, model.releaseDigest)!;
  const search = useMemo(() => new URLSearchParams(model.search), [model.search]);
  const nav = useCallback((values: Record<string, string | null>, replace?: boolean) => navigate(model.id, values, replace), [model.id, navigate]);
  const setObject=useCallback((object:WindowObject|null)=>change(model.id,{object}),[model.id,change]);
  const context = useMemo(() => ({ registerMenu:menus.registerMenu, registerSettings:menus.registerSettings, id: model.id, active, enabled: !model.minimized && !hidden, root, toolbarHost, contentHost, overlayHost, setObject, session:undefined, overlays:undefined }), [model.id, active, model.minimized, hidden, toolbarHost, contentHost, overlayHost, setObject]);
  const b = model.mode === 'max' ? { x: 0, y: 0, ...area } : model.mode === 'normal' ? fitBounds(model.bounds, area, definition.minSize) : tiledBounds(model.mode, area);
  const rebindRelease=useCallback(async(digest:string)=>{await refreshApplications();if(!appDefinition(model.appId,digest))throw Error('新应用版本尚不可用，请稍后重试。');change(model.id,{releaseDigest:digest});},[model.id,model.appId,change]);
  const Component = definition.component;
  const syncGlass = () => requestSync(root.current?.closest('.os-window'));
  const resizing = (value: boolean) => setGlassResizing(root.current?.closest('.os-window') ?? null, value);
  useEffect(() => { const node = root.current?.closest('.os-window') ?? null; return () => setGlassResizing(node, false); }, []);
  useEffect(()=>{ const element=titlebar.current;const doubleClick=(event:MouseEvent)=>{if(!(event.target as HTMLElement).closest('button,summary,details,input,select,textarea,a,[role=menu],[contenteditable]'))action(model.id,'max');};element?.addEventListener('dblclick',doubleClick);return()=>element?.removeEventListener('dblclick',doubleClick);},[model.id,action]);
  return <Rnd ref={rnd} bounds="parent" position={{ x: b.x, y: b.y }} size={{ width: b.width, height: b.height }} minWidth={Math.min(definition.minSize.width, b.width)} minHeight={Math.min(definition.minSize.height, b.height)} enableResizing={model.mode === 'normal'} disableDragging={model.mode !== 'normal'} enableUserSelectHack={false} dragHandleClassName="os-titlebar" cancel="button,summary,details,input,select,textarea,a,[role=menu],[contenteditable]" style={{ zIndex: model.z, display: hidden || model.minimized ? 'none' : undefined }}
    onDragStart={() => activate(model.id)} onDrag={syncGlass} onDragStop={(_, d) => { const bounds = fitBounds({ ...b, x: d.x, y: d.y }, area); change(model.id, { bounds, normal: bounds }); syncGlass(); }}
    onResizeStart={() => { activate(model.id); resizing(true); }} onResize={syncGlass} onResizeStop={(_, __, element, ___, position) => { const bounds = fitBounds({ ...position, width: element.offsetWidth, height: element.offsetHeight }, area); change(model.id, { bounds, normal: bounds }); resizing(false); }}>
    <WindowContext.Provider value={context}><div ref={root} className={`os-window ${active ? 'is-active' : ''} ${model.mode === 'max' ? 'is-maximized' : ''}`} role="region" aria-label={`${definition.name}窗口 ${model.id.slice(-4)}`} data-window-id={model.id} onPointerDownCapture={() => activate(model.id)} onFocusCapture={() => activate(model.id)}>
      <header ref={titlebar} className="os-titlebar">
        <div className="window-lights"><button className="light-close" aria-label="关闭窗口" onClick={() => close(model.id)}><X size={10} /></button><button className="light-min" aria-label="最小化窗口" onClick={() => action(model.id, 'min')}><Minus size={10} /></button><button className="light-max" aria-label={model.mode === 'max' ? '还原窗口' : '最大化窗口'} onClick={() => action(model.id, 'max')}><Maximize2 size={8} /></button></div>
        <span className="window-title">{definition.name}</span><div ref={setToolbarHost} className="window-toolbar-host ksf-sdk-surface" />
      </header><div className="os-app-root"><div className="os-app-content" ref={setContentHost}><Suspense fallback={<div className="app-loading">正在打开应用…</div>}><Component search={search} navigate={nav} onDiagnostics={diagnostics} openApp={openApp} onReleaseChanged={rebindRelease} /></Suspense></div><div className="os-app-overlays" data-app-overlay-root={model.id} ref={setOverlayHost}/></div>
    <Sheet open={about} onOpenChange={setAbout} title={'关于 '+definition.name} solid><p>{definition.release?.manifest.description??'KSF 内置应用商店'}</p><p>{definition.release?'版本 '+definition.release.manifest.version:'随 KSF 工作台提供'}</p>{definition.release?.manifest.author&&<p>{definition.release.manifest.author}</p>}</Sheet>
    {definition.release?.manifest.cli&&<CLIDocumentDialog release={definition.release} open={cliDocs} onOpenChange={setCLIDocs}/>}</div></WindowContext.Provider>
  </Rnd>;
});
function StatusClock() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { setClock(new Date()); timer = setTimeout(tick, 60000 - Date.now() % 60000); };
    const visible = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    tick(); document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);
  return <time dateTime={clock.toISOString()}>{clock.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}　{clock.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>;
}
export function Desktop() {
  const menuControllers=useRef(new Map<string,WindowMenus>());
  const menuFor=useCallback((id:string)=>{let menus=menuControllers.current.get(id);if(!menus){menus=createWindowMenus();menuControllers.current.set(id,menus);}return menus;},[]);
  const applicationRevision = useApplications();
  const shortcuts=useMemo(()=>applicationShortcuts(),[applicationRevision]);
  const windowArea = useRef<HTMLDivElement>(null), settingsAnchor = useRef<HTMLButtonElement>(null), launcherAnchor=useRef<HTMLButtonElement>(null);
  const getArea = useCallback((): WindowArea => ({ width: windowArea.current?.clientWidth ?? innerWidth, height: windowArea.current?.clientHeight ?? innerHeight }), []);
  const preferenceState=useInstancePreferences(desktopPreferences);
  const preferences=preferenceState.value,prefsRef=useRef(preferences);prefsRef.current=preferences;
  const [windows, setWindows] = useState<AppWindow[]>([]), windowsRef = useRef(windows);
  const [active, setActive] = useState<string | null>(null), activeRef = useRef(active), z = useRef(10);
  const [desktop, setDesktop] = useState(() => !isDeepLink(bootSearch)), [area, setArea] = useState(getArea);
  const [settings, setSettings] = useState(false), [settingsTab, setSettingsTab] = useState<SettingsTab>('desktop'), [library, setLibrary] = useState(false), [launcher,setLauncher]=useState(false), [keyboard, setKeyboard] = useState<string | null>(null);
  const [startNewGroup, setStartNewGroup] = useState(false), [groupEditorKey, setGroupEditorKey] = useState(0), [pendingGroup, setPendingGroup] = useState<string | null>(null);
  const selectedGroup = currentGroup(preferences);
  const [movingCard, setMovingCard] = useState(false);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<WidgetLayout[]>(selectedGroup.layout);
  const saved=preferenceStatus(preferenceState.status);
  useEffect(()=>{desktopPreferences.hold(editing);return()=>desktopPreferences.hold(false);},[editing]);
  useEffect(()=>{setEditing(false);},[preferenceState.discardVersion]);
  const openSettings = useCallback((tab: SettingsTab = 'desktop', create = false) => { setSettingsTab(tab); setStartNewGroup(create); setGroupEditorKey(value => value + 1); setSettings(true); }, []);
  const openDiagnostics = useCallback(() => openSettings('diagnostics'), [openSettings]);
  const catalog = useRemote<TaskTargets>('/api/task-targets'), health = useRemote<{ ok: boolean; startedAt: string }>(settings && settingsTab === 'diagnostics' ? '/api/health' : null);
  const materialStyle = useMaterialStyle(), { settings: material } = useMaterial();
  const grid = useRef<HTMLDivElement>(null), [gridWidth, setGridWidth] = useState(innerWidth - 96);
  const gridMetrics = squareGridMetrics(gridWidth);
  const [shortcutError,setShortcutError]=useState('');
  useEffect(()=>{
    if(!applicationsReady||editing||movingCard)return;
    void desktopPreferences.reconcile(value=>reconcileApplicationShortcuts(value,shortcuts,gridMetrics.cols,()=>`app-${randomId()}`)).then(()=>setShortcutError(''),error=>setShortcutError((error as Error).message));
  },[applicationRevision,shortcuts,editing,movingCard,gridMetrics.cols,preferences,preferenceState.status]);
  const apply = useCallback((change: (current: AppWindow[]) => AppWindow[]) => { const next = change(windowsRef.current); windowsRef.current = next; setWindows(next); }, []);
  const writeURL = useCallback((search: string, id: string | null, replace = false) => { history[replace ? 'replaceState' : 'pushState']({ ksfWindow: id }, '', location.pathname + (search ? '?' + search : '')); }, []);
  const persist = useCallback((next: typeof preferences) => {prefsRef.current=next;desktopPreferences.update(next);},[]);
  const activate = useCallback((id: string) => {
    if (activeRef.current === id) return;
    const model = windowsRef.current.find(w => w.id === id); if (!model) return;
    activeRef.current = id; setActive(id); setDesktop(false);
    apply(list => list.map(w => w.id === id ? { ...w, minimized: false, z: ++z.current } : w)); writeURL(model.search, id, true);
  }, [apply, writeURL]);
  const openApp = useCallback((appId: string, search = '', fresh = false, fixedId?: string, deep = false, cloneFrom?: string) => {
    const def = apps.find(a => a.id === appId); if (!def) return;
    const explicitSearch = search.replace(/^\?/, '').length > 0;
    search = appSearch(appId, search);
    const resource = resourceKey(appId, search);
    const existing = (!fresh || !def.multiInstance) && windowsRef.current.filter(w => w.appId === appId && (!def.multiInstance || !resource || resourceKey(appId, w.search) === resource)).sort((a, b) => b.z - a.z)[0];
    if (existing) { apply(list => list.map(w => w.id === existing.id ? { ...w, minimized: false, ...(explicitSearch ? {search} : {}) } : w)); activeRef.current = null; activate(existing.id); return; }
    const id = fixedId ?? `window-${randomId()}`, a = getArea(), base = appId === 'com.ksf.conversations' ? prefsRef.current.bounds : { ...prefsRef.current.bounds, ...def.defaultSize }, cascade = windowsRef.current.length % 5 * 24;
    const bounds = fitBounds({ ...base, x: base.x + cascade, y: base.y + cascade }, a, def.minSize);
    if (cloneFrom) cloneWindowSession(cloneFrom, id);
    const model: AppWindow = { id, appId, releaseDigest: def.release?.digest, search: search.replace(/^\?/, ''), bounds, normal: bounds, mode: deep ? 'max' : 'normal', minimized: false, z: ++z.current };
    apply(list => [...list, model]); activeRef.current = id; setActive(id); setDesktop(false); writeURL(model.search, id, deep);
  }, [activate, apply, getArea, writeURL]);
  const open = useCallback((search: string, fresh = false) => openApp('com.ksf.conversations', search, fresh), [openApp]);
  const navigate = useCallback((id: string, values: Record<string, string | null>, replace = false) => {
    const current = windowsRef.current.find(w => w.id === id); if (!current) return;
    const search = appSearch(current.appId, patchSearch(current.search, values)); if (search === current.search) return;
    apply(list => list.map(w => w.id === id ? { ...w, search } : w));
    if (activeRef.current === id) writeURL(search, id, replace);
  }, [apply, writeURL]);
  const change = useCallback((id: string, changes: Partial<AppWindow>) => { apply(list => list.map(w => w.id === id ? { ...w, ...changes } : w)); if (changes.normal) persist({ ...prefsRef.current, bounds: changes.normal }); }, [apply, persist]);
  const close = useCallback(async (id: string) => {
    const guard = closeGuards.get(id); if (guard && !await guard()) return false;
    apply(list => list.filter(w => w.id !== id)); releaseWindowSession(id);menuControllers.current.delete(id);
    if (activeRef.current === id) { activeRef.current = null; const next = windowsRef.current.filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0]; if (next) activate(next.id); else { setActive(null); setDesktop(true); writeURL('', null, true); } }
    return true;
  }, [activate, apply, writeURL]);
  useEffect(()=>{const handler=async(appId:string)=>{for(const model of [...windowsRef.current].filter(item=>item.appId===appId))if(!await close(model.id))return false;return true;};applicationClosers.add(handler);return()=>{applicationClosers.delete(handler);};},[close]);
  const action = useCallback((id: string, kind: string) => {
    const model = windowsRef.current.find(w => w.id === id); if (!model) return;
    if (kind === 'compare') { openApp(model.appId, model.search, true, undefined, false, id); return; }
    if (kind === 'keyboard') { setKeyboard(id); return; }
    if (kind === 'min') { change(id, { minimized: true }); activeRef.current = null; setActive(null); const next = windowsRef.current.filter(w => !w.minimized).sort((a, b) => b.z - a.z)[0]; if (next) activate(next.id); else { setDesktop(true); writeURL('', null, true); } return; }
    activate(id); change(id, { mode: kind === 'max' ? model.mode === 'max' ? 'normal' : 'max' : kind as 'left' | 'right' }); requestAnimationFrame(requestSync);
  }, [activate, change, openApp, writeURL]);
  const showDesktop = () => { if (!desktop) { writeURL('', null); setDesktop(true); } else { const w = windowsRef.current.find(w => w.id === activeRef.current && !w.minimized); if (w) { writeURL(w.search, w.id); setDesktop(false); } } };
  useEffect(() => { let live = true; void refreshApplications().catch(() => {}).then(() => { if (live && isDeepLink(bootSearch)) { const id = history.state?.ksfWindow, position = history.state?.ksfPosition; if (id && position) readingPositions.set(`${id}:${position.task}:${position.turn}`, position.scroll); openApp(appFromSearch(bootSearch), bootSearch, true, id, true); } }); return () => { live = false; }; }, [openApp]);
  useEffect(() => { for (const model of windowsRef.current) if (model.releaseDigest && !apps.some(app => app.id === model.appId)) void close(model.id); }, [applicationRevision, close]);
  useLayoutEffect(() => {
    const element = windowArea.current; if (!element) return;
    const resize = () => { const next = getArea(); setArea(current => current.width === next.width && current.height === next.height ? current : next); requestSync(); };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, [getArea]);
  useEffect(() => {
    const pop = () => { const search = location.search; if (!isDeepLink(search)) { setDesktop(true); return; } const id = history.state?.ksfWindow, position = history.state?.ksfPosition; if (id && position) readingPositions.set(`${id}:${position.task}:${position.turn}`, position.scroll); const w = windowsRef.current.find(w => w.id === id); if (w && w.appId === appFromSearch(search)) { apply(list => list.map(x => x.id === id ? { ...x, search: search.slice(1), minimized: false, z: ++z.current } : x)); activeRef.current = id; setActive(id); setDesktop(false); } else openApp(appFromSearch(search), search, true, id, true); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [apply, openApp]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.os-menu[open]')) if (!menu.contains(event.target as Node)) menu.open = false; };
    const chosen = (event: MouseEvent) => { const target = event.target as HTMLElement; const menu = target.closest<HTMLDetailsElement>('details.os-menu'); if (target.closest('button') && menu) menu.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; const menu = document.querySelector<HTMLDetailsElement>('details.os-menu[open]'); if (menu) { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true }); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('click', chosen); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('click', chosen); document.removeEventListener('keydown', escape); };
  }, []);
  useLayoutEffect(() => {
    const element = grid.current; if (!element) return;
    let previousWidth = 0;
    const measure = () => { const width = element.clientWidth; if (width <= 0 || width === previousWidth) return; previousWidth = width; setGridWidth(width); requestSync(element); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => { observer.disconnect(); setGlassInteracting(element, false); };
  }, []);
  useLayoutEffect(() => {
    const element = grid.current; if (!element || !(editing || movingCard)) return;
    setGlassInteracting(element, true);
    return () => setGlassInteracting(element, false);
  }, [editing, movingCard]);
  const beginEdit = () => { setSettings(false); if (!editing) setDraft(currentGroup(prefsRef.current).layout.map(v => ({ ...v }))); setEditing(true); setDesktop(true); writeURL('', null); };
  const finish = () => { persist(withGroupLayout(prefsRef.current, draft)); setEditing(false); };
  const selectGroup = (id: string) => {
    if (!prefsRef.current.groups.some(group => group.id === id)) return;
    setSettings(false);
    if (id !== prefsRef.current.activeGroupId && editing && !sameLayout(draft, currentGroup(prefsRef.current).layout)) { setPendingGroup(id); return; }
    if (id !== prefsRef.current.activeGroupId) { persist({ ...prefsRef.current, activeGroupId: id }); setEditing(false); }
    setDesktop(true); writeURL('', null);
  };
  const resolveGroup = (save: boolean) => { if (!pendingGroup) return; const next = save ? withGroupLayout(prefsRef.current, draft) : prefsRef.current; persist({ ...next, activeGroupId: pendingGroup }); setEditing(false); setPendingGroup(null); setDesktop(true); writeURL('', null); };
  const addWidget = (id: string) => {
    const definition = widgets.find(w => w.id === id)!;
    const base:WidgetLayout = { i: `card-${randomId()}`, appId:definition.appId,cardId:definition.cardId,name:definition.name,config:{}, x: 0, y: 0, ...definition.defaultSize, minW: definition.minSize.w, minH: definition.minSize.h };
    if (editing) setDraft(list => appendWidget(list, base, gridMetrics.cols));
    else { const layout = currentGroup(prefsRef.current).layout; persist(withGroupLayout(prefsRef.current, appendWidget(layout, base, gridMetrics.cols))); }
  };
  const addApplication=(appId:string)=>{
    const app=shortcuts.find(item=>item.id===appId);if(!app?.hasWindow)return;
    const item:WidgetLayout={i:`app-${randomId()}`,kind:'app',appId,name:app.name,x:0,y:0,w:1,h:1,minW:1,minH:1};
    if(editing)setDraft(list=>appendWidget(list,item,gridMetrics.cols));
    else persist(withGroupLayout(prefsRef.current,appendWidget(currentGroup(prefsRef.current).layout,item,gridMetrics.cols)));
    setDesktop(true);writeURL('',null);
  };
  const editKey = (id: string, event: React.KeyboardEvent) => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0, dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0; setDraft(list => adjustWidgetLayout(list, id, dx, dy, event.shiftKey, gridMetrics.cols)); requestAnimationFrame(() => requestSync(grid.current)); };
  const configureCard=(id:string,value:unknown)=>{if(editing)setDraft(list=>list.map(item=>item.i===id?{...item,config:value}:item));else{const state=prefsRef.current;persist(withGroupLayout(state,currentGroup(state).layout.map(item=>item.i===id?{...item,config:value}:item)));}};
  const mergeGrid=(previous:WidgetLayout[],next:readonly WidgetLayout[])=>previous.map(item=>{const changed=next.find(value=>value.i===item.i);return changed?{...item,x:changed.x,y:changed.y,w:item.kind==='app'?1:changed.w,h:item.kind==='app'?1:changed.h}:item;});
  const keyboardWindow = windows.find(w => w.id === keyboard), layout = fitWidgetLayout(editing ? draft : selectedGroup.layout, gridMetrics.cols);
  const keyboardBounds = keyboardWindow ? keyboardWindow.mode === 'max' ? {x:0,y:0,...area} : keyboardWindow.mode === 'left' || keyboardWindow.mode === 'right' ? tiledBounds(keyboardWindow.mode,area) : fitBounds(keyboardWindow.bounds,area,apps.find(app=>app.id===keyboardWindow.appId)?.minSize) : null;
  const showCardGrid = editing || movingCard;
  const guideRows = Math.max(4, Math.ceil(area.height / (gridMetrics.cell + gridMetrics.gap)), ...layout.map(item => item.y + item.h));
  const activeWindow = windows.find(w => w.id === active), visibleCount = windows.filter(w => !w.minimized).length;
  const dockApps=windowApplicationIds(windows).map(id=>appDefinition(id,windows.find(item=>item.appId===id)?.releaseDigest)).filter((app):app is NonNullable<typeof app>=>!!app);
  const openMonitor=()=>{if(apps.some(app=>app.id==='com.ksf.activity-monitor'))openApp('com.ksf.activity-monitor');else openSettings('runtime');};
  const manageApplication=(id:string)=>{
    const store=windowsRef.current.find(model=>model.appId==='com.ksf.app-store');
    if(store){navigate(store.id,{storeTab:'installed',storeApp:id,storeQuery:null});activeRef.current=null;activate(store.id);}
    else openApp('com.ksf.app-store',new URLSearchParams({storeTab:'installed',storeApp:id}).toString());
  };
  return <div className={`os-desktop ${editing ? 'is-editing' : ''}`} style={{ ...materialStyle, '--window-radius': '14px', '--window-shadow': '0 16px 48px #11294438', '--card-radius': `${material.profiles.card.radius}px` } as CSSProperties}>
    <div className="workbench-backdrop" aria-hidden="true" />
    <header className="os-statusbar"><GlassSurface profile="statusbar" /><div className="status-left">
      <SystemMenu open={() => openSettings()} expanded={settings} anchor={settingsAnchor} />
      {desktop||!activeWindow?<span>{selectedGroup.name}</span>:<ApplicationMenubar key={activeWindow.id} windowId={activeWindow.id} definition={appDefinition(activeWindow.appId,activeWindow.releaseDigest)!} menus={menuFor(activeWindow.id)}/>}
    </div><div className="status-right"><BackgroundApps openApp={openApp} monitor={openMonitor}/><StatusClock /></div></header>
    {desktop && <DesktopSidebar groups={preferences.groups} activeId={preferences.activeGroupId} select={selectGroup} create={() => openSettings('desktop', true)} edit={beginEdit} editing={editing} />}
    <main className="desktop-surface"><div className="desktop-heading"><div className="desktop-motto"><h1>每一步，都向更高处。</h1><p>沉淀所学，接续思考。</p></div><div className="desktop-actions">{editing ? <><span>拖动卡片移动 · 右下角按格缩放</span><button onClick={() => setLibrary(true)}>＋ 添加卡片</button><button onClick={() => { setEditing(false); setDraft(selectedGroup.layout); }}>取消</button><button className="os-primary" onClick={finish}><Check size={14} />完成</button></> : <span className="desktop-save" role="status">{saved}</span>}</div></div>
      {shortcutError&&<p role="alert" className="shortcut-error">应用图标尚未同步：{shortcutError}</p>}
      <div className="desktop-grid-scroll"><div ref={grid} className="desktop-grid">
        {showCardGrid && <div className="desktop-grid-guides" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${gridMetrics.cols}, ${gridMetrics.cell}px)`, gridAutoRows: gridMetrics.cell, gap: gridMetrics.gap }}>{Array.from({ length: guideRows * gridMetrics.cols }, (_, i) => <i key={i} />)}</div>}
        <CardGrid width={gridMetrics.width} layout={layout.map(item=>item.kind==='app'?{...item,isResizable:false}:item) as Layout} gridConfig={{ cols: gridMetrics.cols, rowHeight: gridMetrics.cell, margin: [gridMetrics.gap, gridMetrics.gap], containerPadding: [0, 0] }} dragConfig={{ enabled: true, handle: '.widget-drag-handle', cancel: 'button,a,input,textarea,select,summary,[role=button]:not(.application-shortcut-launch),[contenteditable=true],[data-no-card-drag]' }} resizeConfig={{ enabled: editing, handles: ['se'] }} compactor={noCompactor} onInteractionChange={setMovingCard} onDragStop={next => { if (editing) setDraft(previous=>mergeGrid(previous,next)); else { const original = currentGroup(prefsRef.current).layout, moved = moveWidgetPositions(original, layout, next); if (!sameLayout(original, moved)) persist(withGroupLayout(prefsRef.current, moved)); } }} onResizeStop={next => { if (editing) setDraft(previous=>mergeGrid(previous,next)); }}>
          {layout.map(item => { const app=item.kind==='app'?shortcuts.find(app=>app.id===item.appId):undefined;const def = item.kind==='app'?undefined:widgetDefinition(item.appId??'com.ksf.conversations',item.cardId??item.i), name=app?.name??def?.name??item.name??'应用卡片'; const compact = item.w === 1 || item.h === 1; return <section key={item.i} className={`desktop-tile ${item.kind==='app'?'is-application':''}`} aria-label={name} data-card-instance={item.i} data-card-app={item.appId} data-card-type={item.kind==='app'?'app':item.cardId} data-grid-size={`${item.w}×${item.h}`}>
            {item.kind==='app'?<ApplicationShortcut appId={item.appId!} name={name} manifest={app?.release?.manifest} enabled={!!app?.enabled} editing={editing} open={()=>openApp(item.appId!)} remove={()=>setDraft(list=>list.filter(card=>card.i!==item.i))} editKey={event=>editKey(item.i,event)}/>:<>
            <div className="desktop-widget widget-drag-handle" tabIndex={editing?0:undefined} aria-label={editing?`用方向键移动${name}，按住 Shift 调整大小`:undefined} onKeyDown={event=>{if(editing&&event.target===event.currentTarget)editKey(item.i,event);}}><GlassSurface profile="card" /><div className={`widget-content ${compact ? 'is-compact' : ''}`}>{def?<ExternalApplication release={def.release} openApp={openApp} onDiagnostics={openDiagnostics} card={{entry:def.entry,cardId:def.cardId,instanceId:`${encodeURIComponent(preferences.activeGroupId)}/${encodeURIComponent(item.i)}`,compact,visible:!editing,width:item.w*gridMetrics.cell+(item.w-1)*gridMetrics.gap,height:item.h*gridMetrics.cell+(item.h-1)*gridMetrics.gap,config:item.config??{},onConfigChange:value=>configureCard(item.i,value)}}/>:<div className="app-platform-error"><p>{name}所属应用未安装、已停用或暂不可用。</p><button onClick={()=>openApp('com.ksf.app-store')}>前往应用商店</button></div>}</div>
              {editing && <><span className="widget-size">{item.w}×{item.h}</span><div className="widget-edit-tools"><button aria-label={`移除${name}卡片`} onClick={() => setDraft(list => list.filter(w => w.i !== item.i))}><X size={14} /></button></div></>}
            </div><div className="widget-caption widget-drag-handle" title={name}><span>{name}</span></div></>}
          </section>; })}
        </CardGrid>{!layout.length && <div className="desktop-empty"><LayoutGrid size={30} /><p>桌面由你安排</p><button onClick={() => setLibrary(true)}>从卡片库添加卡片</button></div>}
      </div></div>
    </main>
    <div ref={windowArea} className="os-window-area">{windows.map(model => <AppFrame key={model.id} menus={menuFor(model.id)} model={model} active={active === model.id && !desktop} hidden={desktop} area={area} activate={activate} change={change} close={close} action={action} navigate={navigate} diagnostics={openDiagnostics} openApp={openApp} />)}</div>
    <nav className="os-dock" aria-label="桌面 Dock"><GlassSurface profile="dock" /><button ref={launcherAnchor} type="button" className="dock-item" aria-label="所有应用" aria-haspopup="dialog" aria-expanded={launcher} aria-controls={launcher?'ksf-application-launcher':undefined} onClick={()=>setLauncher(value=>!value)}><span className="app-icon launcher-icon"><LayoutGrid size={27}/></span><span className="dock-tooltip" hidden={launcher}>所有应用</span></button>{!!dockApps.length&&<><span className="dock-divider"/><div className="dock-applications" aria-label="已打开的应用">{dockApps.map(app => {
      const items = windows.filter(w => w.appId === app.id).sort((a,b) => b.z - a.z), target = activeWindow?.appId === app.id ? activeWindow : items[0];
      return <DockApp key={app.id} name={app.name} count={items.length} icon={<ApplicationIcon appId={app.id} manifest={app.release?.manifest} variant="dock"/>} onOpen={() => { if (items[0]) { activeRef.current = null; activate(items[0].id); } else openApp(app.id); }}>
        <button role="menuitem" onClick={() => { const source = activeWindow?.appId === app.id ? activeWindow : items[0]; openApp(app.id, source?.search ?? '', true, undefined, false, source?.id); }}><Plus size={15} />新开{app.name}窗口</button>
        {items.map(w => <button role="menuitem" key={w.id} onClick={() => { activeRef.current = null; activate(w.id); }}><app.icon size={15} /><span>{w.object?.title??windowTitle(w.appId,w.search)}{w.minimized ? ' · 已最小化' : ''}<small>{w.object?.detail??new URLSearchParams(w.search).get('path') ?? catalog.data?.targets.find(t => t.key === new URLSearchParams(w.search).get('target'))?.label ?? app.name}</small></span></button>)}
        {target && <><div className="dock-window-target">{target.object?.title??windowTitle(target.appId,target.search)}</div><button role="menuitem" onClick={() => action(target.id, 'left')}><ArrowLeft size={15} />排列到左半屏</button><button role="menuitem" onClick={() => action(target.id, 'right')}><ArrowRight size={15} />排列到右半屏</button><button role="menuitem" onClick={() => action(target.id, 'compare')}><Columns2 size={15} />新开对照窗口</button><button role="menuitem" onClick={() => action(target.id, 'keyboard')}><Move size={15} />移动与调整大小</button><button role="menuitem" onClick={() => action(target.id, 'max')}><Maximize2 size={15} />{target.mode === 'max' ? '还原窗口' : '最大化窗口'}</button><button role="menuitem" onClick={() => action(target.id, 'min')}><Minus size={15} />最小化窗口</button><button role="menuitem" onClick={() => close(target.id)}><X size={15} />关闭窗口</button></>}
        {visibleCount >= 2 && <button role="menuitem" onClick={() => { const pair = [...windowsRef.current].filter(w => !w.minimized).sort((a,b) => b.z-a.z).slice(0,2); change(pair[1].id, { mode: 'left' }); change(pair[0].id, { mode: 'right' }); setDesktop(false); }}><Columns2 size={15} />最近两窗并排</button>}
      </DockApp>;
    })}</div><span className="dock-divider" /></>}<button className={`dock-item ${desktop ? 'selected' : ''}`} aria-label="显示桌面" aria-pressed={desktop} onClick={showDesktop}><span className="app-icon desktop-icon"><Monitor size={27} /></span><span className="dock-tooltip">显示桌面</span></button></nav>
    <ApplicationLauncher open={launcher} onOpenChange={setLauncher} anchor={launcherAnchor} applications={shortcuts} openApp={openApp} manage={manageApplication} addedApplications={new Set((editing?draft:selectedGroup.layout).filter(item=>item.kind==='app').map(item=>item.appId!))} addApplication={addApplication}/>
    <PairingNotifications/>
    <SettingsWindow onProjects={apps.some(app=>app.id==='com.ksf.projects')?()=>{setSettings(false);openApp('com.ksf.projects');}:undefined} onMonitor={()=>{setSettings(false);openApp('com.ksf.activity-monitor');}} onDocumentation={apps.some(app=>app.id==='com.ksf.documentation')?()=>{setSettings(false);openApp('com.ksf.documentation');}:undefined} open={settings} onOpenChange={setSettings} tab={settingsTab} select={setSettingsTab} saved={saved} anchor={settingsAnchor}
      desktop={<GroupManager key={groupEditorKey} value={preferences} change={next => { if (!editing) persist(next); }} select={selectGroup} startNew={startNewGroup} editing={editing} edit={beginEdit} library={() => { setSettings(false); setLibrary(true); }} />}
      diagnostics={<><div className="os-health">{health.error ? '服务健康检查失败：' + settingsError(health.error) : health.data ? '本地服务健康检查成功' : '正在检查本地服务…'}<button onClick={() => { catalog.refresh(); health.refresh(); }}>重试</button></div><Diagnostics capture={catalog.data?.capture} errors={catalog.data?.errors ?? []} /></>} />
    <Sheet open={!!pendingGroup} onOpenChange={value => { if (!value) setPendingGroup(null); }} title="切换桌面分组" description="当前桌面的卡片布局尚未保存。" solid className="group-switch-sheet"><p>保存当前布局后切换到“{preferences.groups.find(group => group.id === pendingGroup)?.name}”？</p><div className="group-switch-actions"><button type="button" onClick={() => setPendingGroup(null)}>继续编辑</button><button type="button" onClick={() => resolveGroup(false)}>放弃并切换</button><button type="button" className="settings-primary" onClick={() => resolveGroup(true)}>保存并切换</button></div></Sheet>
    <Sheet open={library} onOpenChange={setLibrary} title="桌面卡片库" solid><h3>功能卡片</h3><p className="library-intro">卡片由已安装的应用提供。同一种卡片可添加多张，各自保存配置。</p><div className="widget-library">{widgets.map(w => { return <article key={w.id}><span><w.icon size={25} /></span><div><h3>{w.name}</h3><small>{w.appName}</small><p>{w.description}</p></div><button onClick={() => addWidget(w.id)}><Plus size={17} />添加</button></article>; })}</div>{!widgets.length&&<p className="library-intro">暂无可添加的功能卡片。</p>}<button className="os-primary" onClick={() => { setLibrary(false); if (!editing) beginEdit(); }}>编辑卡片布局</button></Sheet>
    <Sheet open={!!keyboardWindow} onOpenChange={value => { if (!value) setKeyboard(null); }} title="移动与调整窗口" solid>{keyboardWindow && keyboardBounds && <><p>使用输入框或方向键微调。窗口将限制在桌面可用范围内。</p><div className="window-coordinate-form">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{{ x: '水平位置', y: '垂直位置', width: '宽度', height: '高度' }[key]}<input type="number" step={8} value={Math.round(keyboardBounds[key])} onChange={e => { const bounds = fitBounds({ ...keyboardBounds, [key]: Number(e.target.value) }, area); change(keyboardWindow.id, { bounds, normal: bounds, mode: 'normal' }); requestAnimationFrame(requestSync); }} /></label>)}</div></>}</Sheet>
  </div>;
}

import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  reconnectEdge,
  BaseEdge,
  getSmoothStepPath,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type EdgeProps,
} from '@xyflow/react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  ClipboardPaste,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Pencil,
  ExternalLink,
  Globe2,
  History,
  List,
  LoaderCircle,
  LogOut,
  Network,
  Plus,
  Radio,
  RotateCcw,
  Route,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  Waypoints,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectSeparator,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { api } from '@/lib/api';
const GuideExperience = lazy(() =>
  import('./guide-experience').then((module) => ({
    default: module.GuideExperience,
  })),
);

type Data = {
  label: string;
  domain?: string;
  tls?: string;
  forceHttps?: boolean;
  maxBodySizeMb?: number;
  path?: string;
  websocket?: boolean;
  host?: string;
  hostHeader?: string;
  port?: number;
  protocol?: string;
  routeCount?: number;
};
type Block = Node<Data>;
type Graph = { nodes: Block[]; edges: Edge[] };
type DiscoveredService = {
  id: string;
  name: string;
  host: string;
  port: number | null;
  networks: string[];
};
type Version = { id: string; at: string; graph: Graph; config: string; configOverride?: string | null };
type TrafficEvent = {
  routeId: string;
  timestamp: string;
  method: string;
  status: number;
  responseTime: number;
  upstream: string;
};
type State = {
  revision: number;
  draft: Graph;
  applied: Version | null;
  history: Version[];
  configDraft: string | null;
  workspaceId: string;
  liveWorkspaceId: string | null;
  liveConfig: string | null;
  liveGraph: Graph;
  liveOverride: string | null;
  workspaces: { id: string; name: string }[];
  certificates: string[];
  mode: string;
  nginxRunning: boolean;
  ports: { http: number; https: number };
};
const icons = { domain: Globe2, rule: Route, service: Box };
const titles = { domain: 'Domain', rule: 'Path rule', service: 'Service' };
const explanations = {
  domain:
    'The address people visit. Point its DNS record at this server so requests arrive here.',
  rule: 'The traffic director. Nginx chooses the longest matching path, then forwards the request to the connected service.',
  service:
    'The application behind the proxy. Enter a hostname or IP address that your Nginx runtime can reach.',
};
const id = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const clean = (graph: Graph): Graph => ({
  nodes: graph.nodes.map(({ id, type, position, data }) => ({
    id,
    type,
    position,
    data,
  })),
  edges: graph.edges.map(({ id, source, target }) => ({ id, source, target })),
});
const signature = (graph: Graph) => JSON.stringify(clean(graph));
const configSignature = (config: string) => {
  const marker = config.match(/^# Waypoint deployment: ([\w-]+)$/m)?.[1];
  return marker
    ? config.replace(/^# Waypoint deployment: [\w-]+$/m, '# Waypoint deployment: revision')
      .replace(`return 200 "${marker}";`, 'return 200 "revision";')
    : config;
};
function WorkspaceSidebarContent({ children }: { children: React.ReactNode }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarContent
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button.nav-item'))
          setOpenMobile(false);
      }}
    >
      {children}
    </SidebarContent>
  );
}

function Picker({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v !== null && onChange(v)}>
      <SelectTrigger aria-label={label} className="picker">
        <SelectValue>
          {items.find((i) => i.value === value)?.label || 'Select…'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const workspaceAction = {
  add: '__waypoint_add_workspace__',
  rename: '__waypoint_rename_workspace__',
  remove: '__waypoint_remove_workspace__',
};
function WorkspacePicker({
  value,
  items,
  onSwitch,
  onAdd,
  onRename,
  onRemove,
  canRemove,
  disabled,
}: {
  value: string;
  items: { value: string; label: string }[];
  onSwitch: (value: string) => void;
  onAdd: () => void;
  onRename: () => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === workspaceAction.add) onAdd();
        else if (next === workspaceAction.rename) onRename();
        else if (next === workspaceAction.remove) onRemove();
        else if (next !== null && items.some((item) => item.value === next)) onSwitch(next);
      }}
    >
      <SelectTrigger aria-label="Select workspace" className="picker" disabled={disabled}>
        <SelectValue>{items.find((item) => item.value === value)?.label || 'Select…'}</SelectValue>
      </SelectTrigger>
      <SelectContent className="workspace-menu" alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={workspaceAction.add}><Plus size={15} /> Add workspace</SelectItem>
        <SelectItem value={workspaceAction.rename}><Pencil size={15} /> Rename workspace</SelectItem>
        <SelectItem value={workspaceAction.remove} disabled={!canRemove} className="workspace-action-remove">
          <Trash2 size={15} /> Remove workspace
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
function BlockNode({ data, type, selected }: NodeProps<Block>) {
  const kind = type as keyof typeof icons,
    Icon = icons[kind];
  return (
    <div className={`flow-block ${kind} ${selected ? 'chosen' : ''}`}>
      {kind !== 'domain' && <Handle type="target" position={Position.Left} />}
      <div className="block-top">
        <span className={`type-icon ${kind}`}>
          <Icon size={20} />
        </span>
        <span className="block-kind">{titles[kind]}</span>
      </div>
      <strong>{data.label || titles[kind]}</strong>
      <div className="block-address">
        {kind === 'domain'
          ? data.domain || 'Set a domain'
          : kind === 'rule'
            ? data.path || '/'
            : `${data.host || 'Set destination'}:${data.port || '—'}`}
      </div>
      <div className="block-bottom">
        <span className={`little-dot ${kind}`} />
        {kind === 'domain'
          ? data.tls
            ? 'HTTPS enabled'
            : 'HTTP'
          : kind === 'rule'
            ? data.websocket
              ? 'WebSockets'
              : 'HTTP'
            : `${(data.protocol || 'http').toUpperCase()} upstream · ${data.routeCount || 0} ${data.routeCount === 1 ? 'route' : 'routes'}`}
        <ChevronRight size={13} />
      </div>
      {kind !== 'service' && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
function TrafficEdge({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  markerEnd,
  id,
}: EdgeProps) {
  const motionPath = useRef<SVGPathElement>(null);
  const traveler = useRef<SVGCircleElement>(null);
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = data?.trafficActive === true;
  useEffect(() => {
    if (!active || !motionPath.current || !traveler.current) return;
    const curve = motionPath.current;
    const dot = traveler.current;
    const length = curve.getTotalLength();
    const started = performance.now();
    let frame = 0;
    const move = (now: number) => {
      const progress = ((now - started) % 1400) / 1400;
      const point = curve.getPointAtLength(progress * length);
      dot.setAttribute('cx', String(point.x));
      dot.setAttribute('cy', String(point.y));
      dot.style.visibility = 'visible';
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => cancelAnimationFrame(frame);
  }, [active, path]);
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: '#75988e', strokeWidth: 2 }}
      />
      {active && (
        <>
          <defs>
            <path ref={motionPath} id={`waypoint-traffic-${id}`} d={path} />
          </defs>
          <circle
            ref={traveler}
            r="7"
            fill="#16a36b"
            stroke="#fff"
            strokeWidth="2"
            className="traffic-traveler"
            style={{ visibility: 'hidden', pointerEvents: 'none' }}
          />
        </>
      )}
    </>
  );
}
const nodeTypes = { domain: BlockNode, rule: BlockNode, service: BlockNode };
const edgeTypes = { traffic: TrafficEdge };
function WorkspaceInner({ onLogout }: { onLogout: () => Promise<void> }) {
  const [state, setState] = useState<State | null>(null),
    [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [section, setSection] = useState('network'),
    [tab, setTab] = useState('canvas'),
    [scope, setScope] = useState('draft');
  const [selected, setSelected] = useState<string | null>(null),
    [wizard, setWizard] = useState(false),
    [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState({
    key: '',
    config: '',
    errors: [] as string[],
  });
  const [validatedKey, setValidatedKey] = useState('');
  const [configOverride, setConfigOverride] = useState<string | null>(null);
  const [workspaceEditor, setWorkspaceEditor] = useState<'create' | 'rename' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [logs, setLogs] = useState({ access: '', error: '' }),
    [confirm, setConfirm] = useState<{ kind: string; id?: string } | null>(
      null,
    );
  const [servicesOpen, setServicesOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredService[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanned, setScanned] = useState(false);
  const [serviceSearch, setServiceSearch] = useState('');
  const [clipboard, setClipboard] = useState<Graph | null>(null);
  const pasteCount = useRef(0);
  const scanLock = useRef(false);
  const scanServices = async () => {
    if (scanLock.current) return;
    scanLock.current = true;
    setScanning(true);
    setScanError('');
    try {
      const result = await api('discovery');
      setDiscovered(result.services);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Scan failed.');
    } finally {
      setScanned(true);
      setScanning(false);
      scanLock.current = false;
    }
  };

  const [trafficStatus, setTrafficStatus] = useState<
    'connected' | 'disconnected'
  >('disconnected');
  const [trafficPaused, setTrafficPaused] = useState(false);
  const [trafficFilter, setTrafficFilter] = useState('all');
  const [trafficEvents, setTrafficEvents] = useState<TrafficEvent[]>([]);
  const [trafficPulse, setTrafficPulse] = useState<Record<string, number>>({});
  const [trafficNow, setTrafficNow] = useState(() => Date.now());
  const [trafficLastAt, setTrafficLastAt] = useState(0);
  const trafficPausedRef = useRef(false);
  const reconnectingEdgeId = useRef<string | null>(null);
  const [trace, setTrace] = useState(''),
    [traceResult, setTraceResult] = useState('');
  const flow = useReactFlow<Block>();
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingImport = useRef<Graph | null>(null);
  const show = (text: string, bad = false) => setNotice({ text, bad });
  const load = async () => {
    const s = await api('state');
    setState(s);
    setGraph(s.draft);
    setConfigOverride(s.configDraft);
  };
  useEffect(() => {
    let cancelled = false;
    api('state')
      .then((s) => {
        if (!cancelled) {
          setState(s);
          setGraph(s.draft);
          setConfigOverride(s.configDraft);
        }
      })
      .catch((e) => {
        if (!cancelled) show(e.message, true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const dirty = !!state &&
    (signature(graph) !== signature(state.draft) || configOverride !== state.configDraft);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  const visibleGraph =
    scope === 'live'
      ? state?.liveGraph || { nodes: [], edges: [] }
      : graph;
  const visibleNodes = visibleGraph.nodes.map((node) =>
    node.type === 'service'
      ? {
          ...node,
          data: {
            ...node.data,
            routeCount: visibleGraph.edges.filter(
              (edge) => edge.target === node.id,
            ).length,
          },
        }
      : node,
  );
  const routeNames = Object.fromEntries(
    visibleGraph.nodes
      .filter((node) => node.type === 'rule')
      .map((rule) => {
        const domain = visibleGraph.nodes.find(
          (node) =>
            node.id ===
            visibleGraph.edges.find((edge) => edge.target === rule.id)?.source,
        );
        return [
          rule.id,
          `${domain?.data.domain || 'unknown'} ${rule.data.path || '/'}`,
        ];
      }),
  );
  const displayedTraffic = trafficEvents.filter(
    (event) => trafficFilter === 'all' || event.routeId === trafficFilter,
  );
  const activeEdges: Edge[] = visibleGraph.edges.map((edge) => {
    const routeId =
      visibleGraph.nodes.find((node) => node.id === edge.target)?.type ===
      'rule'
        ? edge.target
        : visibleGraph.nodes.find((node) => node.id === edge.source)?.type ===
            'rule'
          ? edge.source
          : '';
    const active = !trafficPaused && !!trafficPulse[routeId];
    return {
      ...edge,
      type: 'traffic',
      animated: false,
      data: { ...edge.data, trafficActive: active },
      style: { stroke: '#75988e', strokeWidth: 2 },
    };
  });
  const graphPayload = signature(visibleGraph);
  const configModeOverride = scope === 'draft' ? configOverride : state?.liveOverride || null;
  const graphKey = graphPayload + '|' + (scope === 'draft' ? state?.workspaceId : state?.liveWorkspaceId) + '|' + (configModeOverride || 'generated');
  const previewPending = preview.key !== graphKey;
  const deployable = !!state && scope === 'draft' && !previewPending &&
    preview.errors.length === 0 && !!preview.config &&
    (!state.liveConfig || configSignature(preview.config) !== configSignature(state.liveConfig));
  const validateConfiguration = () =>
    act(async () => {
      await api('validate', { graph: clean(visibleGraph), config: scope === 'draft' ? configOverride : state?.liveOverride || null });
      setValidatedKey(graphKey);
      show('Configuration is valid. Nginx accepted the generated rules.');
    });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api('preview', { graph: JSON.parse(graphPayload), config: configModeOverride })
        .then((p) => {
          if (!cancelled) setPreview({ ...p, key: graphKey });
        })
        .catch((e) => {
          if (!cancelled)
            setPreview({ key: graphKey, config: '', errors: [e.message] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [graphKey, graphPayload, configModeOverride]);
  useEffect(() => {
    if (section === 'activity')
      api('logs')
        .then(setLogs)
        .catch((e) => show(e.message, true));
  }, [section]);
  useEffect(() => {
    const source = new EventSource('/api/traffic');
    source.addEventListener('ready', () => setTrafficStatus('connected'));
    source.addEventListener('traffic', (message) => {
      try {
        const incoming = JSON.parse(
          (message as MessageEvent).data,
        ) as TrafficEvent[];
        if (!incoming.length) return;
        if (trafficPausedRef.current) return;
        setTrafficStatus('connected');
        setTrafficLastAt(Date.now());
        setTrafficEvents((old) => [...old, ...incoming].slice(-100));
        setTrafficPulse((old) => {
          const next = { ...old };
          for (const event of incoming) next[event.routeId] = Date.now() + 2800;
          return next;
        });
      } catch {
        show('Received an invalid traffic update.', true);
      }
    });
    source.onerror = () => setTrafficStatus('disconnected');
    return () => source.close();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTrafficPulse((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([, expiry]) => expiry > now),
        ),
      );
      setTrafficNow(now);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const accept = (s: State) => {
    setState((old) => ({ ...s, certificates: old?.certificates || [] }));
    setGraph(s.draft);
    setConfigOverride(s.configDraft);
    setSelected(null);
    setValidatedKey('');
  };
  const save = () =>
    act(async () => {
      accept(
        await api(
          'draft',
          { graph: clean(graph), config: configOverride, revision: state!.revision },
          'PUT',
        ),
      );
      show('Draft saved. Live traffic is unchanged.');
    });
  const deploy = () =>
    act(async () => {
      accept(
        await api('apply', { graph: clean(graph), config: configOverride, revision: state!.revision }),
      );
      setConfirm(null);
      show('Deployed. Nginx has loaded this configuration.');
    });
  const editing = scope === 'draft' && !busy;
  const switchWorkspace = (workspaceId: string) => {
    if (workspaceId === state?.workspaceId) return;
    if (dirty) {
      show('Save or discard unsaved changes before switching workspaces.', true);
      return;
    }
    void act(async () => {
      accept(await api('workspaces/select', { id: workspaceId, revision: state!.revision }, 'PUT'));
      setScope('draft');
      show('Workspace switched. Live routing is unchanged.');
    });
  };
  const createWorkspace = () => {
    if (dirty) {
      show('Save or discard unsaved changes before creating a workspace.', true);
      return;
    }
    setWorkspaceName('');
    setWorkspaceError('');
    setWorkspaceEditor('create');
  };
  const renameWorkspace = () => {
    if (dirty) {
      show('Save or discard unsaved changes before renaming this workspace.', true);
      return;
    }
    setWorkspaceName(state?.workspaces.find((w) => w.id === state.workspaceId)?.name || '');
    setWorkspaceError('');
    setWorkspaceEditor('rename');
  };
  const submitWorkspaceEditor = async () => {
    if (!workspaceEditor) return;
    const name = workspaceName.trim();
    if (!name || name.length > 80) {
      setWorkspaceError('Enter a workspace name of 1–80 characters.');
      return;
    }
    setBusy(true);
    setWorkspaceError('');
    try {
      if (workspaceEditor === 'create') {
        accept(await api('workspaces', { name, revision: state!.revision }));
        setScope('draft');
        show('Workspace created with its own configuration files.');
      } else {
        accept(await api('workspaces/rename', { name, revision: state!.revision }, 'PUT'));
        show('Workspace renamed.');
      }
      setWorkspaceEditor(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Could not save workspace.');
    } finally {
      setBusy(false);
    }
  };
  const deleteWorkspace = () => {
    if (dirty) {
      show('Save or discard unsaved changes before removing this workspace.', true);
      return;
    }
    setConfirm({ kind: 'workspace-delete' });
  };
  const node = graph.nodes.find((n) => n.id === selected);
  const update = (data: Partial<Data>) =>
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === selected ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    }));
  const connect = (c: Connection) =>
    setGraph((g) => ({ ...g, edges: addEdge({ ...c, id: id() }, g.edges) }));
  const validConnection = (c: Edge | Connection) => {
    const a = graph.nodes.find((n) => n.id === c.source),
      b = graph.nodes.find((n) => n.id === c.target);
    const otherEdges = graph.edges.filter(
      (edge) => edge.id !== reconnectingEdgeId.current,
    );
    return (
      !!a &&
      !!b &&
      ((a.type === 'domain' &&
        b.type === 'rule' &&
        !otherEdges.some((e) => e.target === b.id)) ||
        (a.type === 'rule' &&
          b.type === 'service' &&
          !otherEdges.some((e) => e.source === a.id)))
    );
  };
  const reconnect = (oldEdge: Edge, connection: Connection) => {
    if (!validConnection(connection)) return;
    setGraph((g) => {
      const draftEdge = g.edges.find((edge) => edge.id === oldEdge.id);
      return draftEdge
        ? { ...g, edges: reconnectEdge(draftEdge, connection, g.edges) }
        : g;
    });
  };
  const addBlock = (type: string, position?: { x: number; y: number }) => {
    if (!editing) return;
    const n: Block = {
      id: id(),
      type,
      position:
        position ||
        flow.screenToFlowPosition({
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        }),
      data:
        type === 'domain'
          ? { label: 'New domain', domain: '', tls: '', forceHttps: false }
          : type === 'rule'
            ? { label: 'Path rule', path: '/', websocket: true }
            : { label: 'New service', host: '', port: 80, protocol: 'http' },
    };
    setGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
    setPalette(false);
    setSelected(n.id);
  };
  const addService = (
    service: DiscoveredService,
    position?: { x: number; y: number },
  ) => {
    if (!editing) return;
    const serviceId = id();
    setGraph((g) => ({
      ...g,
      nodes: [
        ...g.nodes.map((n) => ({ ...n, selected: false })),
        {
          id: serviceId,
          type: 'service',
          position:
            position ||
            flow.screenToFlowPosition({
              x: window.innerWidth / 2,
              y: window.innerHeight / 2,
            }),
          selected: true,
          data: {
            label: service.name,
            host: service.host,
            port: service.port ?? undefined,
            protocol: 'http',
          },
        },
      ],
    }));
    if (service.port === null) setSelected(serviceId);
  };
  const selectedBlocks = graph.nodes.filter((n) => n.selected);
  const copyBlocks = () => {
    if (!editing || !selectedBlocks.length) return;
    const ids = new Set(selectedBlocks.map((n) => n.id));
    setClipboard(
      structuredClone(
        clean({
          nodes: selectedBlocks,
          edges: graph.edges.filter(
            (e) => ids.has(e.source) && ids.has(e.target),
          ),
        }),
      ),
    );
    pasteCount.current = 0;
    show(
      `${selectedBlocks.length} block${selectedBlocks.length === 1 ? '' : 's'} copied.`,
    );
  };
  const pasteBlocks = () => {
    if (!editing || !clipboard) return;
    const offset = 40 * ++pasteCount.current;
    const ids = new Map(clipboard.nodes.map((n) => [n.id, id()]));
    const copies = clipboard.nodes.map((n) => ({
      ...structuredClone(n),
      id: ids.get(n.id)!,
      selected: true,
      position: { x: n.position.x + offset, y: n.position.y + offset },
    }));
    setGraph((g) => ({
      nodes: [...g.nodes.map((n) => ({ ...n, selected: false })), ...copies],
      edges: [
        ...g.edges.map((e) => ({ ...e, selected: false })),
        ...clipboard.edges.map((e) => ({
          ...e,
          id: id(),
          source: ids.get(e.source)!,
          target: ids.get(e.target)!,
        })),
      ],
    }));
    setSelected(null);
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        !editing ||
        section !== 'network' ||
        tab !== 'canvas' ||
        selected ||
        wizard ||
        confirm ||
        target.closest(
          'input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      if (event.key.toLowerCase() === 'c' && selectedBlocks.length) {
        event.preventDefault();
        copyBlocks();
      }
      if (event.key.toLowerCase() === 'v' && clipboard) {
        event.preventDefault();
        pasteBlocks();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (!editing || (event.target as HTMLElement).closest('.service-library'))
      return;
    const serviceId = event.dataTransfer.getData(
      'application/waypoint-service',
    );
    if (serviceId) {
      const service = discovered.find((item) => item.id === serviceId);
      if (service)
        addService(
          service,
          flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        );
      return;
    }
    const type = event.dataTransfer.getData('application/waypoint');
    if (['domain', 'rule', 'service'].includes(type))
      addBlock(
        type,
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
  };
  const exportGraph = () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, ...clean(visibleGraph) }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'waypoint-workspace.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const rules = visibleGraph.nodes
    .filter((n) => n.type === 'rule')
    .map((rule) => ({
      rule,
      domain: visibleGraph.nodes.find(
        (n) =>
          n.id === visibleGraph.edges.find((e) => e.target === rule.id)?.source,
      ),
      service: visibleGraph.nodes.find(
        (n) =>
          n.id === visibleGraph.edges.find((e) => e.source === rule.id)?.target,
      ),
    }));
  const navigate = (value: string) => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setSection(value);
    setSelected(null);
  };
  const traceRequest = () => {
    try {
      const url = new URL(trace.includes('://') ? trace : 'http://' + trace);
      const ds = visibleGraph.nodes.filter((n) => n.type === 'domain');
      const domain =
        ds.find((n) => n.data.domain === url.hostname) ||
        ds
          .filter(
            (n) =>
              n.data.domain?.startsWith('*.') &&
              url.hostname.endsWith(n.data.domain.slice(1)),
          )
          .sort(
            (a, b) =>
              (b.data.domain?.length || 0) - (a.data.domain?.length || 0),
          )[0];
      if (!domain) {
        setTraceResult('No matching domain. Nginx returns 404.');
        return;
      }
      if (url.protocol === 'https:' && !domain.data.tls) {
        setTraceResult(
          'This domain has no HTTPS certificate. Add one before using https://.',
        );
        return;
      }
      if (url.protocol === 'http:' && domain.data.forceHttps) {
        setTraceResult(
          `308 redirect → https://${url.host}${url.pathname}${url.search}`,
        );
        return;
      }
      const match = rules
        .filter(
          (r) =>
            r.domain?.id === domain.id &&
            url.pathname.startsWith(r.rule.data.path || '/'),
        )
        .sort(
          (a, b) =>
            (b.rule.data.path?.length || 0) - (a.rule.data.path?.length || 0),
        )[0];
      setTraceResult(
        match?.service
          ? `${domain.data.domain} → ${match.rule.data.path} → ${match.service.data.protocol}://${match.service.data.host}:${match.service.data.port}${url.pathname}${url.search}`
          : 'No connected path rule matches. Nginx returns 404.',
      );
    } catch {
      setTraceResult('Enter a valid URL, such as http://demo.localhost/.');
    }
  };
  if (!state)
    return (
      <main className="loading-page">
        <Waypoints size={32} />
        <h2>Opening your workspace…</h2>
        {notice && <p role="alert">{notice.text}</p>}
        <button
          className="btn"
          onClick={() => load().catch((e) => show(e.message, true))}
        >
          Retry connection
        </button>
      </main>
    );
  return (
    <SidebarProvider
      style={{ '--sidebar-width': '236px' } as React.CSSProperties}
    >
      <Sidebar className="app-sidebar">
        <SidebarHeader>
          <a className="brand" href="/">
            <span className="brand-symbol">
              <Waypoints size={23} />
            </span>
            waypoint
            <span className="brand-dot">•</span>
          </a>
          <span className="sidebar-caption">Infrastructure, connected.</span>
        </SidebarHeader>
        <WorkspaceSidebarContent>
          <div className="workspace-chip">
            <span className="workspace-avatar">
              <Server size={17} />
            </span>
            <div>
              <strong>{state.workspaces.find((w) => w.id === state.workspaceId)?.name}</strong>
              <span>{state.workspaceId === state.liveWorkspaceId ? 'Currently deployed' : 'Independent draft'}</span>
            </div>
          </div>
          <span className="nav-caption">Manage</span>
          <nav aria-label="Main navigation">
            {[
              { key: 'network', icon: Waypoints, title: 'Canvas' },
              { key: 'deployments', icon: History, title: 'Deployments' },
              { key: 'activity', icon: Activity, title: 'Activity logs' },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                aria-current={section === item.key ? 'page' : undefined}
                className={`nav-item ${section === item.key ? 'active' : ''}`}
              >
                <item.icon size={18} />
                {item.title}
                {item.key === 'network' && (
                  <span className="nav-count">
                    {graph.nodes.filter((n) => n.type === 'domain').length}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <button
            className={`nav-item ${section === 'guide' ? 'active' : ''}`}
            aria-current={section === 'guide' ? 'page' : undefined}
            onClick={() => navigate('guide')}
          >
            <BookOpen size={18} /> Getting started
          </button>
        </WorkspaceSidebarContent>
        <SidebarFooter>
          <div className="engine-status">
            <span className={`status-dot ${state.nginxRunning ? '' : 'off'}`} />
            <div>
              <strong>
                {state.nginxRunning
                  ? state.mode === 'external' || state.mode === 'systemd'
                    ? 'Connected to Nginx'
                    : 'Nginx is running'
                  : state.mode === 'external' || state.mode === 'systemd'
                    ? 'Nginx disconnected'
                    : 'Preview mode'}
              </strong>
              <span>
                {state.mode === 'external' || state.mode === 'systemd'
                  ? state.mode === 'systemd'
                    ? 'Systemd service · shared config'
                    : 'Container service · shared config'
                  : state.mode === 'standalone'
                    ? 'Managed on this device'
                    : 'No live traffic changes'}
              </span>
            </div>
          </div>
          <button
            className="nav-item"
            onClick={() => act(onLogout)}
            disabled={busy}
          >
            <LogOut size={16} />
            Sign out
          </button>
          <div className="sidebar-version">
            Waypoint <span>v0.1 · self-hosted</span>
          </div>
        </SidebarFooter>
      </Sidebar>
      <main
        className={`main-shell overflow-x-hidden w-full max-w-full ${
          section === 'network' ? 'network-route' : ''
        } ${
          section === 'network' && tab === 'canvas' ? 'canvas-route' : ''
        }`}
      >
        <header className="topbar">
          <div className="breadcrumbs">
            <SidebarTrigger className="mobile-trigger" />
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {section === 'network'
                ? 'Canvas'
                : section === 'deployments'
                  ? 'Deployments'
                  : section === 'activity'
                    ? 'Activity logs'
                    : 'Getting started'}
            </strong>
          </div>
          <span className="local-badge">
            <Server size={14} /> Self-hosted instance
          </span>
        </header>
        <div
          className={`page-content ${
            section === 'network' ? 'canvas-page' : ''
          }`}
        >
          {section !== 'network' && (
            <div className="page-heading">
              <div>
                <h1 className="max-w-5xl">
                  {section === 'deployments'
                    ? 'Deployment history'
                    : section === 'activity'
                      ? 'Activity logs'
                      : 'A simpler way to connect.'}
                </h1>
                <p>
                  {section === 'deployments'
                    ? 'Review what went live, and return to an earlier version.'
                    : section === 'activity'
                      ? 'Understand your traffic and investigate requests.'
                      : 'Everything you need to build your first route.'}
                </p>
              </div>
            </div>
          )}
          {notice && (
            <div
              className={`notice ${notice.bad ? 'error' : 'success'}`}
              role={notice.bad ? 'alert' : 'status'}
            >
              <span>{notice.text}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {section === 'network' && (
            <>
              <header className="canvas-command-bar">
                <div className="canvas-title">
                  <span className="canvas-title-icon">
                    <Waypoints size={19} />
                  </span>
                  <div>
                    <h1>Network canvas</h1>
                    <span>
                      <i
                        className={`status-dot ${trafficStatus === 'connected' ? '' : 'off'}`}
                      />
                      {trafficStatus === 'connected'
                        ? 'Nginx connected'
                        : 'Nginx disconnected'}
                    </span>
                  </div>
                </div>
                <div
                  className="canvas-metrics grid-flow-dense"
                  aria-label="Network statistics"
                >
                  <span>
                    <strong>
                      {
                        visibleGraph.nodes.filter((n) => n.type === 'domain')
                          .length
                      }
                    </strong>{' '}
                    domains
                  </span>
                  <span>
                    <strong>
                      {
                        visibleGraph.nodes.filter((n) => n.type === 'rule')
                          .length
                      }
                    </strong>{' '}
                    rules
                  </span>
                  <span>
                    <strong>
                      {
                        visibleGraph.nodes.filter((n) => n.type === 'service')
                          .length
                      }
                    </strong>{' '}
                    services
                  </span>
                  <span>
                    <strong>
                      {
                        trafficEvents.filter(
                          (event) =>
                            Date.parse(event.timestamp) >= trafficNow - 10000,
                        ).length
                      }
                    </strong>
                    requests / 10s
                  </span>
                </div>
                <div className="canvas-actions">
                  <button
                    className="btn compact-add"
                    disabled={busy || scope === 'live'}
                    onClick={() => setWizard(true)}
                  >
                    <Plus size={16} /> Add route
                  </button>
                  <button
                    className="btn save-draft"
                    onClick={save}
                    disabled={busy || !dirty}
                    title={dirty ? 'Save draft changes' : 'Draft is saved'}
                  >
                    <Save size={15} />
                    {dirty ? 'Save' : 'Saved'}
                  </button>
                  <button
                    className="btn validate-button"
                    disabled={
                      busy || previewPending || preview.errors.length > 0
                    }
                    onClick={validateConfiguration}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <ShieldCheck size={15} />
                    )}
                    {validatedKey === graphKey ? 'Validated' : 'Validate'}
                  </button>
                  <button
                    className="btn primary deploy-button"
                    title={
                      state.mode === 'preview'
                        ? 'Deployment is unavailable in preview mode'
                        : scope === 'live'
                          ? 'Switch to Draft to deploy changes'
                          : !deployable && !previewPending && !preview.errors.length
                            ? 'The configuration matches what is already deployed'
                          : preview.errors.length
                            ? 'Resolve the configuration issues before deploying'
                            : 'Validate and deploy the draft to Nginx'
                    }
                    disabled={
                      busy ||
                      scope === 'live' ||
                      previewPending ||
                      preview.errors.length > 0 ||
                      !deployable ||
                      state.mode === 'preview'
                    }
                    onClick={() => setConfirm({ kind: 'deploy' })}
                  >
                    <Radio size={15} /> Deploy
                  </button>
                </div>
              </header>
              <section className="editor-card" aria-label="Network workspace">
                <div className="editor-toolbar">
                  <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                    <TabsList variant="line">
                      <TabsTrigger value="canvas">
                        <Waypoints />
                        Canvas
                      </TabsTrigger>
                      <TabsTrigger value="list">
                        <List />
                        Route list
                      </TabsTrigger>
                      <TabsTrigger value="config">
                        <Code2 />
                        Nginx config
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <div className="toolbar-right">
                    <div className="toolbar-control toolbar-control-workspace">
                      <span>Workspace</span>
                      <WorkspacePicker
                        value={state.workspaceId}
                        items={state.workspaces.map((w) => ({ value: w.id, label: w.name }))}
                        onSwitch={switchWorkspace}
                        onAdd={createWorkspace}
                        onRename={renameWorkspace}
                        onRemove={deleteWorkspace}
                        canRemove={state.workspaces.length > 1 && state.workspaceId !== state.liveWorkspaceId}
                        disabled={busy}
                      />
                    </div>
                    <div className="toolbar-control toolbar-control-version">
                      <span>View</span>
                      <Picker
                        label="Workspace version"
                        value={scope}
                        onChange={(v) => {
                          setScope(v);
                          setSelected(null);
                        }}
                        items={[
                          { value: 'draft', label: 'Draft' },
                          { value: 'live', label: 'Deployed' },
                        ]}
                      />
                    </div>
                    <button
                      className="icon-btn"
                      title="Export workspace"
                      aria-label="Export workspace"
                      onClick={exportGraph}
                    >
                      <ArrowDownToLine size={17} />
                    </button>
                  </div>
                </div>
                <div className="canvas-context">
                  <div>
                    <span
                      className={`status-dot ${scope === 'live' && state.liveConfig ? '' : 'draft'}`}
                    />
                    <strong>
                      {scope === 'live'
                        ? 'Deployed configuration'
                        : 'Draft configuration'}
                    </strong>
                    <span>
                      {scope === 'live'
                        ? 'Read only'
                        : dirty
                          ? 'Unsaved edits'
                          : 'Saved on this device'}
                    </span>
                  </div>
                  {scope === 'draft' && (
                    <div>
                      {tab === 'canvas' && (
                        <>
                          <button
                            className="icon-btn"
                            aria-label="Edit selected block"
                            title="Edit selected block (double-click)"
                            disabled={busy || selectedBlocks.length !== 1}
                            onClick={() => setSelected(selectedBlocks[0].id)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className="icon-btn"
                            aria-label="Copy selected blocks"
                            title="Copy selected blocks (Ctrl/Cmd+C)"
                            disabled={busy || !selectedBlocks.length}
                            onClick={copyBlocks}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            className="icon-btn"
                            aria-label="Paste blocks"
                            title="Paste blocks (Ctrl/Cmd+V)"
                            disabled={busy || !clipboard}
                            onClick={pasteBlocks}
                          >
                            <ClipboardPaste size={16} />
                          </button>
                        </>
                      )}
                      <button
                        className="text-btn"
                        onClick={() => {
                          setTab('canvas');
                          setPalette(!palette);
                        }}
                        disabled={busy}
                      >
                        <Plus size={15} />
                        Add block
                      </button>
                      <button
                        className="btn small"
                        onClick={() => setWizard(true)}
                        disabled={busy}
                      >
                        <Plus size={15} />
                        Add route
                      </button>
                    </div>
                  )}
                </div>
                {tab === 'canvas' && (
                  <div
                    className={`canvas ${servicesOpen ? 'services-expanded' : ''}`}
                    onDrop={drop}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = editing ? 'copy' : 'none';
                    }}
                  >
                    <ReactFlow
                      nodes={visibleNodes}
                      edges={activeEdges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      onNodesChange={(changes) =>
                        editing &&
                        setGraph((g) => ({
                          ...g,
                          nodes: applyNodeChanges(changes, g.nodes),
                        }))
                      }
                      onEdgesChange={(changes) =>
                        editing &&
                        setGraph((g) => ({
                          ...g,
                          edges: applyEdgeChanges(changes, g.edges),
                        }))
                      }
                      onConnect={connect}
                      onReconnect={reconnect}
                      onReconnectStart={(_, edge) => {
                        reconnectingEdgeId.current = edge.id;
                      }}
                      onReconnectEnd={() => {
                        reconnectingEdgeId.current = null;
                      }}
                      isValidConnection={validConnection}
                      onNodeDoubleClick={(_, n) => editing && setSelected(n.id)}
                      multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
                      selectionOnDrag
                      panOnDrag={[1, 2]}
                      nodesDraggable={editing}
                      nodesConnectable={editing}
                      edgesReconnectable={editing}
                      elementsSelectable={editing}
                      deleteKeyCode={editing ? ['Backspace', 'Delete'] : null}
                      defaultEdgeOptions={{
                        type: 'smoothstep',
                        style: { stroke: '#75988e', strokeWidth: 2 },
                        animated: false,
                      }}
                      fitView
                      fitViewOptions={{ padding: 0.18, maxZoom: 0.95 }}
                      minZoom={0.25}
                      maxZoom={1.5}
                      colorMode="light"
                    >
                      <Background color="#cbd5d1" gap={22} size={1} />
                      <Controls showInteractive={false} />
                      <MiniMap
                        nodeColor={(n) =>
                          n.type === 'domain'
                            ? '#a4c8f5'
                            : n.type === 'rule'
                              ? '#b7addd'
                              : '#9dd5b8'
                        }
                        maskColor="#f4f7f4bb"
                        pannable
                        zoomable
                      />
                    </ReactFlow>
                    {visibleGraph.nodes.length === 0 && (
                      <div className="canvas-empty">
                        <div className="intro-icon">
                          <Network size={26} />
                        </div>
                        <h3>
                          {scope === 'live'
                            ? 'Nothing deployed yet'
                            : 'Start with a connection'}
                        </h3>
                        <p>
                          {scope === 'live'
                            ? 'Deploy your draft to see its live topology here.'
                            : 'Add a domain, a path rule, and a destination.'}
                        </p>
                        {scope === 'draft' && (
                          <button
                            className="btn primary"
                            onClick={() => setWizard(true)}
                          >
                            <Plus size={16} />
                            Create your first route
                          </button>
                        )}
                      </div>
                    )}
                    {palette && editing && (
                      <div className="block-palette">
                        <div>
                          <strong>Add a building block</strong>
                          <button
                            className="icon-btn"
                            aria-label="Close block palette"
                            onClick={() => setPalette(false)}
                          >
                            <X size={15} />
                          </button>
                        </div>

                        {(['domain', 'rule', 'service'] as const).map((k) => {
                          const Icon = icons[k];
                          return (
                            <button
                              key={k}
                              draggable
                              onDragStart={(e) =>
                                e.dataTransfer.setData(
                                  'application/waypoint',
                                  k,
                                )
                              }
                              onClick={() => addBlock(k)}
                            >
                              <span className={`type-icon ${k}`}>
                                <Icon size={19} />
                              </span>
                              <span>
                                <strong>{titles[k]}</strong>
                              </span>
                              <Plus size={15} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <aside
                      className={`service-library ${servicesOpen ? 'expanded' : ''}`}
                      aria-label="Service library"
                    >
                      <button
                        className="service-library-toggle"
                        aria-expanded={servicesOpen}
                        aria-controls="service-library-content"
                        onClick={() => {
                          setServicesOpen(!servicesOpen);
                          if (!servicesOpen && !scanned) void scanServices();
                        }}
                        title={
                          servicesOpen ? 'Collapse services' : 'Expand services'
                        }
                      >
                        {servicesOpen ? (
                          <PanelRightClose size={18} />
                        ) : (
                          <PanelRightOpen size={18} />
                        )}
                        <span>Services</span>
                        <span className="service-count">
                          {discovered.length}
                        </span>
                      </button>
                      {servicesOpen && (
                        <div
                          id="service-library-content"
                          className="service-library-content"
                        >
                          <div className="service-library-tools">
                            <label className="service-search">
                              <Search size={15} />
                              <input
                                aria-label="Search services"
                                placeholder="Search services"
                                value={serviceSearch}
                                onChange={(e) =>
                                  setServiceSearch(e.target.value)
                                }
                              />
                            </label>
                            <button
                              className="icon-btn"
                              aria-label="Scan containers"
                              title="Scan containers"
                              disabled={scanning}
                              onClick={() => void scanServices()}
                            >
                              <RefreshCw
                                size={16}
                                className={scanning ? 'spin' : ''}
                              />
                            </button>
                          </div>
                          {scanError && (
                            <p className="service-scan-error" role="alert">
                              {scanError}
                            </p>
                          )}
                          <div
                            className="service-library-list"
                            aria-busy={scanning}
                          >
                            {!discovered.length && (
                              <output className="service-library-empty">
                                {scanning
                                  ? 'Scanning containers…'
                                  : scanError
                                    ? 'Refresh to try again.'
                                    : state.mode === 'systemd'
                                      ? 'No containers with published TCP ports found.'
                                      : 'No containers found on shared networks.'}
                              </output>
                            )}
                            {!!discovered.length &&
                              !discovered.some((s) =>
                                `${s.name} ${s.host} ${s.port ?? ''}`
                                  .toLowerCase()
                                  .includes(serviceSearch.toLowerCase()),
                              ) && (
                                <p className="service-library-empty">
                                  No matching services.
                                </p>
                              )}
                            {discovered
                              .filter((s) =>
                                `${s.name} ${s.host} ${s.port ?? ''}`
                                  .toLowerCase()
                                  .includes(serviceSearch.toLowerCase()),
                              )
                              .map((service) => (
                                <button
                                  key={service.id}
                                  className="library-service"
                                  draggable={editing}
                                  disabled={!editing}
                                  title={
                                    editing
                                      ? `Drag to canvas or click to add ${service.name}`
                                      : 'Switch to Draft to add services'
                                  }
                                  onDragStart={(e) => {
                                    e.dataTransfer.effectAllowed = 'copy';
                                    e.dataTransfer.setData(
                                      'application/waypoint-service',
                                      service.id,
                                    );
                                  }}
                                  onClick={() => addService(service)}
                                >
                                  <span className="type-icon service">
                                    <Box size={18} />
                                  </span>
                                  <span>
                                    <strong>{service.name}</strong>
                                    <small>
                                      {service.host}:
                                      {service.port ?? 'Set port'}
                                    </small>
                                  </span>
                                  <Plus size={14} />
                                </button>
                              ))}
                          </div>
                        </div>
                      )}
                    </aside>
                  </div>
                )}
                {tab === 'list' && (
                  <div className="route-table">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Domain</TableHead>
                          <TableHead>Path</TableHead>
                          <TableHead>Destination</TableHead>
                          <TableHead>Protocol</TableHead>
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rules.map(({ rule, domain, service }) => (
                          <TableRow key={rule.id}>
                            <TableCell>
                              <Globe2 size={15} />
                              {domain?.data.domain || 'Unconnected domain'}
                            </TableCell>
                            <TableCell>
                              <code>{rule.data.path}</code>
                            </TableCell>
                            <TableCell>
                              {service
                                ? `${service.data.host}:${service.data.port}`
                                : 'Unconnected service'}
                            </TableCell>
                            <TableCell>
                              {domain?.data.tls ? 'HTTPS' : 'HTTP'}
                            </TableCell>
                            <TableCell>
                              <button
                                className="text-btn"
                                disabled={!editing}
                                onClick={() => setSelected(rule.id)}
                              >
                                Edit
                                <ChevronRight size={14} />
                              </button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {rules.length === 0 && (
                      <p className="empty-copy">
                        No routes in this workspace yet.
                      </p>
                    )}
                  </div>
                )}
                {tab === 'config' && (
                  <div className="config-view">
                    <div>
                      <span>
                        <Code2 size={15} />
                        {state.workspaceId}/draft.conf <small>{configOverride === null ? 'Generated from your graph' : 'Custom configuration'}</small>
                      </span>
                      <div className="config-actions">
                        {scope === 'draft' && (
                          configOverride === null ?
                            <button className="text-btn" disabled={previewPending || !preview.config} onClick={() => setConfigOverride(preview.config)}><Pencil size={14} /> Edit file</button> :
                            <button className="text-btn" onClick={() => setConfigOverride(null)}><RotateCcw size={14} /> Use generated</button>
                        )}
                        <button className="text-btn" disabled={previewPending || !preview.config} onClick={() =>
                          act(async () => { await navigator.clipboard.writeText(preview.config); show('Configuration copied.'); })
                        }><Copy size={14} /> Copy</button>
                      </div>
                    </div>
                    {scope === 'draft' && configOverride !== null ? (
                      <>
                        <p className="config-editor-hint">Edit Nginx text directly. Keep the Waypoint deployment marker; Validate checks syntax before deployment. Graph changes do not automatically rewrite custom text.</p>
                        <textarea aria-label="Edit workspace Nginx configuration" className="config-editor" spellCheck={false} value={configOverride} onChange={(e) => setConfigOverride(e.target.value)} />
                      </>
                    ) : <pre>{scope === 'live' && state.liveConfig ? state.liveConfig : previewPending ? 'Generating configuration…' : preview.config || 'Complete the connections and settings below to generate your Nginx configuration.'}</pre>}
                  </div>
                )}
                <div className="editor-status">
                  <span>
                    {previewPending ? (
                      <LoaderCircle size={15} />
                    ) : preview.errors.length ? (
                      <CircleHelp size={15} />
                    ) : (
                      <ShieldCheck size={15} />
                    )}{' '}
                    {previewPending
                      ? 'Checking your graph…'
                      : preview.errors.length
                        ? `${preview.errors.length} thing${preview.errors.length === 1 ? '' : 's'} to finish`
                        : validatedKey === graphKey
                          ? 'Configuration validated'
                          : 'Graph is ready for validation'}
                  </span>
                  {tab === 'canvas' && (
                    <span className="canvas-shortcuts">
                      Double-click to edit · Scroll to zoom · Right-drag to pan
                    </span>
                  )}
                </div>
              </section>
              {preview.errors.length > 0 && !previewPending && (
                <output className="validation-list">
                  <strong>Let’s finish these connections</strong>
                  <ul>
                    {preview.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </output>
              )}
              {!state.liveConfig &&
                scope === 'draft' &&
                tab !== 'canvas' &&
                graph.nodes.some((n) => n.id === 'demo-domain') && (
                  <div className="example-note">
                    <CircleHelp size={16} />
                    <span>
                      The starter route points to the Docker demo service. Edit
                      it for your app, or deploy it and visit{' '}
                      <code>http://demo.localhost</code>.
                    </span>
                  </div>
                )}
              {tab !== 'canvas' && (
                <>
                  <div className="trace-card">
                    <div>
                      <Route size={19} />
                      <div>
                        <h3>Follow a request</h3>
                        <p>
                          Simulate a {scope === 'live' ? 'deployed' : 'draft'}{' '}
                          route.
                        </p>
                      </div>
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        traceRequest();
                      }}
                    >
                      <input
                        aria-label="URL to trace"
                        placeholder="http://demo.localhost/"
                        value={trace}
                        onChange={(e) => {
                          setTrace(e.target.value);
                          setTraceResult('');
                        }}
                        required
                      />
                      <button className="btn" type="submit">
                        Trace route
                        <ArrowRight size={15} />
                      </button>
                    </form>
                    {traceResult && <output>{traceResult}</output>}
                  </div>
                  <div className="workspace-footer">
                    <div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".json,application/json"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          void act(async () => {
                            if (file.size > 1024 * 1024)
                              throw new Error(
                                'Workspace files must be smaller than 1 MB.',
                              );
                            const imported = JSON.parse(await file.text());
                            if (
                              !Array.isArray(imported.nodes) ||
                              !Array.isArray(imported.edges)
                            )
                              throw new Error(
                                'Choose a Waypoint workspace JSON file.',
                              );
                            const validated = await api('preview', {
                              graph: imported,
                            });
                            pendingImport.current = validated.graph;
                            setConfirm({ kind: 'import' });
                          });
                          e.target.value = '';
                        }}
                      />
                      <button
                        className="text-btn"
                        disabled={!editing}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload size={14} />
                        Import workspace
                      </button>
                      <button
                        className="text-btn"
                        onClick={() => navigate('guide')}
                      >
                        <BookOpen size={14} />
                        Quick guide
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {section === 'deployments' && (
            <section className="content-card">
              <div className="section-label">
                <History size={18} />
                <h2>Successful deployments</h2>
                <span>Last 10 previous versions retained</span>
              </div>
              {state.applied ? (
                <>
                  <div className="deployment-row">
                    <span className="deployment-icon">
                      <Radio size={21} />
                    </span>
                    <div>
                      <strong>
                        {state.workspaceId === state.liveWorkspaceId ? 'Current deployment' : 'Last deployment from this workspace'}{' '}
                        {state.workspaceId === state.liveWorkspaceId && <span className="tag green">LIVE</span>}
                      </strong>
                      <p>{new Date(state.applied.at).toLocaleString()}</p>
                      <code>{state.applied.id}</code>
                    </div>
                    <button
                      className="btn"
                      onClick={() => {
                        navigate('network');
                        setScope('live');
                      }}
                    >
                      View canvas
                      <ExternalLink size={14} />
                    </button>
                  </div>
                  {state.history.map((h) => (
                    <div className="deployment-row" key={h.id}>
                      <span className="deployment-icon old">
                        <History size={21} />
                      </span>
                      <div>
                        <strong>{new Date(h.at).toLocaleString()}</strong>
                        <p>
                          {
                            h.graph.nodes.filter((n) => n.type === 'domain')
                              .length
                          }{' '}
                          domains ·{' '}
                          {
                            h.graph.nodes.filter((n) => n.type === 'service')
                              .length
                          }{' '}
                          services
                        </p>
                        <code>{h.id}</code>
                      </div>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({ kind: 'rollback', id: h.id })
                        }
                      >
                        <RotateCcw size={14} />
                        Restore
                      </button>
                    </div>
                  ))}
                </>
              ) : (
                <div className="section-empty">
                  <History size={32} />
                  <h3>Your first deployment starts here.</h3>
                  <p>
                    Build a route, validate it, and deploy. Its configuration
                    will appear here.
                  </p>
                  <button
                    className="btn primary"
                    onClick={() => navigate('network')}
                  >
                    Open canvas
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </section>
          )}
          {section === 'activity' && (
            <section className="activity-stack">
              <div className="content-card live-traffic-card">
                <div className="section-label">
                  <Radio size={18} />
                  <h2>Live traffic</h2>
                  <span className={`traffic-status ${trafficStatus}`}>
                    <span className="status-dot" />
                    {trafficStatus === 'connected'
                      ? trafficLastAt && trafficNow - trafficLastAt < 10000
                        ? 'Connected'
                        : 'Connected · idle'
                      : 'Stream disconnected'}
                  </span>
                </div>
                <div className="traffic-controls">
                  <label>
                    Route
                    <select
                      value={trafficFilter}
                      onChange={(event) => setTrafficFilter(event.target.value)}
                    >
                      <option value="all">All deployed routes</option>
                      {Object.entries(routeNames).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn small"
                    type="button"
                    onClick={() =>
                      setTrafficPaused((paused) => {
                        trafficPausedRef.current = !paused;
                        return !paused;
                      })
                    }
                  >
                    {trafficPaused ? 'Resume animation' : 'Pause animation'}
                  </button>
                  <span className="muted">
                    Waypoint-managed routes · completed requests
                  </span>
                </div>
                <div className="traffic-metrics">
                  {(() => {
                    const windowEvents = displayedTraffic.filter((event) => {
                      const time = Date.parse(event.timestamp);
                      return (
                        Number.isFinite(time) && time >= trafficNow - 10000
                      );
                    });
                    const errors = windowEvents.filter(
                      (event) => event.status >= 400,
                    ).length;
                    const average = windowEvents.length
                      ? windowEvents.reduce(
                          (sum, event) => sum + event.responseTime * 1000,
                          0,
                        ) / windowEvents.length
                      : 0;
                    return (
                      <>
                        <div>
                          <strong>
                            {(windowEvents.length / 10).toFixed(1)}
                          </strong>
                          <span>requests/sec</span>
                        </div>
                        <div>
                          <strong>{errors}</strong>
                          <span>recent errors</span>
                        </div>
                        <div>
                          <strong>{average.toFixed(0)} ms</strong>
                          <span>average response</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
                <div className="traffic-list" aria-live="polite">
                  {displayedTraffic.length ? (
                    displayedTraffic
                      .slice(-30)
                      .reverse()
                      .map((event, index) => (
                        <div
                          className="traffic-row"
                          key={`${event.timestamp}-${event.routeId}-${index}`}
                        >
                          <span
                            className={`traffic-method method-${event.method}`}
                          >
                            {event.method}
                          </span>
                          <strong>
                            {routeNames[event.routeId] || event.routeId}
                          </strong>
                          <span
                            className={
                              event.status >= 400 ? 'traffic-error' : ''
                            }
                          >
                            {event.status}
                          </span>
                          <span>
                            {(event.responseTime * 1000).toFixed(0)} ms
                          </span>
                          <time dateTime={event.timestamp}>
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </time>
                        </div>
                      ))
                  ) : (
                    <p className="muted">
                      No completed requests match this route yet.
                    </p>
                  )}
                </div>
              </div>
              <div className="content-card">
                <div className="section-label">
                  <Activity size={18} />
                  <h2>Nginx logs</h2>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        setLogs(await api('logs'));
                        show('Logs refreshed.');
                      })
                    }
                  >
                    Refresh
                  </button>
                </div>
                <p className="muted">
                  The latest 16 KB from Waypoint-managed routes. Refresh to see
                  new requests. Existing Nginx routes keep their current logs.
                </p>
                <h3 className="log-heading">Access log</h3>
                <pre className="log-output">
                  {logs.access || 'No requests recorded yet.'}
                </pre>
                <h3 className="log-heading">Error log</h3>
                <pre className="log-output">
                  {logs.error || 'No Nginx errors recorded.'}
                </pre>
              </div>
            </section>
          )}
          {section === 'guide' && (
            <Suspense
              fallback={<div className="content-card">Loading your guide…</div>}
            >
              <GuideExperience
                onCreate={() => {
                  navigate('network');
                  setScope('draft');
                  setWizard(true);
                }}
                onNetwork={() => navigate('network')}
              >
                <article className="content-card guide-wide">
                  <h2>From a draft to a working service</h2>
                  <ol>
                    <li>
                      <strong>Connect your service.</strong> Put your existing
                      Nginx, Waypoint, and the app on the same Docker network.
                    </li>
                    <li>
                      <strong>Add a route.</strong> Use the guided form, or add
                      three blocks and connect domain → path rule → service. A
                      service can receive traffic from multiple routes.
                    </li>
                    <li>
                      <strong>Point your domain here.</strong> Create an A
                      record pointing to the server where your existing Nginx
                      accepts traffic.
                    </li>
                    <li>
                      <strong>Validate, then deploy.</strong> Saving a draft
                      does not change traffic. Deployment checks the full config
                      inside your existing Nginx, then gracefully reloads it.
                    </li>
                    <li>
                      <strong>Add HTTPS.</strong> Mount a certificate and
                      private key in data/certificates/&lt;name&gt;/ as cert.pem
                      and key.pem. Reopen the workspace, select the certificate
                      on your domain, and deploy. Automatic certificate issuance
                      is not included yet.
                    </li>
                  </ol>
                  <div className="notice">
                    <CircleHelp size={18} />
                    <span>
                      This version visualizes configuration managed by Waypoint.
                      Use Add route → Scan Docker services to find
                      shared-network containers. It does not import arbitrary
                      Nginx configuration. Workspace import accepts Waypoint
                      JSON.
                    </span>
                  </div>
                </article>
                <article className="content-card guide-wide">
                  <h2>A few useful details</h2>
                  <p>
                    Paths are prefix matches. The longest matching path wins,
                    and the original path is forwarded unchanged. Use{' '}
                    <code>/api/</code> to avoid also matching{' '}
                    <code>/apiculture</code>.
                  </p>
                  <p>
                    Inside Docker, <code>localhost</code> means the Waypoint
                    container itself. For another container use its service
                    name. For a host app use <code>host.docker.internal</code>{' '}
                    where available.
                  </p>
                  <p>
                    HTTPS upstreams use certificate verification. WebSocket
                    support adds the headers applications such as dashboards and
                    chat services need. A successful deployment validates
                    configuration, but does not guarantee your destination is
                    reachable.
                  </p>
                </article>
              </GuideExperience>
            </Suspense>
          )}
        </div>
      </main>
      <Sheet
        open={!!node && editing}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="inspector">
          <SheetHeader>
            <span className={`type-icon ${node?.type}`}>
              <Waypoints size={21} />
            </span>
            <SheetTitle>
              {node ? titles[node.type as keyof typeof titles] : ''} settings
            </SheetTitle>
            <SheetDescription className="sr-only">
              {node ? explanations[node.type as keyof typeof explanations] : ''}
            </SheetDescription>
          </SheetHeader>
          {node && (
            <div className="inspector-body">
              <label className="field">
                Display name
                <input
                  value={node.data.label}
                  maxLength={100}
                  onChange={(e) => update({ label: e.target.value })}
                />
              </label>
              {node.type === 'domain' && (
                <>
                  <label className="field">
                    Domain name
                    <input
                      value={node.data.domain}
                      onChange={(e) => update({ domain: e.target.value })}
                      placeholder="app.example.com"
                    />
                    <small>Use a hostname, without http:// or a path.</small>
                  </label>
                  <label className="field">
                    Maximum upload size (MB)
                    <input
                      type="number"
                      min={1}
                      max={1024}
                      value={node.data.maxBodySizeMb ?? 1}
                      onChange={(e) =>
                        update({ maxBodySizeMb: Number(e.target.value) })
                      }
                    />
                    <small>
                      Requests with larger bodies are rejected. Preserve your
                      app’s existing limit when migrating.
                    </small>
                  </label>
                  <div className="field">
                    TLS certificate
                    <Picker
                      label="TLS certificate"
                      value={node.data.tls || 'none'}
                      onChange={(v) =>
                        update({
                          tls: v === 'none' ? '' : v,
                          forceHttps:
                            v === 'none' ? false : node.data.forceHttps,
                        })
                      }
                      items={[
                        { value: 'none', label: 'HTTP only' },
                        ...state.certificates.map((c) => ({
                          value: c,
                          label: c,
                        })),
                      ]}
                    />
                    <small>
                      Mount cert.pem and key.pem under
                      data/certificates/&lt;name&gt;/ to add a certificate.
                    </small>
                  </div>
                  <div className="toggle-row">
                    <div>
                      <strong>Redirect to HTTPS</strong>
                      <p>Send HTTP visitors to the secure address.</p>
                    </div>
                    <Switch
                      aria-label="Redirect to HTTPS"
                      disabled={!node.data.tls}
                      checked={!!node.data.forceHttps}
                      onCheckedChange={(v) => update({ forceHttps: v })}
                    />
                  </div>
                </>
              )}
              {node.type === 'rule' && (
                <>
                  <label className="field">
                    Matching path
                    <input
                      value={node.data.path}
                      onChange={(e) => update({ path: e.target.value })}
                    />
                    <small>
                      / matches everything. /api/ matches requests within that
                      path. The original URL path is preserved.
                    </small>
                  </label>
                  <div className="field">
                    From domain
                    <Picker
                      label="Source domain"
                      value={
                        graph.edges.find((e) => e.target === node.id)?.source ||
                        'none'
                      }
                      onChange={(v) =>
                        setGraph((g) => ({
                          ...g,
                          edges: [
                            ...g.edges.filter((e) => e.target !== node.id),
                            ...(v === 'none'
                              ? []
                              : [{ id: id(), source: v, target: node.id }]),
                          ],
                        }))
                      }
                      items={[
                        { value: 'none', label: 'Not connected' },
                        ...graph.nodes
                          .filter((n) => n.type === 'domain')
                          .map((n) => ({
                            value: n.id,
                            label: n.data.domain || n.data.label,
                          })),
                      ]}
                    />
                  </div>
                  <div className="field">
                    To service
                    <Picker
                      label="Destination service"
                      value={
                        graph.edges.find((e) => e.source === node.id)?.target ||
                        'none'
                      }
                      onChange={(v) =>
                        setGraph((g) => ({
                          ...g,
                          edges: [
                            ...g.edges.filter((e) => e.source !== node.id),
                            ...(v === 'none'
                              ? []
                              : [{ id: id(), source: node.id, target: v }]),
                          ],
                        }))
                      }
                      items={[
                        { value: 'none', label: 'Not connected' },
                        ...graph.nodes
                          .filter((n) => n.type === 'service')
                          .map((n) => ({ value: n.id, label: n.data.label })),
                      ]}
                    />
                  </div>
                  <div className="toggle-row">
                    <div>
                      <strong>WebSocket support</strong>
                      <p>Allow persistent, two-way connections.</p>
                    </div>
                    <Switch
                      aria-label="WebSocket support"
                      checked={!!node.data.websocket}
                      onCheckedChange={(v) => update({ websocket: v })}
                    />
                  </div>
                </>
              )}
              {node.type === 'service' && (
                <>
                  <label className="field">
                    Hostname or IP address
                    <input
                      value={node.data.host}
                      onChange={(e) => update({ host: e.target.value })}
                      placeholder="my-app or 192.168.1.20"
                    />
                    <small>
                      Use a Docker service name on the same network, or a
                      reachable IP. Do not include a URL path.
                    </small>
                  </label>
                  <label className="field">
                    Port
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={node.data.port || ''}
                      onChange={(e) => update({ port: Number(e.target.value) })}
                    />
                  </label>
                  <label className="field">
                    Upstream Host header{' '}
                    <span className="optional">optional</span>
                    <input
                      value={node.data.hostHeader || ''}
                      onChange={(e) => update({ hostHeader: e.target.value })}
                      placeholder="Defaults to the visitor's domain"
                    />
                    <small>
                      Override only when the upstream rejects the public domain,
                      as Ollama does for non-local Host headers.
                    </small>
                  </label>
                  <div className="field">
                    Upstream protocol
                    <Picker
                      label="Upstream protocol"
                      value={node.data.protocol || 'http'}
                      onChange={(v) => update({ protocol: v })}
                      items={[
                        { value: 'http', label: 'HTTP' },
                        { value: 'https', label: 'HTTPS (verify certificate)' },
                      ]}
                    />
                    <small>
                      This is the connection from Nginx to your app.
                    </small>
                  </div>
                </>
              )}
              <button className="btn primary" onClick={() => setSelected(null)}>
                <Check size={16} />
                Done editing
              </button>
              <button
                className="text-btn danger"
                onClick={() => setConfirm({ kind: 'delete', id: node.id })}
              >
                <Trash2 size={15} />
                Remove block
              </button>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {wizard && (
        <RouteWizard
          open={wizard}
          onClose={() => setWizard(false)}
          graph={graph}
          mode={state.mode}
          onAdd={(newNodes, newEdges) => {
            setGraph((g) => ({
              ...g,
              nodes: [...g.nodes, ...newNodes],
              edges: [...g.edges, ...newEdges],
            }));
            setWizard(false);
            setScope('draft');
            setTab('canvas');
            show('Route added to your draft. Validate and deploy when ready.');
            setTimeout(
              () => flow.fitView({ padding: 0.2, duration: 300 }),
              100,
            );
          }}
        />
      )}
      <Dialog open={workspaceEditor !== null} onOpenChange={(open) => !open && !busy && setWorkspaceEditor(null)}>
        <DialogContent className="workspace-dialog">
          <DialogTitle>{workspaceEditor === 'create' ? 'Add workspace' : 'Rename workspace'}</DialogTitle>
          <DialogDescription>
            {workspaceEditor === 'create'
              ? 'Create a separate draft without changing live routing.'
              : 'Give the current workspace a new name.'}
          </DialogDescription>
          <form onSubmit={(event) => { event.preventDefault(); void submitWorkspaceEditor(); }}>
            <label className="field">
              Workspace name
              <input
                autoFocus
                required
                maxLength={80}
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="My workspace"
              />
            </label>
            {workspaceError && <p className="notice error" role="alert">{workspaceError}</p>}
            <div className="workspace-dialog-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setWorkspaceEditor(null)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={busy || !workspaceName.trim()}>
                {workspaceEditor === 'create' ? 'Create workspace' : 'Save name'}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(open) => !open && !busy && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {confirm?.kind === 'delete'
              ? 'Remove this block?'
              : confirm?.kind === 'workspace-delete'
                ? 'Remove this workspace?'
              : confirm?.kind === 'rollback'
                ? 'Restore this deployment?'
                : confirm?.kind === 'import'
                  ? 'Replace your draft?'
                  : 'Deploy this workspace?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirm?.kind === 'delete'
              ? 'The block and its connections will be removed from your draft. Live traffic changes only after deployment.'
              : confirm?.kind === 'workspace-delete'
                ? 'This removes the workspace from the app. Its saved configuration files remain on disk for recovery. The deployed workspace cannot be removed.'
              : confirm?.kind === 'rollback'
                ? 'This replaces your draft and live routing with the selected version after Nginx validation.'
                : confirm?.kind === 'import'
                  ? 'The imported workspace will replace your current draft, including unsaved changes. Deploy it separately to change live traffic.'
                  : `This will replace live routing with ${graph.nodes.filter((n) => n.type === 'domain').length} domain(s). Nginx checks the configuration before reloading. Previous deployments remain available for rollback.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (confirm?.kind === 'delete') {
                  setGraph((g) => ({
                    nodes: g.nodes.filter((n) => n.id !== confirm.id),
                    edges: g.edges.filter(
                      (e) => e.source !== confirm.id && e.target !== confirm.id,
                    ),
                  }));
                  setSelected(null);
                  setConfirm(null);
                } else if (confirm?.kind === 'workspace-delete') {
                  void act(async () => {
                    accept(await api('workspaces', { revision: state.revision }, 'DELETE'));
                    setScope('draft');
                    setConfirm(null);
                    show('Workspace removed from the app; saved files remain on disk.');
                  });
                } else if (confirm?.kind === 'import') {
                  setGraph(clean(pendingImport.current!));
                  setConfirm(null);
                  show('Workspace imported into your draft.');
                } else if (confirm?.kind === 'rollback') {
                  void act(async () => {
                    accept(
                      await api('rollback', {
                        id: confirm.id,
                        revision: state.revision,
                      }),
                    );
                    setConfirm(null);
                    show('Previous configuration restored and verified.');
                  });
                } else void deploy();
              }}
            >
              {busy
                ? 'Working…'
                : confirm?.kind === 'delete'
                  ? 'Remove block'
                  : confirm?.kind === 'workspace-delete'
                    ? 'Remove workspace'
                  : confirm?.kind === 'import'
                    ? 'Replace draft'
                    : confirm?.kind === 'rollback'
                      ? 'Restore version'
                      : 'Deploy now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {busy && (
        <output className="busy-bar">
          <LoaderCircle size={15} className="spin" />
          Working…
        </output>
      )}
    </SidebarProvider>
  );
}
function RouteWizard({
  open,
  onClose,
  graph,
  mode,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  graph: Graph;
  mode: string;
  onAdd: (nodes: Block[], edges: Edge[]) => void;
}) {
  const [domain, setDomain] = useState(''),
    [host, setHost] = useState(''),
    [port, setPort] = useState('80'),
    [name, setName] = useState(''),
    [path, setPath] = useState('/'),
    [existing, setExisting] = useState('new'),
    [existingDomain, setExistingDomain] = useState('new');
  const [discovered, setDiscovered] = useState<
    {
      id: string;
      name: string;
      host: string;
      port: number | null;
      networks: string[];
    }[]
  >([]);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const scan = async () => {
    setScanning(true);
    setDiscovered([]);
    setScanMessage('');
    try {
      const result = await api('discovery');
      setDiscovered(result.services);
      setScanMessage(
        result.services.length
          ? `Found destinations on ${result.networks.join(', ')}. Select an HTTP service and confirm its port and protocol.`
          : mode === 'systemd'
            ? 'No running containers expose a TCP port on the host. Publish the application port and scan again, or enter a destination manually.'
            : `No other running containers found on ${result.networks.join(', ') || 'a shared network'}. Attach your app to the same Docker network as Waypoint and scan again.`,
      );
    } catch (e) {
      setScanMessage(e instanceof Error ? e.message : 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };
  const [protocol, setProtocol] = useState('http');
  const services = graph.nodes.filter((n) => n.type === 'service'),
    domains = graph.nodes.filter((n) => n.type === 'domain');
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="route-dialog">
        <DialogTitle>Create a new route</DialogTitle>
        <DialogDescription>
          Add one or several domains and point every route at one reusable
          service.
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const requestedDomains = domain
              .split(/[\n,]+/)
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean);
            if (existingDomain === 'new' && !requestedDomains.length) {
              setDomain('');
              return;
            }
            const routes =
              existingDomain === 'new'
                ? requestedDomains.map((value) => ({
                    domainId: id(),
                    domain: value,
                    createDomain: true,
                    ruleId: id(),
                  }))
                : [
                    {
                      domainId: existingDomain,
                      domain: '',
                      createDomain: false,
                      ruleId: id(),
                    },
                  ];
            const serviceId = existing === 'new' ? id() : existing;
            const firstY = graph.nodes.length
              ? Math.max(...graph.nodes.map((n) => n.position.y)) + 230
              : 100;
            const nodes: Block[] = routes.flatMap((route, index) => {
              const y = firstY + index * 180;
              return [
                ...(route.createDomain
                  ? [
                      {
                        id: route.domainId,
                        type: 'domain',
                        position: { x: 60, y },
                        data: {
                          label: route.domain,
                          domain: route.domain,
                          tls: '',
                          forceHttps: false,
                        },
                      } as Block,
                    ]
                  : []),
                {
                  id: route.ruleId,
                  type: 'rule',
                  position: { x: 410, y },
                  data: {
                    label: path === '/' ? 'All traffic' : path + ' traffic',
                    path,
                    websocket: true,
                  },
                } as Block,
              ];
            });
            if (existing === 'new')
              nodes.push({
                id: serviceId,
                type: 'service',
                position: {
                  x: 760,
                  y: firstY + ((routes.length - 1) * 180) / 2,
                },
                data: {
                  label: name || host,
                  host: host.trim(),
                  port: Number(port),
                  protocol,
                },
              });
            onAdd(
              nodes,
              routes.flatMap((route) => [
                { id: id(), source: route.domainId, target: route.ruleId },
                { id: id(), source: route.ruleId, target: serviceId },
              ]),
            );
          }}
        >
          <div className="wizard-step">
            <span className="step-number domain">01</span>
            <div>
              <h3>Where do visitors arrive?</h3>
              <p>
                Choose an existing domain, or add tenant domains in one batch.
              </p>
              {domains.length > 0 && (
                <Picker
                  label="Choose domain"
                  value={existingDomain}
                  onChange={setExistingDomain}
                  items={[
                    { value: 'new', label: 'Add a new domain' },
                    ...domains.map((n) => ({
                      value: n.id,
                      label: n.data.domain || n.data.label,
                    })),
                  ]}
                />
              )}{' '}
              {existingDomain === 'new' && (
                <label className="field">
                  Domain names
                  <textarea
                    required
                    rows={3}
                    placeholder={'tenant-a.example.com\ntenant-b.example.com'}
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                  <small>
                    Enter one domain per line. Each gets its own route block;
                    all of them share the service selected below.
                  </small>
                </label>
              )}
            </div>
          </div>
          <div className="wizard-step">
            <span className="step-number rule">02</span>
            <div>
              <h3>Which requests should go through?</h3>
              <p>Use / for all traffic, or a prefix such as /api/.</p>
              <label className="field">
                Matching path
                <input
                  required
                  pattern="/[A-Za-z0-9/_~.\-]*"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="wizard-step">
            <span className="step-number service">03</span>
            <div>
              <h3>Where does your application live?</h3>
              <p>
                Scan your Docker networks or enter a reachable hostname and
                port.
              </p>
              <button
                type="button"
                className="btn"
                disabled={scanning}
                onClick={scan}
              >
                {scanning ? 'Scanning…' : 'Scan Docker services'}
              </button>
              {scanMessage && <output>{scanMessage}</output>}
              {discovered.length > 0 && (
                <label className="field">
                  Docker destination
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const service = discovered.find(
                        (s) => s.id === e.target.value,
                      );
                      if (!service) return;
                      setExisting('new');
                      setHost(service.host);
                      setPort(
                        service.port === null ? '' : String(service.port),
                      );
                      setName(service.name);
                      setProtocol('http');
                    }}
                  >
                    <option value="" disabled>
                      Select a discovered service
                    </option>
                    {discovered.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}:{s.port ?? 'enter port'} —{' '}
                        {s.networks.join(', ')}
                      </option>
                    ))}
                  </select>
                  <small>
                    {mode === 'systemd'
                      ? 'Ports are published host ports reachable by systemd Nginx.'
                      : 'Ports are container ports on the shared Docker network.'}{' '}
                    Discovery does not test application health.
                  </small>
                </label>
              )}
              <Picker
                label="Choose service"
                value={existing}
                onChange={setExisting}
                items={[
                  { value: 'new', label: 'Add a new service' },
                  ...services.map((n) => ({
                    value: n.id,
                    label: `${n.data.label} — ${n.data.host}:${n.data.port} (${graph.edges.filter((edge) => edge.target === n.id).length} routes)`,
                  })),
                ]}
              />
              {services.length > 0 && (
                <small className="shared-service-hint">
                  Choose an existing service to reuse its single block across
                  every tenant route.
                </small>
              )}
              {existing === 'new' && (
                <>
                  <div className="two-fields">
                    <label className="field">
                      Hostname or IP
                      <input
                        required
                        placeholder="my-app"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                      />
                    </label>
                    <label className="field port-field">
                      Port
                      <input
                        type="number"
                        required
                        min="1"
                        max="65535"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                      />
                    </label>
                  </div>
                  <Picker
                    label="Upstream protocol"
                    value={protocol}
                    onChange={setProtocol}
                    items={[
                      { value: 'http', label: 'HTTP' },
                      { value: 'https', label: 'HTTPS (verify certificate)' },
                    ]}
                  />
                  <label className="field">
                    Service name <span className="optional">optional</span>
                    <input
                      placeholder="My application"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </div>
          <div className="dialog-actions">
            <span>
              {existingDomain === 'new' &&
              domain.split(/[\n,]+/).filter((value) => value.trim()).length > 1
                ? 'Routes share one service block. Deploy when ready.'
                : 'Added as a draft. Deploy when ready.'}
            </span>
            <button type="submit" className="btn primary">
              <Plus size={16} />
              Add route
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export default function Workspace(props: { onLogout: () => Promise<void> }) {
  return (
    <ReactFlowProvider>
      <WorkspaceInner {...props} />
    </ReactFlowProvider>
  );
}

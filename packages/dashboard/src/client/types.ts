export interface ApiCapabilities {
  wireTrace: boolean;
  keyRotation: boolean;
  keyRevoke: boolean;
  keyExport: boolean;
  discovery: boolean;
}

export interface ApiStatus {
  agentFingerprint: string;
  agentDisplayName?: string;
  peersOnline: number;
  peersTotal: number;
  stateCount: number;
  uptime: number;
  online?: boolean;
  syncPct?: number;
  latencyMsP50?: number;
  latencyMsP95?: number;
  capabilities?: ApiCapabilities;
}

export interface ApiIdentity {
  fingerprint: string;
  displayName?: string;
}

export interface ApiPeer {
  fingerprint: string;
  displayName?: string;
  online: boolean;
  lastSeen: number;
  trusted: boolean;
}

export interface ApiState {
  id: string;
  name: string;
  memberCount: number;
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
}

export interface ApiDiscoveredState extends ApiState {
  discoveredAt?: number;
}

export interface ApiStateMember {
  fingerprint: string;
  displayName?: string;
  role: string;
}

export interface ApiStateMessage {
  id: string;
  senderFingerprint?: string;
  senderName?: string;
  content: string;
  timestamp: number;
}

export interface ApiStateDetail {
  id: string;
  name: string;
  memberCount: number;
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
  members: ApiStateMember[];
  messages: ApiStateMessage[];
}

export type ApiJoinResponse =
  | { ok: true; state: ApiState }
  | {
      ok: false;
      reason: 'unreachable' | 'incompatible' | 'invitation-required' | 'rejected' | 'unknown' | 'invalid';
      message: string;
    };

export interface ApiActivity {
  type: 'message' | 'peer' | 'state' | 'key' | string;
  timestamp: number;
  actor?: string;
  actorName?: string;
  target?: string;
}

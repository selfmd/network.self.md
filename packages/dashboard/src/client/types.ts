export interface ApiStatus {
  agentFingerprint: string;
  agentDisplayName?: string;
  peersOnline: number;
  peersTotal: number;
  stateCount: number;
  uptime: number;
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
  role: 'admin' | 'member';
  lastActivity: number;
  selfMd?: string;
  isPublic: boolean;
}

export interface ApiActivity {
  timestamp: number;
  type: 'message' | 'peer_connected' | 'peer_disconnected' | 'group_joined' | 'heartbeat';
  actor?: string;
  actorName?: string;
  target?: string;
}

export interface ApiDiscoveredState {
  id: string;
  name: string;
  selfMd: string | null;
  memberCount: number;
  lastAnnounced: number;
}
